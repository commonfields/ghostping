use anyhow::{bail, Result};
use clap::{Parser, Subcommand, ValueEnum};
use colored::Colorize;
use std::path::{Path, PathBuf};

use ghostping::{
    agent::optimizer::{self, OptimizeOptions},
    audit_engine::{build_providers_for_project, AuditEngine, AuditOptions, PromptInput},
    audit_storage::{AuditStorage, NewGeneratedAsset, NewPrompt},
    cache::Cache,
    config::{Config, EXAMPLE_CONFIG},
    content_generator::ContentGenerator,
    geo::{
        evaluator,
        generator::{self, GenerateOptions},
        prompts::{self, extract_domain_hint},
    },
    marketplace::builtin,
    plugins,
    project_config::ProjectConfig,
    prompt_discovery::PromptDiscovery,
    report,
    report_generator::generate_report_filename,
    scheduler,
    storage::Storage,
    tracker::{self, TrackOptions},
    tui,
};

const BANNER: &str = r#"
   ██████╗ ██╗  ██╗ ██████╗ ███████╗████████╗██████╗ ██╗███╗   ██╗ ██████╗
  ██╔════╝ ██║  ██║██╔═══██╗██╔════╝╚══██╔══╝██╔══██╗██║████╗  ██║██╔════╝
  ██║  ███╗███████║██║   ██║███████╗   ██║   ██████╔╝██║██╔██╗ ██║██║  ███╗
  ██║   ██║██╔══██║██║   ██║╚════██║   ██║   ██╔═══╝ ██║██║╚██╗██║██║   ██║
  ╚██████╔╝██║  ██║╚██████╔╝███████║   ██║   ██║     ██║██║ ╚████║╚██████╔╝
   ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝   ╚═╝     ╚═╝╚═╝  ╚═══╝ ╚═════╝
"#;

const TAGLINE: &str = "The private, local-first GEO companion for indie builders — track, generate, and optimize your visibility in AI answers.";

#[derive(Parser)]
#[command(
    name = "ghostping",
    about = "The private, local-first GEO companion for indie builders",
    long_about = "Ghostping — The private, local-first GEO companion for indie builders.

Track, generate, and optimize your visibility in AI answers (ChatGPT, Claude, Perplexity, Grok, Ollama).

Quick start:
  ghostping init                            # create project
  ghostping prompts discover                # build prompt set
  ghostping audit run --models mock         # free end-to-end test
  ghostping optimize myproject.com --niche \"your niche\"  # auto-optimize
  ghostping quickstart                      # guided beginner flow

Key commands:
  audit    — Evidence audit (prompts × samples × providers)
  optimize — Autonomous 5-step GEO agent
  generate — Create content for audit gaps
  report   — Evidence report for an audit run",
    version,
    arg_required_else_help = true
)]
struct Cli {
    /// Comma-separated models to query (e.g. openai,anthropic,ollama)
    #[arg(long, short, global = true)]
    models: Option<String>,

    /// Show first line of each raw LLM response
    #[arg(long, short, global = true, default_value = "false")]
    verbose: bool,

    /// Suppress progress output — print only the final result (for CI/scripts)
    #[arg(long, short, global = true, default_value = "false")]
    quiet: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Clone, ValueEnum)]
enum ExportFormat {
    Csv,
    Markdown,
}

#[derive(Subcommand)]
enum Commands {
    /// Run prompts against configured models and record brand mentions
    ///
    /// Examples:
    ///   ghostping track myproject.com
    ///   ghostping track myproject.com --prompts prompts.txt --models openai,ollama
    ///   ghostping track myproject.com --judge
    Track {
        /// Domain or brand to track (e.g. myproject.com)
        domain: String,
        /// Path to prompts file (.txt one-per-line or .json array)
        #[arg(long, short)]
        prompts: Option<PathBuf>,
        /// Re-evaluate each response with a local LLM for higher-accuracy parsing
        #[arg(long)]
        judge: bool,
    },
    /// Run evidence-based visibility audits
    ///
    /// Execute multi-sample audits across configured models and store
    /// comprehensive results including raw responses, citations, and metrics.
    ///
    /// Examples:
    ///   ghostping audit run                        # Run audit with stored prompts
    ///   ghostping audit run --models mock          # Test with mock provider
    ///   ghostping audit run --samples 5            # More samples per prompt
    ///   ghostping audit list                       # List previous audits
    ///   ghostping audit show 42                    # Show audit details
    ///   ghostping audit compare --before 1 --after 2  # Compare two runs
    #[command(subcommand)]
    Audit(AuditCommand),
    /// Quick audit using 12 smart default prompts — legacy mode
    ///
    /// This is the legacy audit command. For evidence-based audits,
    /// use: ghostping audit run
    ///
    /// Examples:
    ///   ghostping audit-legacy myproject.com
    ///   ghostping audit-legacy myproject.com --niche "CLI tool"
    #[command(name = "audit-legacy")]
    AuditLegacy {
        /// Domain or brand to audit
        domain: String,
        /// Product niche for smarter prompt generation
        #[arg(long)]
        niche: Option<String>,
        /// Main competitor for comparison prompts
        #[arg(long)]
        competitor: Option<String>,
        /// Re-evaluate each response with a local LLM
        #[arg(long)]
        judge: bool,
    },
    /// Show mention history and trends from the local database (legacy)
    ///
    /// For the new evidence-based reports, use: ghostping report
    ///
    /// Examples:
    ///   ghostping report-legacy myproject.com
    ///   ghostping report-legacy myproject.com --days 30
    #[command(name = "report-legacy")]
    ReportLegacy {
        /// Domain or brand
        domain: String,
        /// Number of past days to include
        #[arg(long, short, default_value = "7")]
        days: u32,
        /// Export as structured format instead of terminal table
        #[arg(long, value_enum)]
        export: Option<ExportFormat>,
    },
    /// Autonomous GEO agent: discover prompts, audit visibility, generate content, show lift
    ///
    /// Examples:
    ///   ghostping optimize igrisinertial.com --niche "deterministic edge runtime"
    ///   ghostping optimize myproject.com --niche "rust cli tool" --competitors "ripgrep,fd" --steps 5
    ///   ghostping optimize myproject.com --niche "..." --dry-run
    ///   ghostping optimize myproject.com --niche "..." --auto-apply
    ///   ghostping optimize myproject.com --niche "Rust CLI" --plugin rust-crate
    ///   ghostping optimize myproject.com --niche "..." --max-rounds 3
    Optimize {
        /// Domain or brand to optimize (e.g. myproject.com)
        domain: String,
        /// Main niche or product category (required for relevant content)
        #[arg(long, short)]
        niche: String,
        /// Comma-separated list of competitors to benchmark against
        #[arg(long, short)]
        competitors: Option<String>,
        /// Number of weak prompts to generate content for (default: 3)
        #[arg(long, short, default_value = "3")]
        steps: usize,
        /// Max refinement rounds per section when citability is low (default: 3)
        #[arg(long, default_value = "3")]
        max_rounds: usize,
        /// Show full plan and generated content without writing any files
        #[arg(long)]
        dry_run: bool,
        /// Automatically write generated sections to ./geo/ folder
        #[arg(long)]
        auto_apply: bool,
        /// Apply a named plugin template (installed or builtin)
        #[arg(long)]
        plugin: Option<String>,
    },
    /// Generate GEO-optimized markdown content for a target query (legacy)
    ///
    /// For content generation from audit gaps, use: ghostping generate
    ///
    /// Examples:
    ///   ghostping generate-legacy "best tool" --about "..."
    #[command(name = "generate-legacy")]
    GenerateLegacy {
        /// Target query or topic to generate content for
        prompt: String,
        /// Short description of your project
        #[arg(long, short)]
        about: Option<String>,
        /// Optional niche/context for more targeted content
        #[arg(long, short)]
        niche: Option<String>,
        /// Save generated content to a file
        #[arg(long, short)]
        output: Option<PathBuf>,
        /// Evaluate visibility lift
        #[arg(long, short)]
        evaluate: bool,
        /// Apply a named plugin template
        #[arg(long)]
        plugin: Option<String>,
    },
    /// Manage saved projects (domain + niche pairs for quick re-auditing)
    ///
    /// Examples:
    ///   ghostping projects
    ///   ghostping projects add myproject.com --niche "Rust CLI tool"
    ///   ghostping projects remove myproject.com
    Projects {
        #[command(subcommand)]
        action: Option<ProjectAction>,
    },
    /// Watch a domain and re-audit it on a fixed interval
    ///
    /// Examples:
    ///   ghostping watch myproject.com --niche "Rust CLI tool"
    ///   ghostping watch myproject.com --interval 30 --models ollama
    Watch {
        /// Domain or brand to watch
        domain: String,
        /// Product niche for smarter prompts
        #[arg(long)]
        niche: Option<String>,
        /// Interval in minutes between audits (default: 60)
        #[arg(long, short, default_value = "60")]
        interval: u64,
    },
    /// Manage installed prompt plugins
    ///
    /// Examples:
    ///   ghostping plugins
    ///   ghostping plugins enable rust-crate
    ///   ghostping plugins disable rust-crate
    Plugins {
        #[command(subcommand)]
        action: Option<PluginAction>,
    },
    /// Manage prompts and templates
    ///
    /// Discover project-specific prompts or browse community templates.
    ///
    /// Examples:
    ///   ghostping prompts discover              # Generate prompts from project config
    ///   ghostping prompts list                  # List stored prompts
    ///   ghostping prompts templates list        # Browse community templates
    ///   ghostping prompts templates search rust
    ///   ghostping prompts templates install rust-crate
    #[command(subcommand)]
    Prompts(PromptsCommand),
    /// Export a shareable visibility report
    ///
    /// Examples:
    ///   ghostping share myproject.com
    ///   ghostping share myproject.com --days 30 > report.md
    ///   ghostping share myproject.com --format json > report.json
    Share {
        /// Domain to export
        domain: String,
        /// Number of days of history to include
        #[arg(long, short, default_value = "7")]
        days: u32,
        /// Output format
        #[arg(long, short, value_enum, default_value = "markdown")]
        format: ShareFormat,
    },
    /// Show personal usage stats and trends
    ///
    /// Examples:
    ///   ghostping stats myproject.com
    ///   ghostping stats myproject.com --days 30
    Stats {
        /// Domain to show stats for (omit to list all tracked domains)
        domain: Option<String>,
        /// Number of days of history
        #[arg(long, short, default_value = "30")]
        days: u32,
    },
    /// Interactive goal-oriented GEO assistant in your terminal
    ///
    /// Examples:
    ///   ghostping chat
    ///   ghostping chat --models ollama
    Chat,
    /// Print command documentation as markdown
    Docs,
    /// Create config file and show setup instructions
    Config,
    /// Check your setup: config, providers, Ollama connectivity
    Doctor,
    /// Guided beginner flow — prints the recommended steps to get started
    Quickstart,
    /// Initialize a new Ghostping project
    ///
    /// Creates ghostping.toml in the current directory for project-specific
    /// configuration including prompts, competitors, and audit settings.
    ///
    /// Examples:
    ///   ghostping init
    ///   ghostping init --name "MyProject" --website "https://example.com" --yes
    Init {
        /// Project name
        #[arg(short, long)]
        name: Option<String>,
        /// Project website
        #[arg(short, long)]
        website: Option<String>,
        /// Project category/niche
        #[arg(short, long)]
        category: Option<String>,
        /// Skip interactive prompts
        #[arg(long)]
        yes: bool,
        /// Overwrite existing config
        #[arg(long)]
        force: bool,
    },
    /// Set up automatic background auditing (launchd on macOS, prints cron line on Linux)
    ///
    /// Examples:
    ///   ghostping schedule myproject.com
    ///   ghostping schedule myproject.com --niche "Rust CLI tool" --interval weekly
    ///   ghostping schedule myproject.com --interval daily
    ///   ghostping schedule myproject.com --uninstall
    Schedule {
        /// Domain label for the scheduled job (used for the job name and log file)
        domain: String,
        /// How often to audit: daily, weekly, or a number of hours (e.g. 6).
        /// Custom hours must be 1-24 for cron-based systems.
        #[arg(long, default_value = "daily")]
        interval: String,
        /// Remove the scheduled job instead of installing it
        #[arg(long)]
        uninstall: bool,
    },
    /// Stamp a publish checkpoint — records your current mention rate as a before/after baseline
    ///
    /// Run this right after publishing GEO content. Then re-audit in a few days and run
    /// `ghostping results <domain>` to see whether your rate improved.
    ///
    /// Examples:
    ///   ghostping publish myproject.com
    ///   ghostping publish myproject.com --note "published geo/ section on blog"
    Publish {
        /// Domain to stamp
        domain: String,
        /// Optional label describing what you published
        #[arg(long, short)]
        note: Option<String>,
    },
    /// Show before/after visibility delta since your last publish checkpoint
    ///
    /// Examples:
    ///   ghostping results myproject.com
    ///   ghostping results myproject.com --all
    Results {
        /// Domain to inspect
        domain: String,
        /// Show all past checkpoints, not just the most recent
        #[arg(long)]
        all: bool,
    },

    /// Generate evidence-based markdown report from audit results
    ///
    /// Creates a comprehensive report with metrics, citations, competitor analysis,
    /// and content gaps from your audit runs.
    ///
    /// Examples:
    ///   ghostping report                           # Report from latest audit
    ///   ghostping report --run 42                  # Report from specific audit
    ///   ghostping report --output ./reports/       # Custom output directory
    ///   ghostping report --full                    # Include full raw responses
    Report {
        /// Audit run ID (latest if not specified)
        #[arg(short, long)]
        run: Option<i64>,
        /// Output format
        #[arg(short, long, default_value = "markdown")]
        format: String,
        /// Output directory
        #[arg(short, long, default_value = "reports")]
        output: PathBuf,
        /// Include full raw responses
        #[arg(long)]
        full: bool,
        /// Force overwrite existing report
        #[arg(long)]
        force: bool,
    },
    /// Generate content assets from audit gaps
    ///
    /// Analyzes your audit results to identify visibility gaps and generates
    /// markdown content assets to fill those gaps.
    ///
    /// Examples:
    ///   ghostping generate                          # Generate from latest audit
    ///   ghostping generate --from-audit 42          # Generate from specific run
    ///   ghostping generate --output ./content/      # Custom output directory
    Generate {
        /// Source audit run ID or "latest"
        #[arg(short, long, default_value = "latest")]
        from_audit: String,
        /// Output directory
        #[arg(short, long, default_value = "generated")]
        output: PathBuf,
        /// Force overwrite existing files
        #[arg(long)]
        force: bool,
    },
    /// Diagnose URL crawlability and AI readiness
    ///
    /// Checks basic crawlability signals that help AI models discover
    /// and understand your content.
    ///
    /// Examples:
    ///   ghostping diagnose https://example.com
    Diagnose {
        /// URL to diagnose
        url: String,
    },
    /// Observation Kernel: first-party imports and evidence views
    ///
    /// Import authorized Google Search Console CSV exports as immutable
    /// first-party observations, and report them separately from sampled
    /// API mentions/citations.
    ///
    /// Examples:
    ///   ghostping observations import-gsc --file Queries.csv --date 2026-09-01
    ///   ghostping observations report
    #[command(subcommand)]
    Observations(ObservationsCommand),
}

