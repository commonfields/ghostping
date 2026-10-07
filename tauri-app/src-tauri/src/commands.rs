use openrecord::{
    agent::optimizer::{self, OptimizeOptions},
    cache::Cache,
    config::Config,
    geo::generator::{self, GenerateOptions},
    storage::Storage,
    tracker::{self, TrackOptions},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

// ── Helper types returned to the frontend ────────────────────────────────────

#[derive(Serialize)]
pub struct AuditResult {
    pub domain: String,
    pub mention_rate: f64,
    pub mention_count: usize,
    pub total_queries: usize,
    pub citation_count: usize,
    pub models_with_mention: Vec<String>,
}

#[derive(Serialize)]
pub struct GenerateResult {
    pub model: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct OptimizeResult {
    pub domain: String,
    pub niche: String,
    pub current_mention_rate: f64,
    pub avg_citability: f64,
    pub sections: Vec<SectionResult>,
}

#[derive(Serialize)]
pub struct SectionResult {
    pub prompt: String,
    pub content: String,
    pub model: String,
    pub citability_rate: f64,
    pub file_name: String,
}

#[derive(Serialize, Deserialize)]
pub struct ProjectEntry {
    pub domain: String,
    pub niche: Option<String>,
    pub notes: Option<String>,
    pub last_audited: Option<String>,
}

// ── State helpers ────────────────────────────────────────────────────────────

fn open_storage() -> Result<Storage, String> {
    let (base_dir, _) = Config::ensure_dir().map_err(|e| e.to_string())?;
    Storage::open(&base_dir).map_err(|e| e.to_string())
}

fn open_cache() -> Result<Cache, String> {
    let (base_dir, _) = Config::ensure_dir().map_err(|e| e.to_string())?;
    Cache::new(&base_dir).map_err(|e| e.to_string())
}

fn load_providers(models: Option<String>) -> Result<Vec<Arc<dyn openrecord::providers::LlmProvider>>, String> {
    let config = Config::load().map_err(|e| e.to_string())?;
    Ok(tracker::build_providers_filtered(&config, models.as_deref()))
}

// ── Commands ─────────────────────────────────────────────────────────────────

// Tauri sends async-command futures across threads, but rusqlite handles are
// !Send. The three commands below therefore stay synchronous (Tauri runs sync
// commands on its blocking pool) and drive their async bodies on a
// single-thread runtime.
fn block_on_local<F, T>(fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tauri command: failed to build local runtime")
        .block_on(fut)
}

#[tauri::command]
pub fn run_audit(
    domain: String,
    niche: Option<String>,
    models: Option<String>,
) -> Result<AuditResult, String> {
    block_on_local(run_audit_async(domain, niche, models))
}

async fn run_audit_async(
    domain: String,
    niche: Option<String>,
    models: Option<String>,
) -> Result<AuditResult, String> {
    let providers = load_providers(models)?;
    if providers.is_empty() {
        return Err("No providers enabled. Configure at least one in ~/.openrecord/config.toml".into());
    }
    let storage = open_storage()?;
    let cache = open_cache()?;
    let config = Config::load().map_err(|e| e.to_string())?;
    let prompts = openrecord::geo::prompts::default_prompts(&domain, niche.as_deref(), None);

    let summary = tracker::run_track(
        &domain,
        prompts,
        providers,
        &storage,
        &cache,
        TrackOptions {
            verbose: false,
            concurrency: config.defaults.concurrency,
            judge: None,
            quiet: true,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    let _ = storage.touch_project_last_audited(&domain);

    Ok(AuditResult {
        mention_rate: summary.mention_rate(),
        domain: summary.domain,
        mention_count: summary.mention_count,
        total_queries: summary.total_queries,
        citation_count: summary.citation_count,
        models_with_mention: summary.models_with_mention,
    })
}

#[tauri::command]
pub fn run_generate(
    prompt: String,
    about: Option<String>,
    niche: Option<String>,
    models: Option<String>,
) -> Result<Vec<GenerateResult>, String> {
    block_on_local(run_generate_async(prompt, about, niche, models))
}

async fn run_generate_async(
    prompt: String,
    about: Option<String>,
    niche: Option<String>,
    models: Option<String>,
) -> Result<Vec<GenerateResult>, String> {
    let providers = load_providers(models)?;
    if providers.is_empty() {
        return Err("No providers enabled.".into());
    }
    let opts = GenerateOptions {
        prompt,
        about: about.unwrap_or_default(),
        niche: niche.unwrap_or_else(|| "general".into()),
        verbose: false,
        system_prompt_override: None,
    };
    let results = generator::generate(&opts, &providers)
        .await
        .map_err(|e| e.to_string())?;

    Ok(results
        .into_iter()
        .map(|r| GenerateResult { model: r.model, content: r.content })
        .collect())
}

#[tauri::command]
pub fn run_optimize(
    domain: String,
    niche: String,
    competitors: Option<String>,
    steps: Option<usize>,
    models: Option<String>,
) -> Result<OptimizeResult, String> {
    block_on_local(run_optimize_async(domain, niche, competitors, steps, models))
}

async fn run_optimize_async(
    domain: String,
    niche: String,
    competitors: Option<String>,
    steps: Option<usize>,
    models: Option<String>,
) -> Result<OptimizeResult, String> {
    let providers = load_providers(models)?;
    if providers.is_empty() {
        return Err("No providers enabled.".into());
    }
    let storage = open_storage()?;
    let cache = open_cache()?;

    let competitors_list: Vec<String> = competitors
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect();

    let opts = OptimizeOptions {
        domain: domain.clone(),
        niche: niche.clone(),
        competitors: competitors_list,
        steps: steps.unwrap_or(3),
        max_rounds: 3,
        dry_run: false,
        verbose: false,
        quiet: true,
        generate_template_override: None,
        discover_template_override: None,
    };

    let plan = optimizer::optimize(&opts, &providers, &storage, &cache)
        .await
        .map_err(|e| e.to_string())?;

    let _ = storage.touch_project_last_audited(&domain);

    Ok(OptimizeResult {
        avg_citability: plan.avg_citability(),
        current_mention_rate: plan.current_mention_rate,
        domain: plan.domain,
        niche: plan.niche,
        sections: plan
            .sections
            .into_iter()
            .map(|s| SectionResult {
                prompt: s.prompt,
                content: s.content,
                model: s.model,
                citability_rate: s.citability_rate,
                file_name: s.file_name,
            })
            .collect(),
    })
}

#[tauri::command]
pub fn list_projects() -> Result<Vec<ProjectEntry>, String> {
    let storage = open_storage()?;
    let projects = storage.list_projects().map_err(|e| e.to_string())?;
    Ok(projects
        .into_iter()
        .map(|p| ProjectEntry {
            domain: p.domain,
            niche: p.niche,
            notes: p.notes,
            last_audited: p.last_audited,
        })
        .collect())
}

#[tauri::command]
pub fn add_project(domain: String, niche: Option<String>, notes: Option<String>) -> Result<(), String> {
    let storage = open_storage()?;
    storage
        .upsert_project(&domain, niche.as_deref(), notes.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_project(domain: String) -> Result<bool, String> {
    let storage = open_storage()?;
    storage.remove_project(&domain).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_config() -> Result<String, String> {
    let config = Config::load().map_err(|e| e.to_string())?;
    serde_json::to_string(&config).map_err(|e| e.to_string())
}