#[derive(clap::Subcommand)]
enum ObservationsCommand {
    /// Import an authorized Google Search Console CSV export as immutable
    /// first-party observations. Idempotent per (file, period); conflicts
    /// are surfaced, never silently overwritten.
    ///
    /// The report MUST be declared explicitly: ordinary exports are
    /// `generic-search` and never enter AI metrics. AI identities require
    /// an AI-report-shaped export and stay UNVERIFIED until validated
    /// against a genuine authorized sample.
    ///
    /// Examples:
    ///   ghostping observations import-gsc --file Queries.csv --report generic-search --date 2026-09-01
    ///   ghostping observations import-gsc --file AiPages.csv --report generative-ai-search --start-date 2026-09-01 --end-date 2026-09-07
    ImportGsc {
        /// Path to the authorized CSV export file
        #[arg(long)]
        file: PathBuf,
        /// Declared report identity: generic-search, generative-ai-search,
        /// generative-ai-discover
        #[arg(long)]
        report: String,
        /// Single day the export covers (YYYY-MM-DD); exclusive with
        /// --start-date/--end-date
        #[arg(long)]
        date: Option<String>,
        /// Period start (YYYY-MM-DD); requires --end-date
        #[arg(long)]
        start_date: Option<String>,
        /// Period end (YYYY-MM-DD); requires --start-date
        #[arg(long)]
        end_date: Option<String>,
    },
    /// Import one recorded Gemini grounded-search response (JSON) as
    /// immutable grounded/parametric/unknown observations for offline
    /// replay and testing. No API calls.
    ///
    /// Examples:
    ///   ghostping observations import-grounded --file response.json --prompt "best rust cli" --group smoke
    ImportGrounded {
        /// Path to a recorded generateContent response JSON file
        #[arg(long)]
        file: PathBuf,
        /// Prompt that produced the recorded response
        #[arg(long)]
        prompt: String,
        /// Prompt group label for the observation
        #[arg(long, default_value = "recorded")]
        group: String,
    },
    /// Report conventional Search, generative-AI Search/Discover, sampled
    /// API evidence, and retrieval splits with separate denominators.
    /// Unknown stays unknown; no visibility score.
    ///
    /// Examples:
    ///   ghostping observations report
    Report,
}

#[derive(clap::Subcommand)]
enum ProjectAction {
    /// Add or update a saved project
    Add {
        /// Domain or brand (e.g. myproject.com)
        domain: String,
        /// Product niche
        #[arg(long)]
        niche: Option<String>,
        /// Optional notes
        #[arg(long)]
        notes: Option<String>,
    },
    /// Remove a saved project
    #[command(alias = "rm")]
    Remove {
        /// Domain to remove
        domain: String,
    },
}

#[derive(clap::Subcommand)]
enum PluginAction {
    /// List installed plugins
    List,
    /// Mark a plugin as enabled (adds to config)
    Enable {
        /// Plugin name
        name: String,
    },
    /// Mark a plugin as disabled (removes from config)
    Disable {
        /// Plugin name
        name: String,
    },
}

#[derive(clap::Subcommand)]
enum PromptsCommand {
    /// Discover prompts based on project configuration
    ///
    /// Generates prompts from your project category, audience, and competitors.
    ///
    /// Examples:
    ///   ghostping prompts discover
    ///   ghostping prompts discover --limit 20
    Discover {
        /// Limit number of prompts to generate
        #[arg(short, long)]
        limit: Option<usize>,
    },
    /// List stored prompts
    ///
    /// Shows all prompts discovered for your project with metadata.
    ///
    /// Examples:
    ///   ghostping prompts list
    List,
    /// Browse and install community prompt templates
    ///
    /// Access community-contributed prompt templates.
    ///
    /// Examples:
    ///   ghostping prompts templates list
    ///   ghostping prompts templates search rust
    ///   ghostping prompts templates install rust-crate
    #[command(subcommand)]
    Templates(PromptTemplatesCommand),
}

#[derive(clap::Subcommand)]
enum PromptTemplatesCommand {
    /// List all available community templates
    List,
    /// Search templates by keyword, tag, or name
    Search {
        /// Search query
        query: String,
    },
    /// Install a builtin template as a local plugin you can customize
    Install {
        /// Template name (e.g. rust-crate)
        name: String,
    },
}

#[derive(clap::Subcommand)]
enum AuditCommand {
    /// Run a new audit with the evidence engine
    ///
    /// Execute multi-sample audits across configured models.
    ///
    /// Examples:
    ///   ghostping audit run
    ///   ghostping audit run --models mock --samples 3
    ///   ghostping audit run --temperature 0.5
    Run {
        /// Number of samples per prompt
        #[arg(short, long)]
        samples: Option<usize>,
        /// Temperature for LLM queries
        #[arg(short, long)]
        temperature: Option<f32>,
        /// Specific provider/models to use
        #[arg(short, long)]
        models: Option<String>,
        /// JSON output
        #[arg(long)]
        json: bool,
        /// Acknowledge cloud-provider data transfer notice for scripts
        #[arg(long)]
        yes: bool,
    },
    /// List previous audit runs
    ///
    /// Examples:
    ///   ghostping audit list
    ///   ghostping audit list --limit 10
    List {
        /// Limit results
        #[arg(short, long, default_value = "20")]
        limit: usize,
    },
    /// Show details of a specific audit run
    ///
    /// Examples:
    ///   ghostping audit show 42
    Show {
        /// Audit run ID
        id: i64,
    },
    /// Compare two audit runs
    ///
    /// Shows before/after metrics and visibility changes.
    ///
    /// Examples:
    ///   ghostping audit compare --before 10 --after 20
    Compare {
        /// Before audit run ID
        #[arg(long)]
        before: i64,
        /// After audit run ID
        #[arg(long)]
        after: i64,
        /// Output format
        #[arg(short, long, default_value = "markdown")]
        format: String,
    },
}

#[derive(Clone, clap::ValueEnum)]
enum ShareFormat {
    Markdown,
    Json,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let config = Config::load()?;
    let (base_dir, is_first_run) = Config::ensure_dir()?;

    if is_first_run {
        print_welcome();
        // Bootstrap config on very first run
        let path = ghostping::config::config_path();
        if !path.exists() {
            std::fs::write(&path, EXAMPLE_CONFIG)?;
            println!(
                "  {} Config created at {} — edit it with your API keys,",
                "✅".green(),
                path.display().to_string().cyan()
            );
            println!(
                "     or set {} to use Ollama for free.\n",
                "enabled = true".cyan()
            );
        }
    }

    let storage = Storage::open(&base_dir)?;
    let cache = Cache::new(&base_dir)?;

    match cli.command {
        Commands::Track {
            domain,
            prompts,
            judge,
        } => {
            let providers = tracker::build_providers_filtered(&config, cli.models.as_deref());
            if providers.is_empty() {
                no_providers_error();
            }
            let prompts = load_prompts(prompts, &domain)?;
            if prompts.is_empty() {
                bail!("Prompts file is empty. Add at least one prompt (one per line).");
            }
            let judge_provider = build_judge_provider(judge, &config);

            println!(
                "\n  {} {} — {} prompt(s) × {} model(s){}\n",
                "Tracking".bold(),
                domain.cyan().bold(),
                prompts.len(),
                providers.len(),
                if judge {
                    "  [+judge]".dimmed().to_string()
                } else {
                    String::new()
                }
            );

            let prev_rate = fetch_prev_rate(&storage, &domain);
            let summary = tracker::run_track(
                &domain,
                prompts,
                providers,
                &storage,
                &cache,
                TrackOptions {
                    verbose: cli.verbose,
                    concurrency: config.defaults.concurrency,
                    judge: judge_provider,
                    quiet: cli.quiet,
                },
            )
            .await?;
            report::print_summary(&summary, prev_rate);
        }

        Commands::AuditLegacy {
            domain,
            niche,
            competitor,
            judge,
        } => {
            let providers = tracker::build_providers_filtered(&config, cli.models.as_deref());
            if providers.is_empty() {
                no_providers_error();
            }
            let prompts = audit_prompts(&domain, niche.as_deref(), competitor.as_deref());
            let judge_provider = build_judge_provider(judge, &config);

            println!(
                "\n  {} {} — {} prompts × {} model(s){}\n",
                "Auditing".bold(),
                domain.cyan().bold(),
                prompts.len(),
                providers.len(),
                if judge {
                    "  [+judge]".dimmed().to_string()
                } else {
                    String::new()
                }
            );

            let prev_rate = fetch_prev_rate(&storage, &domain);
            let summary = tracker::run_track(
                &domain,
                prompts,
                providers,
                &storage,
                &cache,
                TrackOptions {
                    verbose: cli.verbose,
                    concurrency: config.defaults.concurrency,
                    judge: judge_provider,
                    quiet: cli.quiet,
                },
            )
            .await?;
            report::print_summary(&summary, prev_rate);
        }

        Commands::ReportLegacy {
            domain,
            days,
            export,
        } => {
            let results = storage.query_domain(&domain, days)?;
            match export {
                Some(ExportFormat::Csv) => print!("{}", report::export_csv(&results)),
                Some(ExportFormat::Markdown) => {
                    print!("{}", report::export_markdown(&results, &domain))
                }
                None => report::print_trend_report(&domain, &results, days),
            }
        }

        Commands::Optimize {
            domain,
            niche,
            competitors,
            steps,
            max_rounds,
            dry_run,
            auto_apply,
            plugin,
        } => {
            let providers = tracker::build_providers_filtered(&config, cli.models.as_deref());
            if providers.is_empty() {
                no_providers_error();
            }

            let competitors_list: Vec<String> = competitors
                .as_deref()
                .unwrap_or("")
                .split(',')
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
                .collect();

            let generate_template_override =
                resolve_generate_template(plugin.as_deref(), &base_dir);
            let discover_template_override =
                resolve_discover_template(plugin.as_deref(), &base_dir);

            println!(
                "\n  {}  {}\n  {}  {}\n  {}  {} steps{}{}\n",
                "Optimizing".bold(),
                domain.cyan().bold(),
                "Niche:".dimmed(),
                niche.cyan(),
                "Mode:".dimmed(),
                steps,
                if dry_run {
                    "  [dry-run]".yellow().to_string()
                } else {
                    String::new()
                },
                plugin
                    .as_deref()
                    .map(|p| format!("  [plugin: {}]", p).yellow().to_string())
                    .unwrap_or_default()
            );

            let opts = OptimizeOptions {
                domain: domain.clone(),
                niche,
                competitors: competitors_list,
                steps,
                max_rounds,
                dry_run,
                verbose: cli.verbose,
                quiet: cli.quiet,
                generate_template_override,
                discover_template_override,
            };

            let plan = optimizer::optimize(&opts, &providers, &storage, &cache).await?;

            report::print_optimization_plan(&plan, dry_run);

            if !dry_run && auto_apply && !plan.sections.is_empty() {
                std::fs::create_dir_all("geo")?;
                let mut written = 0usize;
                for section in &plan.sections {
                    let path = std::path::Path::new(&section.file_name);
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(path, &section.content)?;
                    println!("  {}  {}", "✓".green(), section.file_name.cyan());
                    written += 1;
                }
                println!(
                    "\n  {} {} file(s) written to {}",
                    "✓".green().bold(),
                    written,
                    "./geo/".cyan()
                );
                println!(
                    "\n  {}  git add geo/ && git commit -m \"docs: add GEO-optimized content\"\n",
                    "→".cyan()
                );
            } else if !dry_run && !auto_apply && !plan.sections.is_empty() {
                println!(
                    "  {}  Run with {} to write {} file(s) to {}\n",
                    "Tip".yellow().bold(),
                    "--auto-apply".cyan(),
                    plan.sections.len(),
                    "./geo/".cyan()
                );
            }
        }

        Commands::GenerateLegacy {
            prompt,
            about,
            niche,
            output,
            evaluate,
            plugin,
        } => {
            let providers = tracker::build_providers_filtered(&config, cli.models.as_deref());
            if providers.is_empty() {
                no_providers_error();
            }

            let about_str = about.as_deref().unwrap_or("").to_string();
            let niche_str = niche.as_deref().unwrap_or("general").to_string();
            let system_prompt_override = resolve_generate_template(plugin.as_deref(), &base_dir);

            println!(
                "\n  {} {}\n  {} {}{}\n",
                "Generating content for:".bold(),
                format!("\"{}\"", prompt).cyan(),
                "Using models:".dimmed(),
                providers
                    .iter()
                    .map(|p| p.name())
                    .collect::<Vec<_>>()
                    .join(", ")
                    .cyan(),
                plugin
                    .as_deref()
                    .map(|p| format!("  [plugin: {}]", p))
                    .unwrap_or_default()
            );

            let opts = GenerateOptions {
                prompt: prompt.clone(),
                about: about_str.clone(),
                niche: niche_str,
                verbose: cli.verbose,
                system_prompt_override,
            };

            let results = generator::generate(&opts, &providers).await?;

            if results.is_empty() {
                bail!("No providers returned a response. Check your config or try --models.");
            }

            match &output {
                Some(path) => {
                    let primary = &results[0];
                    std::fs::write(path, &primary.content)?;
                    println!(
                        "  {} Saved to {}\n",
                        "✓".green().bold(),
                        path.display().to_string().cyan()
                    );
                    println!(
                        "  {}  git add {} && git commit -m \"docs: add GEO content for '{}'\"",
                        "Tip".yellow().bold(),
                        path.display(),
                        prompt
                    );
                    println!();
                }
                None => {
                    report::print_generate_results(&results, &prompt);
                }
            }

            if evaluate {
                println!("  {} Running before/after evaluation…\n", "→".cyan());

                let domain_hint = extract_domain_hint(&about_str);
                let before_stored = domain_hint.as_deref().and_then(|d| {
                    storage.query_domain(d, 7).ok().and_then(|results| {
                        if results.is_empty() {
                            None
                        } else {
                            let mentioned = results.iter().filter(|r| r.mentioned).count();
                            Some(mentioned as f64 / results.len() as f64 * 100.0)
                        }
                    })
                });

                let primary_content = &results[0].content;
                let delta =
                    evaluator::evaluate_content(&prompt, primary_content, &providers).await?;
                report::print_eval_delta(&delta, before_stored);
            }
        }

        Commands::Projects { action } => {
            match action {
                None => {
                    // list
                    run_projects_list(&storage)?;
                }
                Some(ProjectAction::Add {
                    domain,
                    niche,
                    notes,
                }) => {
                    storage.upsert_project(&domain, niche.as_deref(), notes.as_deref())?;
                    println!(
                        "\n  {}  {} saved to projects\n",
                        "✓".green().bold(),
                        domain.cyan()
                    );
                }
                Some(ProjectAction::Remove { domain }) => {
                    if storage.remove_project(&domain)? {
                        println!("\n  {}  {} removed\n", "✓".green().bold(), domain.cyan());
                    } else {
                        println!(
                            "\n  {}  {} not found in projects\n",
                            "!".yellow(),
                            domain.cyan()
                        );
                    }
                }
            }
        }

        Commands::Watch {
            domain,
            niche,
            interval,
        } => {
            let providers = tracker::build_providers_filtered(&config, cli.models.as_deref());
            if providers.is_empty() {
                no_providers_error();
            }
            let audit_prompts = prompts::default_prompts(&domain, niche.as_deref(), None);

            if !cli.quiet {
                println!(
                    "\n  {}  {}  every {} min  — Ctrl+C to stop\n",
                    "Watching".bold(),
                    domain.cyan().bold(),
                    interval
                );
            }

            let mut prev_rate: Option<f64> = fetch_prev_rate(&storage, &domain);
            let dur = std::time::Duration::from_secs(interval * 60);
            loop {
                let track_opts = TrackOptions {
                    verbose: false,
                    concurrency: config.defaults.concurrency,
                    judge: None,
                    quiet: true, // always quiet internally; we print our own summary
                };
                match tracker::run_track(
                    &domain,
                    audit_prompts.clone(),
                    providers.clone(),
                    &storage,
                    &cache,
                    track_opts,
                )
                .await
                {
                    Ok(summary) => {
                        let rate = summary.mention_rate();
                        let ts = chrono::Utc::now().format("%Y-%m-%d %H:%M UTC");
                        let trend = match prev_rate {
                            Some(p) if rate - p > 2.0 => {
                                format!(" ↑{:.0}pp", rate - p).green().to_string()
                            }
                            Some(p) if p - rate > 2.0 => {
                                format!(" ↓{:.0}pp", p - rate).red().to_string()
                            }
                            Some(_) => " →".dimmed().to_string(),
                            None => String::new(),
                        };
                        let rate_str = format!("{:.0}%", rate);
                        let rate_colored = if rate >= 60.0 {
                            rate_str.green().bold()
                        } else if rate >= 30.0 {
                            rate_str.yellow().bold()
                        } else {
                            rate_str.red().bold()
                        };
                        println!(
                            "  {}  {}  {}{}  ({}/{})",
                            ts.to_string().dimmed(),
                            domain.cyan(),
                            rate_colored,
                            trend,
                            summary.mention_count,
                            summary.total_queries
                        );
                        // Notify on significant drops
                        if let Some(p) = prev_rate {
                            if p - rate > 5.0 {
                                scheduler::notify(
                                    "Ghostping — Visibility Drop",
                                    &format!(
                                        "{}: mention rate dropped {:.0}pp to {:.0}%",
                                        domain,
                                        p - rate,
                                        rate
                                    ),
                                );
                            }
                        }
                        let _ = storage.touch_project_last_audited(&domain);
                        prev_rate = Some(rate);
                    }
                    Err(e) => eprintln!("  {} {}", "Error:".red().bold(), e),
                }
                tokio::time::sleep(dur).await;
            }
        }

        Commands::Plugins { action } => {
            let installed = plugins::discover_plugins(&base_dir);
            match action {
                None | Some(PluginAction::List) => {
                    println!();
                    println!(
                        "  {}  {} installed",
                        "Plugins".bold(),
                        installed.len().to_string().cyan()
                    );
                    println!("{}", "─".repeat(64).dimmed());
                    if installed.is_empty() {
                        println!(
                            "\n  No plugins installed. Try:\n  {}\n",
                            "ghostping prompts templates install rust-crate".cyan()
                        );
                    } else {
                        use comfy_table::{Attribute, Cell, Color, ContentArrangement, Table};
                        let mut table = Table::new();
                        table.set_content_arrangement(ContentArrangement::Dynamic);
                        table.set_header(vec![
                            Cell::new("Name").add_attribute(Attribute::Bold),
                            Cell::new("Version").add_attribute(Attribute::Bold),
                            Cell::new("Description").add_attribute(Attribute::Bold),
                            Cell::new("Author").add_attribute(Attribute::Bold),
                        ]);
                        for p in &installed {
                            table.add_row(vec![
                                Cell::new(&p.manifest.meta.name).fg(Color::Cyan),
                                Cell::new(&p.manifest.meta.version).fg(Color::DarkGrey),
                                Cell::new(&p.manifest.meta.description),
                                Cell::new(&p.manifest.meta.author).fg(Color::DarkGrey),
                            ]);
                        }
                        println!();
                        println!("{table}");
                    }
                    println!(
                        "\n  {}  Use {} to apply a plugin\n",
                        "Tip".yellow().bold(),
                        "--plugin <name>".cyan()
                    );
                }
                Some(PluginAction::Enable { name }) => {
                    if plugins::find_plugin(&base_dir, &name).is_some() {
                        println!(
                            "\n  {}  Plugin {} is installed and ready.\n  Use {} to apply it.\n",
                            "✓".green().bold(),
                            name.cyan(),
                            format!("--plugin {}", name).cyan()
                        );
                    } else {
                        println!(
                            "\n  {}  Plugin {} is not installed. Run:\n  {}\n",
                            "!".yellow(),
                            name.cyan(),
                            format!("ghostping prompts templates install {}", name).cyan()
                        );
                    }
                }
                Some(PluginAction::Disable { name }) => {
                    println!("\n  {}  Plugin {} will not be auto-applied (pass --plugin to use it explicitly).\n",
                        "✓".green().bold(), name.cyan());
                }
            }
        }

        Commands::Share {
            domain,
            days,
            format,
        } => {
            let results = storage.query_domain(&domain, days)?;
            if results.is_empty() {
                println!(
                    "\n  {}  No data for {}. Run {} first.\n",
                    "!".yellow(),
                    domain.cyan(),
                    format!("ghostping audit-legacy {}", domain).cyan()
                );
            } else {
                match format {
                    ShareFormat::Json => {
                        print!("{}", report::render_share_json(&domain, &results, days))
                    }
                    ShareFormat::Markdown => {
                        print!("{}", report::render_share_markdown(&domain, &results, days))
                    }
                }
            }
        }

        Commands::Stats { domain, days } => match domain {
            None => {
                let domains = storage.list_domains()?;
                println!();
                println!(
                    "  {}  {} domain(s) tracked",
                    "Stats".bold(),
                    domains.len().to_string().cyan()
                );
                println!("{}", "─".repeat(64).dimmed());
                if domains.is_empty() {
                    println!(
                        "\n  No data yet. Run {} to start tracking.\n",
                        "ghostping audit run".cyan()
                    );
                } else {
                    for d in &domains {
                        println!("  {}  {}", "·".dimmed(), d.cyan());
                    }
                    println!("\n  {}  ghostping stats <domain>\n", "→".cyan());
                }
            }
            Some(domain) => {
                let stats = storage.domain_stats(&domain, days)?;
                report::print_stats(&domain, &stats, days);
            }
        },

        Commands::Chat => {
            let providers = tracker::build_providers_filtered(&config, cli.models.as_deref());
            if providers.is_empty() {
                no_providers_error();
            }
            tui::chat::run(providers).await?;
        }

        Commands::Docs => {
            print!("{}", generate_docs());
        }

        Commands::Schedule {
            domain,
            interval,
            uninstall,
        } => {
            let parsed_interval = match interval.as_str() {
                "daily" => scheduler::ScheduleInterval::Daily,
                "weekly" => scheduler::ScheduleInterval::Weekly,
                h => match h.parse::<u32>() {
                    Ok(n) if n > 0 => scheduler::ScheduleInterval::Custom(n),
                    _ => {
                        eprintln!("  {} Unknown interval '{}'. Use daily, weekly, or a number of hours (1-24 for cron).", "Error:".red().bold(), h);
                        std::process::exit(1);
                    }
                },
            };

            let binary_path = std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "ghostping".to_string());

            // Scheduled jobs run the canonical evidence audit from the
            // project directory holding ghostping.toml.
            let job = scheduler::ScheduledAudit {
                project_dir: std::env::current_dir()?,
                models: cli.models.clone(),
                label: domain.clone(),
                binary: binary_path,
            };
            #[cfg(target_os = "macos")]
            {
                // macOS-only: Linux cron derives its label inside
                // `ScheduledAudit`, so this binding lives here.
                let safe_label = scheduler::sanitize_label(&domain);
                let label = format!("com.ghostping.audit.{}", safe_label);
                let plist_path = dirs::home_dir()
                    .unwrap_or_default()
                    .join("Library/LaunchAgents")
                    .join(format!("{}.plist", label));

                if uninstall {
                    if plist_path.exists() {
                        let _ = std::process::Command::new("launchctl")
                            .args(["unload", &plist_path.display().to_string()])
                            .output();
                        std::fs::remove_file(&plist_path)?;
                        println!(
                            "\n  {}  Scheduled audit for {} removed.\n",
                            "✓".green().bold(),
                            domain.cyan()
                        );
                    } else {
                        println!(
                            "\n  {}  No scheduled job found for {}.\n",
                            "!".yellow(),
                            domain.cyan()
                        );
                    }
                } else {
                    let path = scheduler::install_launchd(&job, parsed_interval)?;
                    let _ = std::process::Command::new("launchctl")
                        .args(["load", &path.display().to_string()])
                        .output();
                    println!();
                    println!(
                        "  {}  Scheduled {} evidence audit for {}",
                        "✓".green().bold(),
                        parsed_interval.label().cyan(),
                        domain.cyan()
                    );
                    println!(
                        "  {}  Plist: {}",
                        "→".cyan(),
                        path.display().to_string().dimmed()
                    );
                    println!("  {}  Logs:  {}", "→".cyan(), job.log_path().dimmed());
                    println!();
                    println!(
                        "  {}  The job runs {} from {} (project must contain ghostping.toml).",
                        "→".cyan(),
                        "ghostping audit run".cyan(),
                        job.project_dir.display().to_string().dimmed()
                    );
                    println!(
                        "  {}  To remove: {}\n",
                        "→".cyan(),
                        format!("ghostping schedule {} --uninstall", domain).cyan()
                    );
                }
            }

            #[cfg(not(target_os = "macos"))]
            {
                if uninstall {
                    println!(
                        "\n  {}  On Linux, remove the cron entry manually with {}\n",
                        "→".cyan(),
                        "crontab -e".cyan()
                    );
                } else {
                    let line = scheduler::cron_line(&job, parsed_interval)?;
                    println!();
                    println!(
                        "  {}  Add this line to your crontab ({}):",
                        "→".cyan(),
                        "crontab -e".cyan()
                    );
                    println!();
                    println!("  {}", line.cyan());
                    println!();
                    println!(
                        "  {}  Logs will be appended to {}\n",
                        "→".cyan(),
                        job.log_path().dimmed()
                    );
                }
                let _ = parsed_interval;
            }
        }

        Commands::Publish { domain, note } => {
            let (rate, mentioned, total) = storage.current_mention_stats(&domain)?;
            if total == 0 {
                println!(
                    "\n  {}  No audit data for {}. Run {} first.\n",
                    "!".yellow(),
                    domain.cyan(),
                    format!("ghostping audit-legacy {}", domain).cyan()
                );
            } else {
                storage.record_publish_snapshot(
                    &domain,
                    note.as_deref(),
                    rate,
                    mentioned,
                    total,
                )?;
                println!();
                println!(
                    "  {}  Publish checkpoint recorded for {}",
                    "✓".green().bold(),
                    domain.cyan()
                );
                println!(
                    "  {}  Baseline mention rate: {:.0}%  ({}/{} queries, last 7 days)",
                    "→".cyan(),
                    rate,
                    mentioned,
                    total
                );
                if let Some(n) = &note {
                    println!("  {}  Note: {}", "→".cyan(), n.dimmed());
                }
                println!();
                println!(
                    "  {}  Re-audit in a few days, then run {} to measure lift.",
                    "Tip".yellow().bold(),
                    format!("ghostping results {}", domain).cyan()
                );
                println!();
            }
        }

        Commands::Results { domain, all } => {
            let snapshots = storage.list_publish_snapshots(&domain)?;
            if snapshots.is_empty() {
                println!(
                    "\n  {}  No publish checkpoints for {}. Run {} after publishing content.\n",
                    "!".yellow(),
                    domain.cyan(),
                    format!("ghostping publish {}", domain).cyan()
                );
            } else {
                let (current_rate, current_mentioned, current_total) =
                    storage.current_mention_stats(&domain)?;
                report::print_results(
                    &domain,
                    &snapshots,
                    current_rate,
                    current_mentioned,
                    current_total,
                    all,
                );
            }
        }

        Commands::Config => run_config_command()?,

        Commands::Doctor => run_doctor(&config, &base_dir).await?,

        Commands::Quickstart => run_quickstart()?,

        // ── Evidence-First Workflow (Primary Commands) ───────────────────────────
        Commands::Init {
            name,
            website,
            category,
            yes,
            force,
        } => {
            run_init2(name, website, category, yes, force)?;
        }

        Commands::Prompts(prompt_cmd) => {
            // Load project config
            let (project, _project_dir) = match ProjectConfig::find_and_load() {
                Ok(Some((p, d))) => (p, d),
                Ok(None) => {
                    println!(
                        "\n  {} No ghostping.toml found. Run {} first.\n",
                        "!".yellow(),
                        "ghostping init".cyan()
                    );
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("  {} Failed to load project config: {}", "✗".red(), e);
                    std::process::exit(1);
                }
            };

            // Open audit storage
            let storage_path = base_dir.join("evidence.db");
            let storage = AuditStorage::open(&storage_path)?;

            match prompt_cmd {
                PromptsCommand::Discover { limit } => {
                    run_prompts_discover(&project, &storage, limit).await?;
                }
                PromptsCommand::List => {
                    run_prompts_list(&project, &storage)?;
                }
                PromptsCommand::Templates(template_cmd) => {
                    run_prompts_templates(&base_dir, template_cmd).await?;
                }
            }
        }

        Commands::Audit(audit_cmd) => {
            // Load project config
            let (project, _project_dir) = match ProjectConfig::find_and_load() {
                Ok(Some((p, d))) => (p, d),
                Ok(None) => {
                    println!(
                        "\n  {} No ghostping.toml found. Run {} first.\n",
                        "!".yellow(),
                        "ghostping init".cyan()
                    );
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("  {} Failed to load project config: {}", "✗".red(), e);
                    std::process::exit(1);
                }
            };

            // Open audit storage
            let storage_path = base_dir.join("evidence.db");
            let storage = AuditStorage::open(&storage_path)?;

            match audit_cmd {
                AuditCommand::Run {
                    samples,
                    temperature,
                    models,
                    json,
                    yes,
                } => {
                    run_audit_run(
                        &project,
                        &config,
                        &storage,
                        AuditRunRequest {
                            samples,
                            temperature,
                            models,
                            json,
                            yes,
                            quiet: cli.quiet,
                            verbose: cli.verbose,
                        },
                    )
                    .await?;
                }
                AuditCommand::List { limit } => {
                    run_audit_list(&project, &storage, limit)?;
                }
                AuditCommand::Show { id } => {
                    run_audit_show(&storage, id)?;
                }
                AuditCommand::Compare {
                    before,
                    after,
                    format,
                } => {
                    run_compare(&storage, before, after, &format).await?;
                }
            }
        }

        Commands::Report {
            run,
            format,
            output,
            full,
            force,
        } => {
            // Load project config
            let (project, _project_dir) = match ProjectConfig::find_and_load() {
                Ok(Some((p, d))) => (p, d),
                Ok(None) => {
                    println!(
                        "\n  {} No ghostping.toml found. Run {} first.\n",
                        "!".yellow(),
                        "ghostping init".cyan()
                    );
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("  {} Failed to load project config: {}", "✗".red(), e);
                    std::process::exit(1);
                }
            };

            // Open audit storage
            let storage_path = base_dir.join("evidence.db");
            let storage = AuditStorage::open(&storage_path)?;

            run_report2(&project, &storage, run, &format, output, full, force).await?;
        }

        Commands::Generate {
            from_audit,
            output,
            force,
        } => {
            // Load project config
            let (project, _project_dir) = match ProjectConfig::find_and_load() {
                Ok(Some((p, d))) => (p, d),
                Ok(None) => {
                    println!(
                        "\n  {} No ghostping.toml found. Run {} first.\n",
                        "!".yellow(),
                        "ghostping init".cyan()
                    );
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("  {} Failed to load project config: {}", "✗".red(), e);
                    std::process::exit(1);
                }
            };

            // Open audit storage
            let storage_path = base_dir.join("evidence.db");
            let storage = AuditStorage::open(&storage_path)?;

            run_generate2(&project, &storage, &from_audit, output, force)?;
        }

        Commands::Diagnose { url } => {
            run_diagnose2(&url).await?;
        }

        Commands::Observations(obs_cmd) => {
            // Load project config
            let (project, _project_dir) = match ProjectConfig::find_and_load() {
                Ok(Some((p, d))) => (p, d),
                Ok(None) => {
                    println!(
                        "\n  {} No ghostping.toml found. Run {} first.\n",
                        "!".yellow(),
                        "ghostping init".cyan()
                    );
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("  {} Failed to load project config: {}", "✗".red(), e);
                    std::process::exit(1);
                }
            };

            // Open audit storage (observations live in evidence.db)
            let storage_path = base_dir.join("evidence.db");
            let storage = AuditStorage::open(&storage_path)?;

            match obs_cmd {
                ObservationsCommand::ImportGsc {
                    file,
                    report,
                    date,
                    start_date,
                    end_date,
                } => {
                    run_observations_import_gsc(
                        &project,
                        &storage,
                        &file,
                        &report,
                        date.as_deref(),
                        start_date.as_deref(),
                        end_date.as_deref(),
                    )?;
                }
                ObservationsCommand::ImportGrounded {
                    file,
                    prompt,
                    group,
                } => {
                    run_observations_import_grounded(&project, &storage, &file, &prompt, &group)?;
                }
                ObservationsCommand::Report => {
                    run_observations_report(&project, &storage)?;
                }
            }
        }
    }

    Ok(())
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn print_welcome() {
    println!("{}", BANNER.cyan().dimmed());
    println!("{}", "━".repeat(62).dimmed());
    println!("  {}", TAGLINE);
    println!("{}", "━".repeat(62).dimmed());
    println!();
}

fn no_providers_error() -> ! {
    eprintln!("\n  {} No providers are enabled.\n", "Error:".red().bold());
    eprintln!("  Options:");
    eprintln!(
        "    • Add an API key in {}",
        "~/.ghostping/config.toml".cyan()
    );
    eprintln!(
        "    • Or run {} and set {} for free local inference",
        "ollama serve".cyan(),
        "enabled = true".cyan()
    );
    eprintln!(
        "\n  Run {} to see setup instructions.\n",
        "ghostping config".cyan()
    );
    std::process::exit(1);
}

const CLOUD_AUDIT_NOTICE: &str = "Notice: this audit will send prompts to the selected cloud provider using your configured API key. Project data and audit history remain local, but provider requests are processed by the selected provider.";

const MOCK_AUDIT_NOTICE: &str = "Notice: the mock provider returns synthetic TEST DATA for workflow validation only. Mock results are not real-world AI visibility measurements and must not be presented as evidence.";

fn provider_display_name(provider: &str) -> &'static str {
    match provider {
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        "gemini" | "google" => "Google Gemini",
        "xai" | "grok" => "xAI/Grok",
        "perplexity" => "Perplexity",
        "mistral" => "Mistral",
        _ => "Cloud provider",
    }
}

fn provider_api_key_env(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("OPENAI_API_KEY"),
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "gemini" | "google" => Some("GEMINI_API_KEY"),
        "xai" | "grok" => Some("XAI_API_KEY"),
        "perplexity" => Some("PERPLEXITY_API_KEY"),
        "mistral" => Some("MISTRAL_API_KEY"),
        _ => None,
    }
}

fn provider_config_path(provider: &str) -> &'static str {
    match provider {
        "openai" => "providers.openai.api_key",
        "anthropic" => "providers.anthropic.api_key",
        "gemini" | "google" => "providers.gemini.api_key",
        "xai" | "grok" => "providers.xai.api_key",
        "perplexity" => "providers.perplexity.api_key",
        "mistral" => "providers.mistral.api_key",
        _ => "providers.<name>.api_key",
    }
}

fn normalize_provider_name(name: &str) -> &str {
    match name {
        "google" => "gemini",
        "grok" => "xai",
        other => other,
    }
}

fn is_cloud_provider_name(name: &str) -> bool {
    matches!(
        normalize_provider_name(name),
        "openai" | "anthropic" | "xai" | "gemini" | "perplexity" | "mistral"
    )
}

fn is_missing_api_key(api_key: &str) -> bool {
    let key = api_key.trim();
    key.is_empty()
        || matches!(
            key,
            "sk-..." | "sk-ant-..." | "AIza..." | "xai-..." | "pplx-..." | "..."
        )
}

fn provider_config<'a>(
    config: &'a Config,
    provider: &str,
) -> Option<&'a ghostping::config::ProviderConfig> {
    match normalize_provider_name(provider) {
        "openai" => config.providers.openai.as_ref(),
        "anthropic" => config.providers.anthropic.as_ref(),
        "gemini" => config.providers.gemini.as_ref(),
        "xai" => config.providers.xai.as_ref(),
        "perplexity" => config.providers.perplexity.as_ref(),
        _ => None,
    }
}

fn selected_audit_provider_names(
    project: &ProjectConfig,
    global_config: &Config,
    models: Option<&str>,
) -> Vec<String> {
    let mut names = Vec::new();

    if let Some(filter) = models {
        names.extend(
            filter
                .split(',')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(|name| name.split(':').next().unwrap_or(name).to_lowercase()),
        );
    } else if !project.providers.models.is_empty() {
        names.extend(project.providers.models.iter().filter_map(|model| {
            model
                .split(':')
                .next()
                .filter(|name| !name.is_empty())
                .map(|name| name.to_lowercase())
        }));
    } else {
        if global_config
            .providers
            .openai
            .as_ref()
            .is_some_and(|c| c.enabled)
        {
            names.push("openai".to_string());
        }
        if global_config
            .providers
            .anthropic
            .as_ref()
            .is_some_and(|c| c.enabled)
        {
            names.push("anthropic".to_string());
        }
        if global_config
            .providers
            .gemini
            .as_ref()
            .is_some_and(|c| c.enabled)
        {
            names.push("gemini".to_string());
        }
        if global_config
            .providers
            .xai
            .as_ref()
            .is_some_and(|c| c.enabled)
        {
            names.push("xai".to_string());
        }
        if global_config
            .providers
            .perplexity
            .as_ref()
            .is_some_and(|c| c.enabled)
        {
            names.push("perplexity".to_string());
        }
        if global_config
            .providers
            .ollama
            .as_ref()
            .is_some_and(|c| c.enabled)
        {
            names.push("ollama".to_string());
        }
    }

    names.sort();
    names.dedup();
    names
}

fn is_local_ollama_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.contains("://localhost")
        || lower.contains("://127.0.0.1")
        || lower.contains("://[::1]")
        || lower.contains("://0.0.0.0")
}

fn audit_uses_remote_ollama(selected: &[String], config: &Config) -> bool {
    selected
        .iter()
        .any(|name| normalize_provider_name(name) == "ollama")
        && config
            .providers
            .ollama
            .as_ref()
            .is_some_and(|c| !is_local_ollama_url(&c.base_url))
}

fn ensure_cloud_api_keys(selected: &[String], config: &Config) -> Result<()> {
    for provider in selected {
        let provider = normalize_provider_name(provider);
        if !is_cloud_provider_name(provider) {
            continue;
        }

        let Some(env_var) = provider_api_key_env(provider) else {
            continue;
        };
        let env_key_present = std::env::var(env_var)
            .ok()
            .is_some_and(|key| !is_missing_api_key(&key));
        let missing = !env_key_present
            && provider_config(config, provider)
                .map(|c| is_missing_api_key(&c.api_key))
                .unwrap_or(true);

        if missing {
            bail!(
                "Missing {} API key. Set {} or configure {} in ~/.ghostping/config.toml. For local testing without API keys, run: ghostping audit run --models mock --samples 3",
                provider_display_name(provider),
                env_var,
                provider_config_path(provider)
            );
        }
    }

    Ok(())
}

fn warn_cloud_audit_if_needed(selected: &[String], config: &Config, yes: bool) {
    let uses_cloud = selected
        .iter()
        .any(|name| is_cloud_provider_name(name.as_str()));

    if uses_cloud || audit_uses_remote_ollama(selected, config) {
        eprintln!("\n  {}", CLOUD_AUDIT_NOTICE.yellow().bold());
        if yes {
            eprintln!("  Cloud notice acknowledged with {}.\n", "--yes".cyan());
        } else {
            eprintln!(
                "  Pass {} to acknowledge this notice in scripts.\n",
                "--yes".cyan()
            );
        }
    }
}

fn run_config_command() -> Result<()> {
    let (dir, _) = Config::ensure_dir()?;
    let path = ghostping::config::config_path();

    println!();
    println!("{}", "Ghostping — Configuration".bold());
    println!("{}", "━".repeat(56).dimmed());
    println!();
    println!("  Config dir   {}", dir.display().to_string().cyan());
    println!("  Config file  {}", path.display().to_string().cyan());
    println!();

    if path.exists() {
        println!(
            "  {} Config already exists — edit it to add or update keys.",
            "✓".green()
        );
    } else {
        std::fs::write(&path, EXAMPLE_CONFIG)?;
        println!(
            "  {} Created {}",
            "✅".green(),
            path.display().to_string().cyan()
        );
        println!("     Edit it with your API keys, or set");
        println!(
            "     {} under [providers.ollama] for zero-cost local inference.",
            "enabled = true".cyan()
        );
    }

    println!();
    println!("  {}", "Supported providers:".bold());
    println!("    {}  openai     — gpt-4o-mini, gpt-4o, …", "·".dimmed());
    println!(
        "    {}  anthropic  — claude-3-5-haiku, claude-3-5-sonnet, …",
        "·".dimmed()
    );
    println!(
        "    {}  gemini     — gemini-2.0-flash, gemini-1.5-pro  (Google)",
        "·".dimmed()
    );
    println!("    {}  xai        — grok-2-latest  (x.ai)", "·".dimmed());
    println!(
        "    {}  perplexity — sonar, sonar-pro  (web-search grounded)",
        "·".dimmed()
    );
    println!(
        "    {}  ollama     — llama3.2, mistral, phi4, …  (local, free)",
        "·".dimmed()
    );
    println!();
    println!(
        "  {}  Set {} for deterministic, cacheable results.",
        "Tip".yellow().bold(),
        "temperature = 0".cyan()
    );
    println!(
        "  {}  Run {} after editing to verify your setup.",
        "Tip".yellow().bold(),
        "ghostping doctor".cyan()
    );
    println!();
    Ok(())
}

async fn run_doctor(config: &Config, base_dir: &Path) -> Result<()> {
    println!();
    println!("{}", "Ghostping Doctor".bold());
    println!("{}", "━".repeat(56).dimmed());
    println!();

    // ── Paths ──
    let config_path = ghostping::config::config_path();
    check(
        "Config file  ",
        config_path.exists(),
        &config_path.display().to_string(),
    );
    check(
        "Cache dir    ",
        base_dir.join("cache").exists(),
        "~/.ghostping/cache/",
    );
    check(
        "Database     ",
        base_dir.join("mentions.db").exists(),
        "~/.ghostping/mentions.db",
    );

    println!();
    println!("  {}", "Providers:".bold());

    let mut any_enabled = false;

    // OpenAI
    match &config.providers.openai {
        Some(c) if c.enabled => {
            any_enabled = true;
            println!(
                "  {}  openai    {} ({})",
                "✓".green(),
                "enabled".green(),
                c.model.dimmed()
            );
        }
        Some(_) => println!("  {}  openai    disabled", "–".dimmed()),
        None => println!("  {}  openai    not configured", "–".dimmed()),
    }

    // Anthropic
    match &config.providers.anthropic {
        Some(c) if c.enabled => {
            any_enabled = true;
            println!(
                "  {}  anthropic {} ({})",
                "✓".green(),
                "enabled".green(),
                c.model.dimmed()
            );
        }
        Some(_) => println!("  {}  anthropic disabled", "–".dimmed()),
        None => println!("  {}  anthropic not configured", "–".dimmed()),
    }

    // Perplexity
    match &config.providers.perplexity {
        Some(c) if c.enabled => {
            any_enabled = true;
            println!(
                "  {}  perplexity {} ({})",
                "✓".green(),
                "enabled".green(),
                c.model.dimmed()
            );
        }
        Some(_) => println!("  {}  perplexity disabled", "–".dimmed()),
        None => println!("  {}  perplexity not configured", "–".dimmed()),
    }

    // Gemini
    match &config.providers.gemini {
        Some(c) if c.enabled => {
            any_enabled = true;
            println!(
                "  {}  gemini    {} ({})",
                "✓".green(),
                "enabled".green(),
                c.model.dimmed()
            );
        }
        Some(_) => println!("  {}  gemini    disabled", "–".dimmed()),
        None => println!("  {}  gemini    not configured", "–".dimmed()),
    }

    // xAI
    match &config.providers.xai {
        Some(c) if c.enabled => {
            any_enabled = true;
            println!(
                "  {}  xai       {} ({})",
                "✓".green(),
                "enabled".green(),
                c.model.dimmed()
            );
        }
        Some(_) => println!("  {}  xai       disabled", "–".dimmed()),
        None => println!("  {}  xai       not configured", "–".dimmed()),
    }

    // Ollama — do a live connectivity check
    match &config.providers.ollama {
        Some(c) if c.enabled => {
            any_enabled = true;
            let reachable = ping_ollama(&c.base_url).await;
            if reachable {
                println!(
                    "  {}  ollama    {} ({}, {})",
                    "✓".green(),
                    "enabled".green(),
                    c.model.dimmed(),
                    "reachable".green()
                );
            } else {
                println!(
                    "  {}  ollama    {} — {} is not responding",
                    "!".yellow().bold(),
                    "enabled but unreachable".yellow(),
                    c.base_url.cyan()
                );
                println!("       Start it with: {}", "ollama serve".cyan());
            }
        }
        Some(c) => {
            // Check reachability even when disabled, to help user enable it
            let reachable = ping_ollama(&c.base_url).await;
            if reachable {
                println!(
                    "  {}  ollama    disabled (but {} — set {} to use it)",
                    "–".dimmed(),
                    "running".green(),
                    "enabled = true".cyan()
                );
            } else {
                println!("  {}  ollama    disabled", "–".dimmed());
            }
        }
        None => println!("  {}  ollama    not configured", "–".dimmed()),
    }

    println!();
    if any_enabled {
        println!(
            "  {} At least one provider is active. Try: {}",
            "✓".green().bold(),
            "ghostping audit run --models mock --samples 3".cyan()
        );
    } else {
        println!(
            "  {} No providers enabled. Edit {} to get started.",
            "✗".red().bold(),
            "~/.ghostping/config.toml".cyan()
        );
    }
    println!();
    Ok(())
}

async fn ping_ollama(base_url: &str) -> bool {
    let url = format!("{}/api/tags", base_url);
    reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn check(label: &str, ok: bool, detail: &str) {
    if ok {
        println!("  {}  {}  {}", "✓".green(), label, detail.dimmed());
    } else {
        println!("  {}  {}  {} (missing)", "✗".red(), label, detail.dimmed());
    }
}

fn run_quickstart() -> Result<()> {
    println!();
    println!("{}", "Ghostping Quickstart".bold());
    println!("{}", "━".repeat(56).dimmed());
    println!();
    println!("  {}  {}", "1.".bold(), "Create config".bold());
    println!("      {}", "ghostping config".cyan());
    println!();
    println!(
        "  {}  {}",
        "2.".bold(),
        "Add your API key (or enable Ollama for free)".bold()
    );
    println!("      {}", "Edit ~/.ghostping/config.toml".cyan());
    println!();
    println!("  {}  {}", "3.".bold(), "Verify your setup".bold());
    println!("      {}", "ghostping doctor".cyan());
    println!();
    println!("  {}  {}", "4.".bold(), "Run your first audit".bold());
    println!(
        "      {}",
        "ghostping init --yes && ghostping prompts discover && ghostping audit run".cyan()
    );
    println!();
    println!(
        "  {}  {}",
        "5.".bold(),
        "Let the agent optimize (optional)".bold()
    );
    println!(
        "      {}",
        "ghostping optimize myproject.com --niche \"your niche\" --auto-apply".cyan()
    );
    println!();
    println!("{}", "─".repeat(56).dimmed());
    println!();
    println!(
        "  {}  Need help? Run {} for full documentation.",
        "Tip".yellow().bold(),
        "ghostping docs".cyan()
    );
    println!();
    Ok(())
}

fn build_judge_provider(
    flag: bool,
    config: &Config,
) -> Option<std::sync::Arc<dyn ghostping::providers::LlmProvider>> {
    if flag || config.judge.enabled {
        tracker::build_judge(config)
    } else {
        None
    }
}

fn fetch_prev_rate(storage: &Storage, domain: &str) -> Option<f64> {
    let before = chrono::Utc::now().to_rfc3339();
    match storage.previous_run_stats(domain, &before) {
        Ok(Some((m, t))) if t > 0 => Some(m as f64 / t as f64 * 100.0),
        _ => None,
    }
}

fn load_prompts(path: Option<PathBuf>, domain: &str) -> Result<Vec<String>> {
    match path {
        Some(p) => {
            let contents = std::fs::read_to_string(&p)
                .map_err(|e| anyhow::anyhow!("Cannot read prompts file {}: {}", p.display(), e))?;
            if p.extension().is_some_and(|e| e == "json") {
                serde_json::from_str(&contents)
                    .map_err(|e| anyhow::anyhow!("Invalid JSON in {}: {}", p.display(), e))
            } else {
                Ok(contents
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(String::from)
                    .collect())
            }
        }
        None => Ok(audit_prompts(domain, None, None)),
    }
}

fn audit_prompts(domain: &str, niche: Option<&str>, competitor: Option<&str>) -> Vec<String> {
    prompts::default_prompts(domain, niche, competitor)
}

/// Resolve a generate system prompt template from a named plugin.
/// Checks installed plugins first, then falls back to builtins.
fn resolve_generate_template(name: Option<&str>, config_dir: &Path) -> Option<String> {
    let name = name?;
    if let Some(plugin) = plugins::find_plugin(config_dir, name) {
        if let Some(tpl) = plugin.generate_template() {
            return Some(tpl);
        }
    }
    builtin::generate_template(name).map(|s| s.to_string())
}

/// Resolve a discover system prompt template from a named plugin.
fn resolve_discover_template(name: Option<&str>, config_dir: &Path) -> Option<String> {
    let name = name?;
    if let Some(plugin) = plugins::find_plugin(config_dir, name) {
        if let Some(tpl) = plugin.discover_template() {
            return Some(tpl);
        }
    }
    builtin::discover_template(name).map(|s| s.to_string())
}

fn generate_docs() -> String {
    let mut out = String::from("# Ghostping — Command Reference\n\n");
    out.push_str("Local-first GEO (Generative Engine Optimization) agent for indie hackers.\n\n");
    out.push_str("---\n\n");

    let commands = [
        ("audit run", "Evidence audit: prompts × samples × providers, stored with citations.",
         "ghostping audit run --models mock --samples 3\nghostping audit run --models ollama --samples 3\nghostping audit list\nghostping audit show 1\nghostping audit compare --before 1 --after 2"),
        ("audit-legacy", "Legacy one-shot domain scan (mentions.db, not evidence).",
         "ghostping audit-legacy myproject.com --niche \"Rust CLI tool\""),
        ("track", "Run custom prompts from a file and record brand mentions.",
         "ghostping track myproject.com --prompts prompts.txt\nghostping track myproject.com --prompts prompts.json --models anthropic"),
        ("report", "Markdown evidence report for an audit run.",
         "ghostping report\nghostping report --run 1 --output ./reports/"),
        ("report-legacy", "Mention history and trends from the legacy database.",
         "ghostping report-legacy myproject.com\nghostping report-legacy myproject.com --days 30"),
        ("generate", "Draft content assets from evidence audit gaps.",
         "ghostping generate\nghostping generate --from-audit 1 --output ./generated/"),
        ("generate-legacy", "Generate GEO-optimized markdown content for a target query.",
         "ghostping generate-legacy \"best rust cli tool\" --about \"myproject.io is a ...\"\nghostping generate-legacy \"...\" --plugin rust-crate --about \"...\"\nghostping generate-legacy \"...\" --evaluate"),
        ("optimize", "5-step autonomous GEO agent: discover, audit, generate, refine, evaluate.",
         "ghostping optimize myproject.com --niche \"Rust CLI tool\"\nghostping optimize myproject.com --niche \"...\" --steps 5 --auto-apply\nghostping optimize myproject.com --niche \"...\" --max-rounds 3\nghostping optimize myproject.com --niche \"...\" --plugin rust-crate"),
        ("chat", "Structured TUI assistant — state a goal, get a guided GEO plan.",
         "ghostping chat\nghostping chat --models ollama"),
        ("projects", "Manage saved domain + niche pairs.",
         "ghostping projects\nghostping projects add myproject.com --niche \"Rust CLI tool\"\nghostping projects remove myproject.com"),
        ("watch", "Background polling audit on a fixed interval.",
         "ghostping watch myproject.com --niche \"Rust CLI tool\"\nghostping watch myproject.com --interval 30 --models ollama"),
        ("stats", "Personal usage trends and per-day breakdown.",
         "ghostping stats\nghostping stats myproject.com\nghostping stats myproject.com --days 30"),
        ("share", "Export a shareable visibility report.",
         "ghostping share myproject.com\nghostping share myproject.com --days 30 > report.md\nghostping share myproject.com --format json > report.json"),
        ("prompts", "Discover project prompts; browse/install template packs.",
         "ghostping prompts discover\nghostping prompts list\nghostping prompts templates list\nghostping prompts templates search rust\nghostping prompts templates install rust-crate"),
        ("plugins", "Manage installed plugins.",
         "ghostping plugins\nghostping plugins enable rust-crate\nghostping plugins disable rust-crate"),
        ("config", "Create ~/.ghostping/config.toml and show setup instructions.", "ghostping config"),
        ("doctor", "Verify config, providers, and Ollama connectivity.", "ghostping doctor"),
        ("docs", "Print this command reference as markdown.", "ghostping docs > COMMANDS.md"),
        ("observations import-gsc", "Import a Search Console CSV export as first-party observations.",
         "ghostping observations import-gsc --file Queries.csv --date 2026-09-01"),
        ("observations report", "First-party impressions vs sampled mentions, separate denominators.",
         "ghostping observations report"),
    ];

    for (name, desc, examples) in &commands {
        out.push_str(&format!("## `{}`\n\n{}\n\n", name, desc));
        out.push_str("```bash\n");
        out.push_str(examples);
        out.push_str("\n```\n\n");
    }

    out.push_str("---\n\n");
    out.push_str("## Global Flags\n\n");
    out.push_str("| Flag | Description |\n");
    out.push_str("|------|-------------|\n");
    out.push_str("| `--models openai,anthropic` | Comma-separated provider list |\n");
    out.push_str("| `--verbose` | Show raw LLM response previews |\n");
    out.push_str("| `--quiet` | Suppress progress output (CI-friendly) |\n\n");
    out.push_str("---\n\n");
    out.push_str("_Generated by `ghostping docs` — [Ghostping](https://github.com/commonfields/ghostping)_\n");
    out
}

fn run_projects_list(storage: &Storage) -> anyhow::Result<()> {
    use comfy_table::{Attribute, Cell, Color, ContentArrangement, Table};
    let projects = storage.list_projects()?;
    println!();
    println!(
        "  {}  {} saved",
        "Projects".bold(),
        projects.len().to_string().cyan()
    );
    println!("{}", "─".repeat(64).dimmed());
    if projects.is_empty() {
        println!(
            "\n  No projects yet. Add one:\n  {}\n",
            "ghostping projects add myproject.com --niche \"your niche\"".cyan()
        );
        return Ok(());
    }
    println!();
    let mut table = Table::new();
    table.set_content_arrangement(ContentArrangement::Dynamic);
    table.set_header(vec![
        Cell::new("Domain").add_attribute(Attribute::Bold),
        Cell::new("Niche").add_attribute(Attribute::Bold),
        Cell::new("Last Audited").add_attribute(Attribute::Bold),
        Cell::new("Notes").add_attribute(Attribute::Bold),
    ]);
    for p in &projects {
        let last = p
            .last_audited
            .as_deref()
            .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
            .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| "never".to_string());
        table.add_row(vec![
            Cell::new(&p.domain).fg(Color::Cyan),
            Cell::new(p.niche.as_deref().unwrap_or("—")),
            Cell::new(last).fg(Color::DarkGrey),
            Cell::new(p.notes.as_deref().unwrap_or("—")).fg(Color::DarkGrey),
        ]);
    }
    println!("{table}");
    println!(
        "\n  {}  ghostping audit <domain>  or  ghostping optimize <domain> --niche <niche>\n",
        "Tip".yellow().bold()
    );
    Ok(())
}

// ── New Evidence-First Command Handlers (v0.2+) ──────────────────────────────

fn run_init2(
    name: Option<String>,
    website: Option<String>,
    category: Option<String>,
    yes: bool,
    force: bool,
) -> Result<()> {
    use std::io::{self, Write};

    // Check if ghostping.toml already exists
    if PathBuf::from("ghostping.toml").exists() && !force {
        println!("\n  {} ghostping.toml already exists", "!".yellow());
        println!("  Use {} to overwrite\n", "--force".cyan());
        return Ok(());
    }

    let mut config = ProjectConfig::default();

    if yes {
        // Use defaults or provided values
        config.project.name = name.unwrap_or_else(|| "MyProject".to_string());
        config.project.website = website.unwrap_or_default();
        config.project.category = category.unwrap_or_else(|| "developer tool".to_string());
    } else {
        // Interactive mode
        let stdin = io::stdin();
        let mut stdout = io::stdout();

        print!(
            "  Project name [{}]: ",
            name.as_deref().unwrap_or("MyProject")
        );
        stdout.flush()?;
        let mut input = String::new();
        stdin.read_line(&mut input)?;
        config.project.name = if input.trim().is_empty() {
            name.unwrap_or_else(|| "MyProject".to_string())
        } else {
            input.trim().to_string()
        };

        print!("  Website [{}]: ", website.as_deref().unwrap_or(""));
        stdout.flush()?;
        input.clear();
        stdin.read_line(&mut input)?;
        config.project.website = if input.trim().is_empty() {
            website.unwrap_or_default()
        } else {
            input.trim().to_string()
        };

        print!(
            "  Category [{}]: ",
            category.as_deref().unwrap_or("developer tool")
        );
        stdout.flush()?;
        input.clear();
        stdin.read_line(&mut input)?;
        config.project.category = if input.trim().is_empty() {
            category.unwrap_or_else(|| "developer tool".to_string())
        } else {
            input.trim().to_string()
        };
    }

    // Validate
    config.validate()?;

    // Save
    let path = config.save_to_dir(&std::env::current_dir()?)?;

    println!();
    println!(
        "  {} Created {}",
        "✓".green().bold(),
        path.display().to_string().cyan()
    );
    println!();
    println!("  Next steps:");
    println!(
        "    1. Edit {} to customize your project",
        "ghostping.toml".cyan()
    );
    println!(
        "    2. Run {} to discover prompts",
        "ghostping prompts discover".cyan()
    );
    println!(
        "    3. Run {} to start auditing",
        "ghostping audit run".cyan()
    );
    println!();

    Ok(())
}

async fn run_prompts_discover(
    project: &ProjectConfig,
    storage: &AuditStorage,
    limit: Option<usize>,
) -> Result<()> {
    println!();
    println!(
        "  {} Discovering prompts for {}",
        "→".cyan(),
        project.project.name.cyan().bold()
    );
    println!();

    let discovered = PromptDiscovery::discover(project);
    let limit = limit.unwrap_or(50);

    // Store prompts in database
    let mut stored = 0;
    for prompt in discovered.iter().take(limit) {
        let _id = storage.insert_prompt(
            &project.domain(),
            &NewPrompt {
                text: &prompt.text,
                intent: Some(&prompt.intent),
                funnel_stage: Some(&prompt.funnel_stage),
                priority: Some(prompt.priority),
                expected_entity: Some(&prompt.expected_entity),
                created_by: Some("discover"),
            },
        )?;
        stored += 1;

        if stored <= 10 {
            println!(
                "  {} {} — {} ({})",
                "·".dimmed(),
                prompt.text.cyan(),
                prompt.category.as_str().dimmed(),
                prompt.funnel_stage.dimmed()
            );
        }
    }

    if stored > 10 {
        println!("  {} ... and {} more", "·".dimmed(), stored - 10);
    }

    // Deduplicate
    let deduped = storage.dedupe_prompts(&project.domain())?;

    println!();
    println!(
        "  {} Stored {} prompt(s) (removed {} duplicates)",
        "✓".green().bold(),
        stored - deduped,
        deduped
    );
    println!();

    Ok(())
}

fn run_prompts_list(project: &ProjectConfig, storage: &AuditStorage) -> Result<()> {
    let prompts = storage.list_prompts(&project.domain())?;

    if prompts.is_empty() {
        println!(
            "\n  No prompts found. Run {} first.\n",
            "ghostping prompts discover".cyan()
        );
        return Ok(());
    }

    println!();
    println!(
        "  {} prompt(s) for {}",
        prompts.len().to_string().cyan(),
        project.project.name.cyan().bold()
    );
    println!();

    for p in prompts.iter().take(20) {
        let intent = p.intent.as_deref().unwrap_or("-");
        let stage = p.funnel_stage.as_deref().unwrap_or("-");
        println!(
            "  {} {} — {} → {}",
            format!("#{}", p.id).dimmed(),
            p.prompt_text.cyan(),
            intent.dimmed(),
            stage.dimmed()
        );
    }

    if prompts.len() > 20 {
        println!("  {} ... and {} more", "·".dimmed(), prompts.len() - 20);
    }
    println!();

    Ok(())
}

async fn run_prompts_templates(
    base_dir: &Path,
    template_cmd: PromptTemplatesCommand,
) -> Result<()> {
    use comfy_table::{Attribute, Cell, Color, ContentArrangement, Table};
    use ghostping::marketplace::{builtin, registry};

    match template_cmd {
        PromptTemplatesCommand::List => {
            println!();
            println!(
                "  {}  {} available",
                "Community Templates".bold(),
                registry::BUILTIN_TEMPLATES.len().to_string().cyan()
            );
            println!("{}", "─".repeat(64).dimmed());
            println!();
            let mut table = Table::new();
            table.set_content_arrangement(ContentArrangement::Dynamic);
            table.set_header(vec![
                Cell::new("Name").add_attribute(Attribute::Bold),
                Cell::new("Description").add_attribute(Attribute::Bold),
                Cell::new("Tags").add_attribute(Attribute::Bold),
            ]);
            for t in registry::BUILTIN_TEMPLATES {
                table.add_row(vec![
                    Cell::new(t.name).fg(Color::Cyan),
                    Cell::new(t.description),
                    Cell::new(t.tags.join(", ")).fg(Color::DarkGrey),
                ]);
            }
            println!("{table}");
            println!(
                "\n  {}  ghostping prompts templates install <name>\n",
                "→".cyan()
            );
        }
        PromptTemplatesCommand::Search { query } => {
            let results = registry::search_templates(&query);
            println!();
            println!(
                "  {}  {} match(es) for \"{}\"",
                "Search".bold(),
                results.len().to_string().cyan(),
                query
            );
            println!("{}", "─".repeat(64).dimmed());
            if results.is_empty() {
                println!("\n  No templates matched your query.\n");
            } else {
                println!();
                let mut table = Table::new();
                table.set_content_arrangement(ContentArrangement::Dynamic);
                table.set_header(vec![
                    Cell::new("Name").add_attribute(Attribute::Bold),
                    Cell::new("Description").add_attribute(Attribute::Bold),
                    Cell::new("Tags").add_attribute(Attribute::Bold),
                ]);
                for t in results {
                    table.add_row(vec![
                        Cell::new(t.name).fg(Color::Cyan),
                        Cell::new(t.description),
                        Cell::new(t.tags.join(", ")).fg(Color::DarkGrey),
                    ]);
                }
                println!("{table}");
                println!();
            }
        }
        PromptTemplatesCommand::Install { name } => match registry::find_template(&name) {
            None => {
                println!(
                    "\n  {}  Template {} not found. Run {} to see available templates.\n",
                    "✗".red().bold(),
                    name.cyan(),
                    "ghostping prompts templates list".cyan()
                );
            }
            Some(info) => {
                let plugin_dir = base_dir.join("plugins").join(&name);
                std::fs::create_dir_all(&plugin_dir)?;

                let manifest = format!(
                        "[meta]\nname = \"{}\"\nversion = \"1.0.0\"\ndescription = \"{}\"\nauthor = \"{}\"\ntags = [{}]\n\n[templates]\n{}{}\n",
                        info.name,
                        info.description,
                        info.author,
                        info.tags.iter().map(|t| format!("\"{}\"", t)).collect::<Vec<_>>().join(", "),
                        builtin::generate_template(&name).map(|_| "generate = \"generate.prompt.md\"\n").unwrap_or(""),
                        builtin::discover_template(&name).map(|_| "discover = \"discover.prompt.md\"\n").unwrap_or(""),
                    );
                std::fs::write(plugin_dir.join("plugin.toml"), &manifest)?;

                if let Some(gen_tpl) = builtin::generate_template(&name) {
                    std::fs::write(plugin_dir.join("generate.prompt.md"), gen_tpl)?;
                }
                if let Some(disc_tpl) = builtin::discover_template(&name) {
                    std::fs::write(plugin_dir.join("discover.prompt.md"), disc_tpl)?;
                }

                println!(
                    "\n  {}  Installed {} to {}\n",
                    "✓".green().bold(),
                    name.cyan(),
                    plugin_dir.display().to_string().dimmed()
                );
                println!("  {}  Edit templates at:", "Tip".yellow().bold());
                println!("     {}", plugin_dir.display().to_string().cyan());
                println!(
                    "\n  {}  Use it with:\n  {}\n",
                    "→".cyan(),
                    format!(
                        "ghostping generate-legacy \"...\" --plugin {} --about \"...\"",
                        name
                    )
                    .cyan()
                );
            }
        },
    }
    Ok(())
}

struct AuditRunRequest {
    samples: Option<usize>,
    temperature: Option<f32>,
    models: Option<String>,
    json: bool,
    yes: bool,
    quiet: bool,
    verbose: bool,
}

async fn run_audit_run(
    project: &ProjectConfig,
    global_config: &Config,
    storage: &AuditStorage,
    request: AuditRunRequest,
) -> Result<()> {
    // Get prompts
    let prompts = storage.list_prompts(&project.domain())?;
    if prompts.is_empty() {
        bail!("No prompts found for this project. Run 'ghostping prompts discover' first.");
    }

    let is_mock_run = request.models.as_deref() == Some("mock");
    let selected_providers =
        selected_audit_provider_names(project, global_config, request.models.as_deref());
    ensure_cloud_api_keys(&selected_providers, global_config)?;
    warn_cloud_audit_if_needed(&selected_providers, global_config, request.yes);
    if is_mock_run {
        eprintln!("\n  {}", MOCK_AUDIT_NOTICE.yellow().bold());
    }

    // Build providers
    let providers = if is_mock_run {
        use ghostping::providers::mock::MockProviderBuilder;
        vec![std::sync::Arc::new(
            MockProviderBuilder::new("mock")
                .with_default_response(
                    "MOCK TEST DATA — This is a synthetic mock response for workflow \
                     validation only. It is not a real AI model output and must not \
                     be presented as real-world AI visibility evidence.",
                )
                .build(),
        )
            as std::sync::Arc<dyn ghostping::providers::LlmProvider>]
    } else {
        build_providers_for_project(&project.providers, global_config, request.models.as_deref())
    };

    if providers.is_empty() {
        bail!("No providers configured. Check ~/.ghostping/config.toml or use --models mock");
    }

    // Build options
    let options = AuditOptions {
        samples_per_prompt: request.samples.unwrap_or(project.audit.samples_per_prompt),
        temperature: request.temperature.unwrap_or(project.audit.temperature),
        store_raw_responses: project.audit.store_raw_responses,
        verbose: request.verbose,
        quiet: request.quiet,
        concurrency: global_config.defaults.concurrency,
    };

    // Create engine and run
    let engine = AuditEngine::new(providers, options);

    let prompt_inputs: Vec<PromptInput> = prompts
        .into_iter()
        .map(|p| PromptInput {
            id: Some(p.id),
            text: p.prompt_text,
            intent: p.intent,
            funnel_stage: p.funnel_stage,
            priority: p.priority,
            expected_entity: p.expected_entity,
        })
        .collect();

    let result = engine
        .run_audit(&project.domain(), &prompt_inputs, storage)
        .await?;

    // Output
    if request.json {
        println!("{}", serde_json::to_string_pretty(&result.summary)?);
    } else {
        println!();
        println!(
            "  {} Audit Run {}",
            "✓".green().bold(),
            result.run_id.to_string().cyan()
        );
        println!();
        println!(
            "  Mention rate:          {:.1}%",
            result.summary.mention_rate * 100.0
        );
        println!(
            "  Recommendation rate:   {:.1}%",
            result.summary.recommendation_rate * 100.0
        );
        println!(
            "  Citation rate:         {:.1}% ({} of {} responses with a project citation)",
            result.summary.citation_rate * 100.0,
            result.summary.citation_response_count,
            result.summary.total_queries
        );
        println!("  Total queries:         {}", result.summary.total_queries);
        println!(
            "  Coverage:              {}/{} planned queries succeeded{}",
            result.summary.successful_queries,
            result.summary.planned_queries,
            if result.summary.failed_queries > 0 {
                format!(" ({} failed)", result.summary.failed_queries)
            } else {
                String::new()
            }
        );
        if result.summary.failed_queries > 0 {
            println!();
            println!(
                "  {}  Partial results: {} of {} planned queries failed. This run is",
                "⚠".yellow().bold(),
                result.summary.failed_queries,
                result.summary.planned_queries,
            );
            println!(
                "  marked 'completed_with_errors', not 'completed'. See {} for diagnostics.",
                format!("ghostping audit show {}", result.run_id).cyan()
            );
            for failure in result.failed_queries.iter().take(5) {
                println!("    {} {}", "·".dimmed(), failure.dimmed());
            }
            if result.failed_queries.len() > 5 {
                println!(
                    "    {} ... and {} more (see audit show)",
                    "·".dimmed(),
                    result.failed_queries.len() - 5
                );
            }
        }
        if is_mock_run {
            println!();
            println!("  {}  {}", "⚠".yellow().bold(), MOCK_AUDIT_NOTICE.yellow());
        }
        println!();
        println!(
            "  Next: {} to generate content",
            "ghostping generate".cyan()
        );
        println!();
    }

    // Partial audits print their results but exit non-zero so scripts and
    // CI can detect the shortfall. See docs/engineering/cli-exit-contracts.md.
    if result.summary.failed_queries > 0 {
        std::process::exit(2);
    }

    Ok(())
}

fn run_audit_list(project: &ProjectConfig, storage: &AuditStorage, limit: usize) -> Result<()> {
    let runs = storage.list_audit_runs(&project.domain(), limit)?;

    if runs.is_empty() {
        println!(
            "\n  No audit runs found. Run {} first.\n",
            "ghostping audit run".cyan()
        );
        return Ok(());
    }

    println!();
    println!(
        "  {} audit run(s) for {}",
        runs.len().to_string().cyan(),
        project.project.name.cyan().bold()
    );
    println!();

    for r in &runs {
        let status_icon = match r.status.as_str() {
            "completed" => "✓".green(),
            "completed_with_errors" => "◐".yellow(),
            "failed" => "✗".red(),
            _ => "○".yellow(),
        };
        let is_mock = r.provider_models_json.to_lowercase().contains("mock");

        let summary = r
            .summary_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<ghostping::audit_storage::AuditSummary>(s).ok());

        if let Some(s) = summary {
            let coverage = if s.failed_queries > 0 {
                format!(" ({} failed)", s.failed_queries)
                    .yellow()
                    .to_string()
            } else {
                String::new()
            };
            println!(
                "  {} Run {} — {:.0}% mentioned — {}/{}/{} — {}{}{}",
                status_icon,
                r.id.to_string().cyan(),
                s.mention_rate * 100.0,
                r.started_at.split('T').next().unwrap_or("-").dimmed(),
                format!("{} samples", r.samples_per_prompt).dimmed(),
                format!("{:.1} temp", r.temperature).dimmed(),
                r.status.dimmed(),
                coverage,
                if is_mock {
                    " [mock test data]".yellow().to_string()
                } else {
                    String::new()
                },
            );
        } else {
            println!(
                "  {} Run {} — {} — {}{}",
                status_icon,
                r.id.to_string().cyan(),
                r.started_at.split('T').next().unwrap_or("-").dimmed(),
                r.status.dimmed(),
                if is_mock {
                    " [mock test data]".yellow().to_string()
                } else {
                    String::new()
                },
            );
        }
    }
    println!();

    Ok(())
}

fn run_audit_show(storage: &AuditStorage, id: i64) -> Result<()> {
    let run = storage.get_audit_run(id)?;
    let results = storage.get_audit_results(id)?;

    match run {
        Some(r) => {
            println!();
            println!(
                "  {} Audit Run {}",
                "→".cyan(),
                r.id.to_string().cyan().bold()
            );
            println!();
            println!("  Project:     {}", r.project_id.cyan());
            println!("  Started:     {}", r.started_at.dimmed());
            println!("  Status:      {}", r.status);
            println!("  Samples:     {}", r.samples_per_prompt);
            println!("  Temperature: {:.2}", r.temperature);
            println!();
            println!("  Results:     {} row(s)", results.len());

            if r.provider_models_json.to_lowercase().contains("mock") {
                println!();
                println!("  {}  {}", "⚠".yellow().bold(), MOCK_AUDIT_NOTICE.yellow());
            }

            // Surface explicit planned/successful/failed counts plus any
            // failure diagnostics so partial runs are never misread.
            // Prefer a live recomputation so runs recorded by older
            // versions (old summary JSON, no error rows) still show
            // correct coverage under the current metric definitions.
            let errors = storage.get_audit_errors(id).unwrap_or_default();
            let live_summary = storage.get_audit_summary(id).ok();
            let stored_summary = r.summary_json.as_deref().and_then(|s| {
                serde_json::from_str::<ghostping::audit_storage::AuditSummary>(s).ok()
            });
            if let Some(summary) = live_summary.as_ref().or(stored_summary.as_ref()) {
                println!();
                println!(
                    "  Coverage:    {}/{} planned queries succeeded{}",
                    summary.successful_queries,
                    summary.planned_queries,
                    if summary.failed_queries > 0 {
                        format!(" ({} failed)", summary.failed_queries)
                    } else {
                        String::new()
                    }
                );
                println!(
                    "  Citations:   {} extracted ({} project-domain) in {} responses",
                    summary.citation_count,
                    summary.project_citation_count,
                    summary.citation_response_count
                );
            } else if !errors.is_empty() {
                println!();
                println!("  Coverage:    {} recorded querie(s) failed", errors.len());
            }
            if !errors.is_empty() {
                println!();
                println!("  {} Query failures ({}):", "Failures".bold(), errors.len());
                for e in errors.iter().take(10) {
                    println!(
                        "    {} [{}] sample {}: {}",
                        "·".dimmed(),
                        e.provider.cyan(),
                        e.sample_index + 1,
                        e.error.dimmed()
                    );
                }
                if errors.len() > 10 {
                    println!("    {} ... and {} more", "·".dimmed(), errors.len() - 10);
                }
            }
            println!();
        }
        None => {
            bail!("Audit run {} not found.", id);
        }
    }

    Ok(())
}

async fn run_report2(
    project: &ProjectConfig,
    storage: &AuditStorage,
    run: Option<i64>,
    format: &str,
    output: PathBuf,
    full: bool,
    force: bool,
) -> Result<()> {
    if format != "markdown" {
        bail!(
            "Unsupported report format '{}': only 'markdown' is supported.",
            format
        );
    }
    // Get audit run ID
    let run_id = match run {
        Some(id) => id,
        None => {
            let runs = storage.list_audit_runs(&project.domain(), 1)?;
            runs.first()
                .map(|r| r.id)
                .ok_or_else(|| anyhow::anyhow!("No audit runs found"))?
        }
    };

    // Generate report directly using storage methods
    let report = generate_markdown_report(project, storage, run_id, full)?;

    // Write to file
    if !output.exists() {
        std::fs::create_dir_all(&output)?;
    }

    let filename = generate_report_filename(&project.project.name, run_id);
    let path = output.join(&filename);

    if path.exists() && !force {
        println!(
            "\n  {} Report {} already exists",
            "!".yellow(),
            path.display().to_string().dimmed()
        );
        println!("  Use {} to overwrite\n", "--force".cyan());
        return Ok(());
    }

    std::fs::write(&path, &report)?;

    println!();
    println!(
        "  {} Generated report: {}",
        "✓".green().bold(),
        path.display().to_string().cyan()
    );
    println!();

    Ok(())
}

fn run_generate2(
    project: &ProjectConfig,
    storage: &AuditStorage,
    from_audit: &str,
    output_dir: PathBuf,
    force: bool,
) -> Result<()> {
    // Get audit run
    let run_id = if from_audit == "latest" {
        let runs = storage.list_audit_runs(&project.domain(), 1)?;
        runs.first()
            .map(|r| r.id)
            .ok_or_else(|| anyhow::anyhow!("No audit runs found"))?
    } else {
        from_audit.parse::<i64>()?
    };

    let results = storage.get_audit_results(run_id)?;

    if results.is_empty() {
        bail!("No results found for audit run {}", run_id);
    }

    // Identify gaps
    let generator = ContentGenerator::new(project.clone());
    let gaps = generator.identify_gaps(&results, &project.competitors.names);

    // Generate assets
    let assets = generator.generate_assets(&gaps);

    // Create output directory
    if !output_dir.exists() {
        std::fs::create_dir_all(&output_dir)?;
    }

    // Write assets
    let mut written = 0;
    for asset in &assets {
        let path = output_dir.join(&asset.filename);

        if path.exists() && !force {
            println!(
                "  {} {} exists (use --force to overwrite)",
                "!".yellow(),
                path.display().to_string().dimmed()
            );
            continue;
        }

        std::fs::write(&path, &asset.content)?;

        // Store in database
        storage.insert_generated_asset(&NewGeneratedAsset {
            project_id: &project.domain(),
            audit_run_id: Some(run_id),
            asset_type: asset.asset_type.as_str(),
            title: &asset.title,
            slug: &asset.slug,
            markdown_content: &asset.content,
        })?;

        println!("  {} {}", "✓".green(), path.display().to_string().cyan());
        written += 1;
    }

    println!();
    println!(
        "  Written {} file(s) to {}",
        written,
        output_dir.display().to_string().cyan()
    );
    println!();

    Ok(())
}

async fn run_compare(storage: &AuditStorage, before: i64, after: i64, format: &str) -> Result<()> {
    if format != "markdown" && format != "json" {
        bail!(
            "Unsupported compare format '{}': use 'markdown' or 'json'.",
            format
        );
    }
    let before_run = storage.get_audit_run(before)?;
    let after_run = storage.get_audit_run(after)?;

    if before_run.is_none() || after_run.is_none() {
        bail!("One or both audit runs not found");
    }
    let before_run = before_run.unwrap();
    let after_run = after_run.unwrap();

    // Warn when the comparison involves synthetic or partial data so it is
    // never mistaken for real-world visibility movement.
    if before_run
        .provider_models_json
        .to_lowercase()
        .contains("mock")
        || after_run
            .provider_models_json
            .to_lowercase()
            .contains("mock")
    {
        println!();
        println!("  {}  {}", "⚠".yellow().bold(), MOCK_AUDIT_NOTICE.yellow());
    }

    let before_summary = storage.get_audit_summary(before)?;
    let after_summary = storage.get_audit_summary(after)?;
    if before_summary.failed_queries > 0 || after_summary.failed_queries > 0 {
        println!();
        println!(
            "  {}  Partial data: run {} has {}/{} failed queries; run {} has {}/{} failed queries.",
            "⚠".yellow().bold(),
            before,
            before_summary.failed_queries,
            before_summary.planned_queries,
            after,
            after_summary.failed_queries,
            after_summary.planned_queries,
        );
    }

    let mention_delta = (after_summary.mention_rate - before_summary.mention_rate) * 100.0;
    let rec_delta =
        (after_summary.recommendation_rate - before_summary.recommendation_rate) * 100.0;
    let cit_delta = (after_summary.citation_rate - before_summary.citation_rate) * 100.0;

    if format == "json" {
        let comparison = serde_json::json!({
            "before_run": before,
            "after_run": after,
            "before": before_summary,
            "after": after_summary,
            "deltas": {
                "mention_rate_pp": mention_delta,
                "recommendation_rate_pp": rec_delta,
                "citation_rate_pp": cit_delta,
            }
        });
        println!("{}", serde_json::to_string_pretty(&comparison)?);
    } else {
        println!();
        println!("  {} Audit Comparison", "→".cyan());
        println!();
        println!(
            "  Before: Run {}  →  After: Run {}",
            before.to_string().cyan(),
            after.to_string().cyan()
        );
        println!();

        let format_delta = |d: f64| {
            if d > 0.0 {
                format!("+{:.1}pp", d).green().to_string()
            } else if d < 0.0 {
                format!("{:.1}pp", d).red().to_string()
            } else {
                "→ 0pp".dimmed().to_string()
            }
        };

        println!(
            "  Mention rate:        {:.1}% → {:.1}%  {}",
            before_summary.mention_rate * 100.0,
            after_summary.mention_rate * 100.0,
            format_delta(mention_delta)
        );
        println!(
            "  Recommendation:      {:.1}% → {:.1}%  {}",
            before_summary.recommendation_rate * 100.0,
            after_summary.recommendation_rate * 100.0,
            format_delta(rec_delta)
        );
        println!(
            "  Citation rate:       {:.1}% → {:.1}%  {}",
            before_summary.citation_rate * 100.0,
            after_summary.citation_rate * 100.0,
            format_delta(cit_delta)
        );
        println!();
    }

    Ok(())
}

fn generate_markdown_report(
    project: &ProjectConfig,
    storage: &AuditStorage,
    run_id: i64,
    _full: bool,
) -> Result<String> {
    use chrono::Utc;

    let run = storage
        .get_audit_run(run_id)?
        .ok_or_else(|| anyhow::anyhow!("Audit run {} not found", run_id))?;

    let results = storage.get_audit_results(run_id)?;
    let summary = storage.get_audit_summary(run_id)?;

    let mut report = String::new();

    // Header
    let mock_notice = if summary.uses_mock_provider() {
        "\n> ⚠ TEST DATA — this audit used the mock provider. Results are \
         synthetic and must not be presented as real-world AI visibility.\n"
    } else {
        ""
    };
    let coverage_note = if summary.failed_queries > 0 {
        format!(
            "\n**Coverage**: {}/{} planned queries succeeded ({} failed) — \
             status `{}`. Metrics cover successful responses only.\n",
            summary.successful_queries, summary.planned_queries, summary.failed_queries, run.status,
        )
    } else {
        format!(
            "\n**Coverage**: {}/{} planned queries succeeded.\n",
            summary.successful_queries, summary.planned_queries
        )
    };
    report.push_str(&format!(
        r#"# Ghostping Evidence Report

## {}
{mock_notice}
**Audit Run**: {}  
**Generated**: {}  
**Status**: {}
{coverage_note}
---

"#,
        project.project.name,
        run.id,
        Utc::now().format("%Y-%m-%d %H:%M UTC"),
        run.status,
        mock_notice = mock_notice,
        coverage_note = coverage_note,
    ));

    // Executive Summary
    let visibility_score = summary.visibility_score();
    report.push_str(&format!(
        r#"## Executive Summary

| Metric | Value |
|--------|-------|
| Visibility Score | {:.1}/100 |
| Mention Rate | {:.1}% ({}/{}) |
| Citation Rate | {:.1}% ({} of {} responses with a project citation; {} extracted, {} project-domain) |
| Recommendation Rate | {:.1}% |
| Total Queries | {} |

**Models Tested**: {}

"#,
        visibility_score,
        summary.mention_rate * 100.0,
        summary.mention_count,
        summary.total_queries,
        summary.citation_rate * 100.0,
        summary.citation_response_count,
        summary.total_queries,
        summary.citation_count,
        summary.project_citation_count,
        summary.recommendation_rate * 100.0,
        summary.total_queries,
        summary.models_used.join(", "),
    ));

    // Results table
    report.push_str("## Results by Model\n\n");
    report.push_str("| Model | Queries | Mentions | Rate |\n");
    report.push_str("|-------|---------|----------|------|\n");

    let mut by_provider: std::collections::HashMap<
        String,
        Vec<&ghostping::audit_storage::AuditResult>,
    > = std::collections::HashMap::new();
    for r in &results {
        by_provider.entry(r.provider.clone()).or_default().push(r);
    }

    for (provider, provider_results) in by_provider {
        let total = provider_results.len();
        let mentions = provider_results
            .iter()
            .filter(|r| r.mentioned_project)
            .count();
        let rate = if total > 0 {
            mentions as f64 / total as f64 * 100.0
        } else {
            0.0
        };
        report.push_str(&format!(
            "| {} | {} | {} | {:.1}% |\n",
            provider, total, mentions, rate
        ));
    }

    report.push('\n');

    // Footer
    let methodology_mock = if summary.uses_mock_provider() {
        "\n**TEST DATA**: this report was generated from mock-provider output. \
         Mock responses are synthetic workflow-validation fixtures, not real AI model output.\n"
    } else {
        ""
    };
    let methodology_partial = if summary.failed_queries > 0 {
        format!(
            "\n**Partial results**: {}/{} planned queries failed; metrics cover successful responses only.\n",
            summary.failed_queries, summary.planned_queries
        )
    } else {
        String::new()
    };
    report.push_str(&format!(r#"---

**Methodology**: Results are based on {} sample(s) per prompt across configured models. AI model behavior is probabilistic and may vary between runs.
{methodology_mock}{methodology_partial}
**Report Generated**: {}

---

_Generated by [Ghostping](https://github.com/commonfields/ghostping) — local-first AI visibility tooling_
"#,
        run.samples_per_prompt,
        Utc::now().format("%Y-%m-%d %H:%M UTC"),
        methodology_mock = methodology_mock,
        methodology_partial = methodology_partial,
    ));

    Ok(report)
}

fn parse_import_report(identity: &str) -> Result<ghostping::observations::ReportIdentity> {
    use ghostping::observations::ReportIdentity;
    match identity {
        "generic-search" => Ok(ReportIdentity::GenericSearch),
        "generative-ai-search" => Ok(ReportIdentity::GenerativeAiSearch),
        "generative-ai-discover" => Ok(ReportIdentity::GenerativeAiDiscover),
        other => bail!(
            "Unknown --report '{}': use generic-search, generative-ai-search, or generative-ai-discover.",
            other
        ),
    }
}

fn parse_import_period(
    date: Option<&str>,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<ghostping::gsc::ImportPeriod> {
    use ghostping::gsc::ImportPeriod;
    match (date, start_date, end_date) {
        (Some(d), None, None) => ImportPeriod::single(d),
        (None, Some(s), Some(e)) => ImportPeriod::range(s, e),
        (Some(_), _, _) => bail!("--date is exclusive with --start-date/--end-date."),
        _ => bail!("Provide --date or both --start-date and --end-date."),
    }
}

fn run_observations_import_gsc(
    project: &ProjectConfig,
    storage: &AuditStorage,
    file: &Path,
    report: &str,
    date: Option<&str>,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<()> {
    let identity = parse_import_report(report)?;
    let period = parse_import_period(date, start_date, end_date)?;
    if !file.exists() {
        bail!("Import file not found: {}", file.display());
    }
    let outcome =
        ghostping::gsc::import_gsc_csv(storage, &project.domain(), file, identity, &period)?;

    println!();
    if outcome.skipped_file {
        println!(
            "  {}  {} already imported for period {} (digest {}…). Nothing to do.",
            "→".cyan(),
            file.display().to_string().cyan(),
            outcome.period.dimmed(),
            &outcome.source_digest[..12.min(outcome.source_digest.len())],
        );
    } else {
        if identity.is_confirmed_ai() {
            println!(
                "  {}  UNVERIFIED AI-report shape: accepted documented dimensions, but no                  genuine authorized sample has validated this layout.",
                "⚠".yellow().bold(),
            );
        }
        println!(
            "  {}  Imported {} row(s) as {} from {} for period {}",
            "✓".green().bold(),
            outcome.imported,
            identity.as_str().cyan(),
            file.display().to_string().cyan(),
            outcome.period.dimmed()
        );
        if outcome.skipped_duplicates > 0 {
            println!(
                "  {}  Skipped {} duplicate row(s) (already present).",
                "→".cyan(),
                outcome.skipped_duplicates
            );
        }
        if outcome.conflicts > 0 {
            println!(
                "  {}  {} conflicting measurement(s): first import kept, conflicts recorded                  as integrity observations. See {}.",
                "⚠".yellow().bold(),
                outcome.conflicts,
                "ghostping observations report".cyan()
            );
        }
    }
    println!();
    Ok(())
}

fn run_observations_import_grounded(
    project: &ProjectConfig,
    storage: &AuditStorage,
    file: &Path,
    prompt: &str,
    group: &str,
) -> Result<()> {
    use ghostping::observations::{
        FailureClass, NewObservation, ObservationType, ReportIdentity, RetrievalMode,
    };
    use ghostping::providers::gemini_grounded::parse_grounded_response;

    if !file.exists() {
        bail!("Import file not found: {}", file.display());
    }
    let bytes = std::fs::read(file)
        .map_err(|e| anyhow::anyhow!("Cannot read {}: {}", file.display(), e))?;
    let json: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| anyhow::anyhow!("Invalid JSON in {}: {}", file.display(), e))?;
    let content = parse_grounded_response(&json)?;

    let (obs_type, mode) = match content.retrieval_mode {
        RetrievalMode::Grounded => (ObservationType::GroundedAnswer, RetrievalMode::Grounded),
        RetrievalMode::Parametric => (ObservationType::ParametricAnswer, RetrievalMode::Parametric),
        RetrievalMode::Unknown => (ObservationType::GroundedAnswer, RetrievalMode::Unknown),
    };
    let resolved = content.resolved_citations();
    let payload = serde_json::json!({
        "requested": {"tool": "google_search", "prompt": prompt, "prompt_group": group},
        "observed": {
            "text": content.text,
            "retrieval_mode": content.retrieval_mode.as_str(),
            "web_search_queries": content.web_search_queries,
            "sources": content.sources.iter().map(|s| match s {
                Some(src) => serde_json::json!({"uri": src.uri, "title": src.title}),
                None => serde_json::Value::Null,
            }).collect::<Vec<_>>(),
            "parts": content.parts.iter().map(|pt| serde_json::json!({
                "part_index": pt.part_index, "text": pt.text,
            })).collect::<Vec<_>>(),
            "spans": content.spans.iter().map(|sp| serde_json::json!({
                "part_index": sp.part_index, "text": sp.text,
                "start_index": sp.start_index,
                "end_index": sp.end_index, "chunk_indices": sp.chunk_indices,
            })).collect::<Vec<_>>(),
            "resolved": resolved.iter().map(|r| serde_json::json!({
                "text": r.text,
                "sources": r.sources.iter().map(|rs| serde_json::json!({
                    "index": rs.index,
                    "status": format!("{:?}", rs.status),
                    "uri": rs.uri,
                })).collect::<Vec<_>>(),
                "span_status": format!("{:?}", r.span_status),
                "attribution": format!("{:?}", r.attribution),
                "fully_attributed": r.fully_attributed(),
                "problems": r.problems,
            })).collect::<Vec<_>>(),
            "response_model": content.response_model,
            "interpretation_version": content.interpretation_version,
        },
        "integrity_flags": content.integrity_flags,
    });
    let dedupe_key = format!(
        "grounded|{}|{}|{}",
        group,
        ghostping::observations::sha256_hex(prompt.as_bytes()),
        ghostping::observations::sha256_hex(&bytes),
    );
    let collected_at = chrono::Utc::now().to_rfc3339();
    let stored = storage.insert_observation(&NewObservation {
        observation_id: None,
        project_id: &project.domain(),
        observation_type: obs_type,
        surface: "gemini-api",
        collected_at: &collected_at,
        provider: Some("gemini"),
        model: content.response_model.as_deref(),
        retrieval_mode: mode,
        region: None,
        language: None,
        prompt_group: Some(group),
        prompt_variant: None,
        url_digest: None,
        planned: 1,
        succeeded: 1,
        failed: 0,
        failure_class: FailureClass::None,
        latency_ms: None,
        cost_usd: None,
        dedupe_key: &dedupe_key,
        report_identity: ReportIdentity::Unknown,
        raw_bytes: &bytes,
        payload: &payload,
    })?;

    println!();
    if stored {
        println!(
            "  {}  Recorded {} observation ({} source(s), {} span(s)) for prompt group '{}'.",
            "✓".green().bold(),
            obs_type.as_str().cyan(),
            content.sources.len(),
            content.spans.len(),
            group.cyan()
        );
        if !content.integrity_flags.is_empty() {
            println!(
                "  {}  {} integrity flag(s):",
                "⚠".yellow().bold(),
                content.integrity_flags.len()
            );
            for flag in content.integrity_flags.iter().take(5) {
                println!("    {} {}", "·".dimmed(), flag.dimmed());
            }
        }
    } else {
        println!(
            "  {}  Identical recording already present. Nothing to do.",
            "→".cyan()
        );
    }
    println!();
    Ok(())
}

fn render_int_value(value: Option<i64>, sem: ghostping::gsc::ValueSemantics) -> String {
    use ghostping::gsc::ValueSemantics;
    match (value, sem) {
        (None, _) => "unknown".to_string(),
        (Some(0), ValueSemantics::Reported) => "0 (reported by source)".to_string(),
        (Some(v), _) => v.to_string(),
    }
}

fn run_observations_report(project: &ProjectConfig, storage: &AuditStorage) -> Result<()> {
    use ghostping::observation_views::{
        summarize_first_party, summarize_provenance, summarize_retrieval, summarize_sampled,
    };
    use ghostping::observations::{ObservationType, ReportIdentity};

    let domain = project.domain();
    let all_gsc =
        storage.list_observations(&domain, Some(ObservationType::SearchConsoleAggregate))?;
    let sections = summarize_first_party(&all_gsc);

    let grounded_all = storage.list_observations(&domain, Some(ObservationType::GroundedAnswer))?;
    let parametric_all =
        storage.list_observations(&domain, Some(ObservationType::ParametricAnswer))?;
    let mut retrieval_rows = grounded_all.clone();
    retrieval_rows.extend(parametric_all.clone());
    let retrieval = summarize_retrieval(&retrieval_rows);
    let integrity_rows = storage.list_observations(&domain, Some(ObservationType::Integrity))?;

    let mut all_obs = all_gsc.clone();
    all_obs.extend(grounded_all.clone());
    all_obs.extend(parametric_all.clone());
    all_obs.extend(integrity_rows.clone());
    let provenance = summarize_provenance(&all_obs);

    let runs = storage.list_audit_runs(&domain, 1000)?;
    let mut summaries = Vec::new();
    for r in &runs {
        summaries.push(storage.get_audit_summary(r.id)?);
    }
    let sampled = summarize_sampled(&summaries);

    println!();
    println!(
        "  {} Observations Report — {}",
        "→".cyan(),
        project.project.name.cyan().bold()
    );
    println!();

    // ── First-party sections: conventional, AI search, AI discover, unknown.
    if sections.is_empty() {
        println!("  First-party Google Search Console (0 rows)");
        println!(
            "    {} No first-party observations. Import an authorized export:",
            "·".dimmed()
        );
        println!(
            "      {}",
            "ghostping observations import-gsc --file Queries.csv --report generic-search --date YYYY-MM-DD"
                .cyan()
        );
    }
    for section in &sections {
        let title = match section.identity {
            ReportIdentity::GenericSearch => "Conventional Google Search".to_string(),
            ReportIdentity::GenerativeAiSearch => {
                "Generative-AI Search (UNVERIFIED export shape)".to_string()
            }
            ReportIdentity::GenerativeAiDiscover => {
                "Generative-AI Discover (UNVERIFIED export shape)".to_string()
            }
            ReportIdentity::Unknown => "Unverified origin (excluded from AI metrics)".to_string(),
        };
        println!("  {} ({} row(s))", title, section.row_count);
        if section.identity.is_confirmed_ai() {
            println!(
                "    {} User-declared AI export; layout not validated against a genuine sample.",
                "⚠".yellow()
            );
        }
        for slice in &section.slices {
            // One slice = one exact dimension signature. Slices are reported
            // side by side and never added: no cross-breakdown totals exist.
            println!(
                "    breakdown: {} ({} row(s))",
                slice.dims.join(" × ").dimmed(),
                slice.rows.len()
            );
            let mut top = slice.rows.clone();
            top.sort_by(|a, b| {
                b.impressions
                    .value
                    .unwrap_or(0)
                    .cmp(&a.impressions.value.unwrap_or(0))
            });
            for row in top.iter().take(5) {
                let dims = row
                    .dims
                    .iter()
                    .map(|(k, v)| {
                        format!(
                            "{}={}",
                            k.dimmed(),
                            ghostping::types::truncate_chars(v, 48).cyan()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                let clicks = match &row.clicks {
                    Some(c) => format!("{} clicks", render_int_value(c.value, c.semantics)),
                    None => "clicks n/a (no clicks column)".to_string(),
                };
                let ctr = match &row.ctr {
                    Some(c) => format!(
                        "CTR {}",
                        if c.value.is_none() {
                            "unknown".to_string()
                        } else {
                            format!("{:.2}%", c.value.unwrap_or(0.0) * 100.0)
                        }
                    ),
                    None => "CTR n/a".to_string(),
                };
                let pos = match &row.position {
                    Some(p) => format!(
                        "position {}",
                        if p.value.is_none() {
                            "unknown".to_string()
                        } else {
                            format!("{:.1}", p.value.unwrap_or(0.0))
                        }
                    ),
                    None => "position n/a".to_string(),
                };
                println!(
                    "      {} — {} impressions, {}, {}, {}",
                    dims,
                    render_int_value(row.impressions.value, row.impressions.semantics).cyan(),
                    clicks.dimmed(),
                    ctr.dimmed(),
                    pos.dimmed()
                );
            }
        }
    }
    println!();

    // ── Retrieval split with three denominators + inspectable citations.
    let total_retrieval = retrieval.grounded + retrieval.parametric + retrieval.unknown;
    println!("  Model API observations ({} total)", total_retrieval);
    println!("    Grounded:   {}", retrieval.grounded);
    println!("    Parametric: {}", retrieval.parametric);
    println!("    Unknown:    {}", retrieval.unknown);
    for env in grounded_all.iter().take(5) {
        let group = env.prompt_group.as_deref().unwrap_or("unknown");
        let queries = env
            .payload
            .pointer("/observed/web_search_queries")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|q| q.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_default();
        println!(
            "      {} [{}] queries: {}",
            format!("[{}]", env.retrieval_mode.as_str()).dimmed(),
            group.cyan(),
            if queries.is_empty() {
                "unknown".to_string()
            } else {
                queries
            }
            .dimmed()
        );
        if let Some(resolved) = env
            .payload
            .pointer("/observed/resolved")
            .and_then(|v| v.as_array())
        {
            for r in resolved.iter().take(5) {
                let text = r.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let attribution = r
                    .get("attribution")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown");
                let uris = r
                    .get("sources")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|s| {
                                (s.get("status").and_then(|v| v.as_str()) == Some("Valid"))
                                    .then(|| s.get("uri"))
                                    .flatten()
                                    .and_then(|u| u.as_str())
                            })
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                // Attribution states stay explicit: verified / partial /
                // unknown. Uncertainty is never upgraded to a checkmark.
                let (icon, state) = match attribution {
                    "Verified" => ("✓".green(), "verified citation".to_string()),
                    "Partial" => (
                        "◐".yellow(),
                        format!(
                            "partial citation ({})",
                            if uris.is_empty() {
                                "no valid source".to_string()
                            } else {
                                uris.clone()
                            }
                        ),
                    ),
                    _ => ("⚠".yellow(), "unknown attribution".to_string()),
                };
                println!(
                    "        {} {} → {}",
                    icon,
                    ghostping::types::truncate_chars(text, 48).dimmed(),
                    if attribution == "Verified" {
                        uris.cyan().to_string()
                    } else {
                        state.dimmed().to_string()
                    }
                );
            }
        }
    }
    if !integrity_rows.is_empty() {
        println!(
            "    {} {} integrity flag(s) (conflicts, invalid references):",
            "⚠".yellow(),
            integrity_rows.len()
        );
        for row in integrity_rows.iter().take(5) {
            println!(
                "      {} {}",
                "·".dimmed(),
                row.payload.to_string().dimmed()
            );
        }
    }
    println!();

    // ── Provenance: mock/test origins never merge with real providers.
    println!("  Provenance (surface × provider × model)");
    if provenance.is_empty() {
        println!("    {} none recorded", "·".dimmed());
    }
    for p in &provenance {
        println!(
            "    {} / {} / {} — {}",
            p.surface.cyan(),
            p.provider.dimmed(),
            p.model.dimmed(),
            p.count
        );
    }
    println!();

    // ── Sampled section: separate denominator over succeeded responses.
    let mock_note = if sampled.includes_mock {
        " [includes MOCK test data]"
    } else {
        ""
    };
    println!(
        "  Sampled API evidence ({} audit run(s), {} planned queries){}",
        sampled.runs,
        sampled.planned,
        mock_note.yellow()
    );
    if sampled.runs == 0 {
        println!(
            "    {} No sampled audits. Run {}.",
            "·".dimmed(),
            "ghostping audit run".cyan()
        );
    } else {
        println!(
            "    Coverage: {}/{} succeeded{}",
            sampled.succeeded,
            sampled.planned,
            if sampled.failed > 0 {
                format!(" ({} failed)", sampled.failed)
            } else {
                String::new()
            }
        );
        match sampled.mention_rate {
            Some(r) => println!(
                "    Mention rate: {:.1}% ({}/{} succeeded responses)",
                r * 100.0,
                sampled.mentions,
                sampled.succeeded
            ),
            None => println!("    Mention rate: unknown (no succeeded responses)"),
        }
        match sampled.citation_response_rate {
            Some(r) => println!(
                "    Project-citation response rate: {:.1}% ({}/{} succeeded responses; {} total citations, {} project)",
                r * 100.0, sampled.cited_responses, sampled.succeeded,
                sampled.total_citations, sampled.project_citations
            ),
            None => println!("    Project-citation response rate: unknown (no succeeded responses)"),
        }
        for r in &runs {
            let summary = storage.get_audit_summary(r.id)?;
            let mock_tag = if summary.uses_mock_provider() {
                " [mock test data]".yellow().to_string()
            } else {
                String::new()
            };
            println!(
                "      Run {} — {} — {:.1}% mentioned{}{}",
                r.id.to_string().cyan(),
                r.status.dimmed(),
                summary.mention_rate * 100.0,
                if summary.failed_queries > 0 {
                    format!(" ({} failed)", summary.failed_queries)
                } else {
                    String::new()
                },
                mock_tag
            );
        }
    }
    println!();
    println!(
        "  {}",
        "Sections keep separate denominators — never pooled. No visibility score, no causal claims."
            .dimmed()
    );
    println!();

    Ok(())
}

async fn run_diagnose2(url: &str) -> Result<()> {
    use reqwest::Client;

    println!();
    println!("  {} Diagnosing {}", "→".cyan(), url.cyan().bold());
    println!();

    let client = Client::new();

    // Check main URL
    let main_res = client.get(url).send().await;
    match main_res {
        Ok(r) if r.status().is_success() => {
            println!(
                "  {} Homepage reachable ({})",
                "✓".green(),
                r.status().to_string().dimmed()
            );
        }
        Ok(r) => {
            println!("  {} Homepage returned {}", "!".yellow(), r.status());
        }
        Err(e) => {
            println!("  {} Homepage unreachable: {}", "✗".red(), e);
        }
    }

    // Check robots.txt
    let robots_url = format!("{}/robots.txt", url.trim_end_matches('/'));
    match client.get(&robots_url).send().await {
        Ok(r) if r.status().is_success() => {
            println!("  {} robots.txt exists", "✓".green());
        }
        _ => {
            println!("  {} robots.txt not found (recommended)", "○".dimmed());
        }
    }

    // Check sitemap.xml
    let sitemap_url = format!("{}/sitemap.xml", url.trim_end_matches('/'));
    match client.get(&sitemap_url).send().await {
        Ok(r) if r.status().is_success() => {
            println!("  {} sitemap.xml exists", "✓".green());
        }
        _ => {
            println!(
                "  {} sitemap.xml not found (recommended for SEO)",
                "○".dimmed()
            );
        }
    }

    // Check for llms.txt
    let llms_url = format!("{}/llms.txt", url.trim_end_matches('/'));
    match client.get(&llms_url).send().await {
        Ok(r) if r.status().is_success() => {
            println!("  {} llms.txt exists", "✓".green());
        }
        _ => {
            println!(
                "  {} llms.txt not found (generate with: ghostping generate)",
                "○".dimmed()
            );
        }
    }

    println!();
    println!("  Note: This checks basic crawlability only.");
    println!("  AI visibility depends on content quality, training data, and model behavior.");
    println!();

    Ok(())
}
