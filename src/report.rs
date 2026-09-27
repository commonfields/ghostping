use colored::Colorize;
use comfy_table::{Attribute, Cell, Color, ContentArrangement, Table};

use crate::{
    agent::plan::OptimizationPlan,
    geo::{evaluator::EvalDelta, generator::GenerateResult},
    storage::{DomainDayStat, PublishSnapshot},
    types::{MentionResult, Position, Sentiment, TrackSummary},
};

pub fn print_summary(summary: &TrackSummary, prev_rate: Option<f64>) {
    println!();
    println!("{}", "━".repeat(64).dimmed());
    println!(
        "  {}  {}",
        "Ghostping Report:".bold(),
        summary.domain.cyan().bold()
    );
    println!(
        "  {}",
        format!(
            "Legacy workflow ({}) — for evidence audits use `ghostping audit run`.",
            summary.source
        )
        .dimmed()
    );
    println!("{}", "━".repeat(64).dimmed());

    let rate = summary.mention_rate();

    // One-line headline with optional trend
    let trend = match prev_rate {
        Some(prev) if summary.total_queries > 0 => {
            let delta = rate - prev;
            if delta > 2.0 {
                format!("  (↑ {:.0}pp vs last run)", delta)
                    .green()
                    .to_string()
            } else if delta < -2.0 {
                format!("  (↓ {:.0}pp vs last run)", delta.abs())
                    .red()
                    .to_string()
            } else {
                "  (→ flat vs last run)".dimmed().to_string()
            }
        }
        _ => String::new(),
    };

    let rate_str = format!("{:.0}%", rate);
    let rate_colored = if rate >= 60.0 {
        rate_str.green().bold()
    } else if rate >= 30.0 {
        rate_str.yellow().bold()
    } else {
        rate_str.red().bold()
    };

    let all_models: Vec<String> = {
        let mut m: Vec<String> = summary.results.iter().map(|r| r.model.clone()).collect();
        m.sort();
        m.dedup();
        m
    };

    println!();
    println!(
        "  Mention rate   {}  ({}/{} queries){}",
        rate_colored, summary.mention_count, summary.total_queries, trend
    );
    println!("  Citations      {}", summary.citation_count);
    println!(
        "  Models         {}/{}  ({})",
        summary.models_with_mention.len(),
        all_models.len(),
        if summary.models_with_mention.is_empty() {
            "none mentioned".red().to_string()
        } else {
            summary.models_with_mention.join(", ").cyan().to_string()
        }
    );
    println!();

    print_results_table(&summary.results);
    println!();
    print_geo_tips(summary);
    println!();
}

fn print_results_table(results: &[MentionResult]) {
    let mut table = Table::new();
    table.set_content_arrangement(ContentArrangement::Dynamic);
    table.set_header(vec![
        Cell::new("Model").add_attribute(Attribute::Bold),
        Cell::new("Prompt").add_attribute(Attribute::Bold),
        Cell::new("Mentioned").add_attribute(Attribute::Bold),
        Cell::new("Cited").add_attribute(Attribute::Bold),
        Cell::new("Position").add_attribute(Attribute::Bold),
        Cell::new("Sentiment").add_attribute(Attribute::Bold),
    ]);
    for r in results {
        table.add_row(vec![
            Cell::new(&r.model).fg(Color::Cyan),
            Cell::new(truncate(&r.prompt, 44)),
            bool_cell(r.mentioned, "Yes", "No"),
            if r.cited {
                Cell::new("Yes").fg(Color::Green)
            } else {
                Cell::new("—").fg(Color::DarkGrey)
            },
            position_cell(&r.position),
            sentiment_cell(&r.sentiment),
        ]);
    }
    println!("{table}");
}

fn print_geo_tips(summary: &TrackSummary) {
    let rate = summary.mention_rate();
    let total = summary.total_queries;
    let citation_rate = if total == 0 {
        0.0
    } else {
        summary.citation_count as f64 / total as f64 * 100.0
    };

    println!("  {}", "Actionable GEO Tips:".bold());

    // Visibility level
    if rate == 0.0 {
        tip(
            "red",
            "Not found in any response. Publish a dedicated product page that",
        );
        tip(
            "red",
            "  answers 'what is X', 'how X works', and 'X vs alternatives'.",
        );
        tip(
            "red",
            "  Use the exact brand name in H1 and the first sentence.",
        );
    } else if rate < 30.0 {
        tip(
            "yellow",
            "Low visibility. Add a short, factual 'entity definition' paragraph",
        );
        tip(
            "yellow",
            "  at the top of your README/docs — LLMs extract these as summaries.",
        );
        tip(
            "yellow",
            "  Keep it: '<Brand> is a <category> that <does X> for <audience>.'",
        );
    } else if rate < 60.0 {
        tip(
            "yellow",
            "Moderate visibility. Lead every major doc section with the direct",
        );
        tip(
            "yellow",
            "  answer (inverted-pyramid). Publish explicit comparison pages",
        );
        tip(
            "yellow",
            "  (e.g. 'MyTool vs Competitor') — they rank well in LLM citations.",
        );
    } else {
        tip(
            "green",
            "Strong visibility. Focus on citation quality: add authoritative",
        );
        tip(
            "green",
            "  links, structured data, and clear versioned changelogs so models",
        );
        tip(
            "green",
            "  can surface your latest release with confidence.",
        );
    }

    // Citation gap
    if citation_rate == 0.0 && rate > 0.0 {
        println!();
        tip(
            "yellow",
            "No direct link citations found. Ensure your domain appears as a",
        );
        tip(
            "yellow",
            "  plain URL in key pages (e.g. 'Install from https://yourdomain.io')",
        );
        tip(
            "yellow",
            "  and submit your site to relevant directories and package registries.",
        );
    }

    // Position quality
    let bottom_heavy = summary
        .results
        .iter()
        .filter(|r| r.mentioned && matches!(r.position, Position::Bottom))
        .count();
    if summary.mention_count > 0 && bottom_heavy * 2 > summary.mention_count {
        println!();
        tip(
            "yellow",
            "Brand appears mostly at the bottom of responses. Add structured",
        );
        tip(
            "yellow",
            "  feature tables and a quick comparison chart to your front page —",
        );
        tip(
            "yellow",
            "  LLMs tend to cite content that appears early in their training.",
        );
    }

    // Sentiment gap
    let negative = summary
        .results
        .iter()
        .filter(|r| r.mentioned && matches!(r.sentiment, Sentiment::Negative))
        .count();
    if negative > summary.mention_count / 3 && negative > 0 {
        println!();
        tip(
            "red",
            "Some mentions carry negative context. Review which prompts trigger",
        );
        tip(
            "red",
            "  negative responses and publish clear docs addressing those concerns",
        );
        tip("red", "  (e.g. stability, maintenance status, licensing).");
    }
}

fn tip(level: &str, msg: &str) {
    let prefix = match level {
        "green" => "  ✓".green().bold(),
        "red" => "  ✗".red().bold(),
        _ => "  →".yellow().bold(),
    };
    println!("{}  {}", prefix, msg);
}

pub fn print_trend_report(domain: &str, results: &[MentionResult], days: u32) {
    println!();
    println!("{}", "━".repeat(64).dimmed());
    println!(
        "  {}  {} — last {} days",
        "Trend Report:".bold(),
        domain.cyan().bold(),
        days
    );
    println!("{}", "━".repeat(64).dimmed());

    if results.is_empty() {
        println!(
            "\n  No data found. Run {} first.\n",
            format!("ghostping track {}", domain).cyan()
        );
        return;
    }

    let total = results.len();
    let mentioned = results.iter().filter(|r| r.mentioned).count();
    let cited = results.iter().filter(|r| r.cited).count();

    println!();
    println!("  Total queries  {}", total.to_string().bold());
    println!(
        "  Mentions       {} ({:.0}%)",
        mentioned,
        mentioned as f64 / total as f64 * 100.0
    );
    println!("  Citations      {}", cited);
    println!();

    let mut models: Vec<String> = results.iter().map(|r| r.model.clone()).collect();
    models.sort();
    models.dedup();

    let mut table = Table::new();
    table.set_content_arrangement(ContentArrangement::Dynamic);
    table.set_header(vec!["Model", "Queries", "Mentions", "Rate", "Citations"]);
    for model in &models {
        let mr: Vec<&MentionResult> = results.iter().filter(|r| &r.model == model).collect();
        let q = mr.len();
        let m = mr.iter().filter(|r| r.mentioned).count();
        let c = mr.iter().filter(|r| r.cited).count();
        let r = m as f64 / q as f64;
        let rate_str = format!("{:.0}%", r * 100.0);
        let rate_cell = if r >= 0.6 {
            Cell::new(rate_str).fg(Color::Green)
        } else if r >= 0.3 {
            Cell::new(rate_str).fg(Color::Yellow)
        } else {
            Cell::new(rate_str).fg(Color::Red)
        };
        table.add_row(vec![
            Cell::new(model).fg(Color::Cyan),
            Cell::new(q),
            Cell::new(m),
            rate_cell,
            Cell::new(c),
        ]);
    }
    println!("{table}");
    println!();
}

/// Export results as a Markdown table string.
pub fn export_markdown(results: &[MentionResult], domain: &str) -> String {
    let mut out = format!("# Ghostping Report — {}\n\n", domain);
    out.push_str("| Model | Prompt | Mentioned | Cited | Position | Sentiment |\n");
    out.push_str("|-------|--------|-----------|-------|----------|-----------|\n");
    for r in results {
        out.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} |\n",
            r.model,
            truncate(&r.prompt, 50),
            if r.mentioned { "Yes" } else { "No" },
            if r.cited { "Yes" } else { "—" },
            r.position,
            r.sentiment,
        ));
    }
    out
}

/// Export results as CSV string.
pub fn export_csv(results: &[MentionResult]) -> String {
    let mut out = String::from("model,prompt,mentioned,cited,position,sentiment,timestamp\n");
    for r in results {
        out.push_str(&format!(
            "{},{},{},{},{},{},{}\n",
            r.model,
            csv_escape(&r.prompt),
            r.mentioned,
            r.cited,
            r.position,
            r.sentiment,
            r.timestamp.to_rfc3339(),
        ));
    }
    out
}

pub fn print_optimization_plan(plan: &OptimizationPlan, dry_run: bool) {
    println!();
    println!("{}", "═".repeat(64).cyan());
    println!(
        "  {}  {}{}",
        "Optimization Plan".bold(),
        plan.domain.cyan().bold(),
        if dry_run {
            "  [dry-run]".yellow().to_string()
        } else {
            String::new()
        }
    );
    println!("{}", "═".repeat(64).cyan());
    println!();

    let lift = plan.projected_lift();
    let current_str = format!("{:.0}%", plan.current_mention_rate);
    let current_colored = if plan.current_mention_rate >= 60.0 {
        current_str.green().bold()
    } else if plan.current_mention_rate >= 30.0 {
        current_str.yellow().bold()
    } else {
        current_str.red().bold()
    };

    println!(
        "  Current visibility    {}  ({} queries across {} topic(s))",
        current_colored,
        plan.total_audit_queries,
        plan.discovered_prompts.len(),
    );

    if !plan.sections.is_empty() {
        let lift_str = format!("+{:.0}pp", lift);
        let avg_cit = format!("{:.0}%", plan.avg_citability());
        println!(
            "  Projected citability  {}  ({} on optimized topics)",
            if lift >= 40.0 {
                avg_cit.green().bold()
            } else if lift >= 20.0 {
                avg_cit.yellow().bold()
            } else {
                avg_cit.red().bold()
            },
            lift_str.green().bold()
        );
    }

    println!();

    if plan.sections.is_empty() {
        println!("  {} No content was generated.\n", "!".yellow());
        return;
    }

    let mut table = Table::new();
    table.set_content_arrangement(ContentArrangement::Dynamic);
    table.set_header(vec![
        Cell::new("Prompt").add_attribute(Attribute::Bold),
        Cell::new("Citability").add_attribute(Attribute::Bold),
        Cell::new("File").add_attribute(Attribute::Bold),
    ]);
    for s in &plan.sections {
        let rate_str = format!("{:.0}%", s.citability_rate);
        let rate_cell = if s.citability_rate >= 70.0 {
            Cell::new(format!("✓ {}", rate_str)).fg(Color::Green)
        } else if s.citability_rate >= 40.0 {
            Cell::new(format!("~ {}", rate_str)).fg(Color::Yellow)
        } else {
            Cell::new(format!("✗ {}", rate_str)).fg(Color::Red)
        };
        table.add_row(vec![
            Cell::new(truncate(&s.prompt, 40)).fg(Color::Cyan),
            rate_cell,
            Cell::new(&s.file_name).fg(Color::DarkGrey),
        ]);
    }
    println!("{table}");
    println!();

    if dry_run {
        println!("  {}", "Generated content preview:".bold());
        println!("{}", "─".repeat(64).dimmed());
        for section in &plan.sections {
            println!();
            println!("  {}  {}", "──".dimmed(), section.prompt.cyan().bold());
            println!("{}", "─".repeat(64).dimmed());
            println!();
            println!("{}", section.content);
            println!();
        }
    } else {
        println!("  {}", "Next steps:".bold());
        let files: Vec<&str> = plan.sections.iter().map(|s| s.file_name.as_str()).collect();
        let file_list = files.join(" ");
        println!(
            "  {}  Review content:  {}",
            "→".cyan(),
            format!("cat {}", files.first().copied().unwrap_or("geo/*.md")).dimmed()
        );
        println!(
            "  {}  Commit:          {}",
            "→".cyan(),
            format!(
                "git add {} && git commit -m \"docs: add GEO-optimized content\"",
                file_list
            )
            .dimmed()
        );
        println!(
            "  {}  Re-audit:        {}",
            "→".cyan(),
            format!(
                "ghostping audit-legacy {} --niche \"{}\"",
                plan.domain, plan.niche
            )
            .dimmed()
        );
    }
    println!();
}

pub fn print_generate_results(results: &[GenerateResult], user_prompt: &str) {
    println!();
    println!("{}", "━".repeat(64).dimmed());
    println!(
        "  {}  {}",
        "Generated Content".bold(),
        format!("\"{}\"", user_prompt).cyan()
    );
    println!("{}", "━".repeat(64).dimmed());

    for result in results {
        println!();
        println!(
            "  {}  {}",
            "──".dimmed(),
            format!("by {}", result.model).cyan().bold()
        );
        println!("{}", "─".repeat(64).dimmed());
        println!();
        println!("{}", result.content);
        println!();
    }
}

pub fn print_eval_delta(delta: &EvalDelta, before_stored: Option<f64>) {
    println!("{}", "━".repeat(64).dimmed());
    println!("  {}", "Visibility Estimate".bold());
    println!("{}", "━".repeat(64).dimmed());
    println!();

    let mut table = Table::new();
    table.set_content_arrangement(ContentArrangement::Dynamic);
    table.set_header(vec![
        Cell::new("Model").add_attribute(Attribute::Bold),
        Cell::new("Would Cite?").add_attribute(Attribute::Bold),
        Cell::new("Confidence").add_attribute(Attribute::Bold),
        Cell::new("Reason").add_attribute(Attribute::Bold),
    ]);
    for r in &delta.after {
        let cite_cell = if r.would_cite {
            Cell::new("✓ Yes").fg(Color::Green)
        } else {
            Cell::new("✗ No").fg(Color::Red)
        };
        let conf_str = format!("{:.0}%", r.confidence * 100.0);
        let conf_cell = if r.confidence >= 0.7 {
            Cell::new(conf_str).fg(Color::Green)
        } else if r.confidence >= 0.4 {
            Cell::new(conf_str).fg(Color::Yellow)
        } else {
            Cell::new(conf_str).fg(Color::Red)
        };
        table.add_row(vec![
            Cell::new(&r.model).fg(Color::Cyan),
            cite_cell,
            conf_cell,
            Cell::new(r.reason.as_deref().unwrap_or("—")),
        ]);
    }
    println!("{table}");
    println!();

    let before_display = before_stored.unwrap_or_else(|| delta.before_rate());
    let after_rate = delta.after_rate();
    let delta_val = after_rate - before_display;

    let before_str = format!("{:.0}%", before_display);
    let after_str = format!("{:.0}%", after_rate);
    let delta_str = if delta_val >= 0.0 {
        format!("+{:.0}pp", delta_val).green().bold().to_string()
    } else {
        format!("{:.0}pp", delta_val).red().bold().to_string()
    };

    println!(
        "  Before  {}   After  {}   Delta  {}",
        before_str.dimmed(),
        if after_rate >= 60.0 {
            after_str.green().bold()
        } else if after_rate >= 30.0 {
            after_str.yellow().bold()
        } else {
            after_str.red().bold()
        },
        delta_str
    );
    println!();
}

pub fn print_stats(domain: &str, stats: &[DomainDayStat], days: u32) {
    println!();
    println!("{}", "━".repeat(64).dimmed());
    println!(
        "  {}  {} — last {} days",
        "Stats:".bold(),
        domain.cyan().bold(),
        days
    );
    println!("{}", "━".repeat(64).dimmed());

    if stats.is_empty() {
        println!(
            "\n  No data found. Run {} first.\n",
            format!("ghostping audit-legacy {}", domain).cyan()
        );
        return;
    }

    let total: usize = stats.iter().map(|s| s.total).sum();
    let mentioned: usize = stats.iter().map(|s| s.mentioned).sum();
    let cited: usize = stats.iter().map(|s| s.cited).sum();

    println!();
    println!("  Total queries   {}", total.to_string().bold());
    println!(
        "  Total mentions  {}  ({:.0}%)",
        mentioned,
        mentioned as f64 / total.max(1) as f64 * 100.0
    );
    println!("  Total citations {}", cited);
    println!();

    let mut table = Table::new();
    table.set_content_arrangement(ContentArrangement::Dynamic);
    table.set_header(vec![
        Cell::new("Date").add_attribute(Attribute::Bold),
        Cell::new("Queries").add_attribute(Attribute::Bold),
        Cell::new("Mentions").add_attribute(Attribute::Bold),
        Cell::new("Rate").add_attribute(Attribute::Bold),
        Cell::new("Citations").add_attribute(Attribute::Bold),
    ]);
    for s in stats {
        let rate = s.mentioned as f64 / s.total.max(1) as f64 * 100.0;
        let rate_str = format!("{:.0}%", rate);
        let rate_cell = if rate >= 60.0 {
            Cell::new(rate_str).fg(Color::Green)
        } else if rate >= 30.0 {
            Cell::new(rate_str).fg(Color::Yellow)
        } else {
            Cell::new(rate_str).fg(Color::Red)
        };
        table.add_row(vec![
            Cell::new(&s.day).fg(Color::DarkGrey),
            Cell::new(s.total),
            Cell::new(s.mentioned),
            rate_cell,
            Cell::new(s.cited),
        ]);
    }
    println!("{table}");
    println!();
}

/// Render results as a shareable markdown string.
pub fn render_share_markdown(domain: &str, results: &[MentionResult], days: u32) -> String {
    let total = results.len();
    let mentioned = results.iter().filter(|r| r.mentioned).count();
    let cited = results.iter().filter(|r| r.cited).count();
    let rate = if total == 0 {
        0.0
    } else {
        mentioned as f64 / total as f64 * 100.0
    };

    let now = chrono::Utc::now().format("%Y-%m-%d");
    let mut out = format!("# Ghostping Visibility Report — {}\n\n", domain);
    out.push_str(&format!(
        "Generated: {}  |  Period: last {} days\n\n",
        now, days
    ));
    out.push_str("## Summary\n\n");
    out.push_str(&format!(
        "- **Mention rate:** {:.0}% ({}/{})\n",
        rate, mentioned, total
    ));
    out.push_str(&format!("- **Citations:** {}\n\n", cited));

    out.push_str("## Results\n\n");
    out.push_str("| Model | Prompt | Mentioned | Cited | Position | Sentiment |\n");
    out.push_str("|-------|--------|-----------|-------|----------|-----------|\n");
    for r in results {
        out.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} |\n",
            r.model,
            truncate(&r.prompt, 50),
            if r.mentioned { "Yes" } else { "No" },
            if r.cited { "Yes" } else { "—" },
            r.position,
            r.sentiment,
        ));
    }

    out.push_str("\n---\n\n");
    out.push_str("_Generated by [Ghostping](https://github.com/commonfields/ghostping) — local-first GEO agent_\n");
    out
}

/// Render results as a shareable JSON string.
pub fn render_share_json(domain: &str, results: &[MentionResult], days: u32) -> String {
    let total = results.len();
    let mentioned = results.iter().filter(|r| r.mentioned).count();
    let cited = results.iter().filter(|r| r.cited).count();
    let rate = if total == 0 {
        0.0
    } else {
        mentioned as f64 / total as f64 * 100.0
    };
    let now = chrono::Utc::now().format("%Y-%m-%d");

    serde_json::json!({
        "domain": domain,
        "generated": now.to_string(),
        "period_days": days,
        "summary": {
            "mention_rate": rate,
            "mentioned": mentioned,
            "total": total,
            "cited": cited,
        },
        "results": results.iter().map(|r| serde_json::json!({
            "model": r.model,
            "prompt": r.prompt,
            "mentioned": r.mentioned,
            "cited": r.cited,
            "position": r.position.to_string(),
            "sentiment": r.sentiment.to_string(),
            "timestamp": r.timestamp.to_rfc3339(),
        })).collect::<Vec<_>>(),
    })
    .to_string()
}

pub fn print_results(
    domain: &str,
    snapshots: &[PublishSnapshot],
    current_rate: f64,
    current_mentioned: usize,
    current_total: usize,
    all: bool,
) {
    println!();
    println!("{}", "━".repeat(64).dimmed());
    println!(
        "  {}  {}",
        "Visibility Results:".bold(),
        domain.cyan().bold()
    );
    println!("{}", "━".repeat(64).dimmed());
    println!();

    let display: Vec<&PublishSnapshot> = if all {
        snapshots.iter().collect()
    } else {
        snapshots.iter().take(1).collect()
    };

    for snap in &display {
        let ts = chrono::DateTime::parse_from_rfc3339(&snap.timestamp)
            .map(|dt| dt.format("%Y-%m-%d %H:%M UTC").to_string())
            .unwrap_or_else(|_| snap.timestamp.clone());

        let delta = current_rate - snap.mention_rate;
        let (delta_str, delta_color) = if delta > 2.0 {
            (format!("+{:.0}pp", delta), "green")
        } else if delta < -2.0 {
            (format!("{:.0}pp", delta), "red")
        } else {
            ("~0pp".to_string(), "yellow")
        };

        println!("  {}  {}", "Checkpoint".bold(), ts.dimmed());
        if let Some(note) = &snap.note {
            println!("  {}  {}", "Note:".dimmed(), note);
        }
        println!();

        let mut table = Table::new();
        table.set_content_arrangement(ContentArrangement::Dynamic);
        table.set_header(vec![
            Cell::new("").add_attribute(Attribute::Bold),
            Cell::new("Mention rate").add_attribute(Attribute::Bold),
            Cell::new("Mentions").add_attribute(Attribute::Bold),
            Cell::new("Queries").add_attribute(Attribute::Bold),
        ]);
        table.add_row(vec![
            Cell::new("At publish").fg(Color::DarkGrey),
            Cell::new(format!("{:.0}%", snap.mention_rate)).fg(Color::DarkGrey),
            Cell::new(snap.mention_count).fg(Color::DarkGrey),
            Cell::new(snap.total_queries).fg(Color::DarkGrey),
        ]);
        table.add_row(vec![
            Cell::new("Now (last 7d)").fg(Color::Cyan),
            Cell::new(format!("{:.0}%", current_rate)).fg(Color::Cyan),
            Cell::new(current_mentioned).fg(Color::Cyan),
            Cell::new(current_total).fg(Color::Cyan),
        ]);
        println!("{table}");
        println!();

        let lift_cell = match delta_color {
            "green" => delta_str.green().bold().to_string(),
            "red" => delta_str.red().bold().to_string(),
            _ => delta_str.yellow().bold().to_string(),
        };
        println!("  {}  Lift since publish: {}", "→".cyan(), lift_cell);

        if delta > 2.0 {
            println!(
                "  {}  Mention rate improved — your published content is being cited.",
                "✓".green()
            );
        } else if delta < -2.0 {
            println!(
                "  {}  Mention rate dropped. Re-run optimize and publish updated content.",
                "!".yellow()
            );
        } else {
            println!(
                "  {}  No significant change yet. Models may not have been retrained.",
                "~".dimmed()
            );
            println!("       Wait a few more days and re-audit.");
        }
        println!();
    }

    if !all && snapshots.len() > 1 {
        println!(
            "  {}  {} older checkpoint(s) — run {} to see all.\n",
            "→".cyan(),
            snapshots.len() - 1,
            format!("ghostping results {} --all", domain).cyan()
        );
    }
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn bool_cell(val: bool, yes: &str, no: &str) -> Cell {
    if val {
        Cell::new(yes).fg(Color::Green)
    } else {
        Cell::new(no).fg(Color::Red)
    }
}

fn position_cell(p: &Position) -> Cell {
    match p {
        Position::Top => Cell::new("Top").fg(Color::Green),
        Position::Middle => Cell::new("Middle").fg(Color::Yellow),
        Position::Bottom => Cell::new("Bottom").fg(Color::DarkGrey),
        Position::NotMentioned => Cell::new("—").fg(Color::DarkGrey),
    }
}

fn sentiment_cell(s: &Sentiment) -> Cell {
    match s {
        Sentiment::Positive => Cell::new("Positive").fg(Color::Green),
        Sentiment::Negative => Cell::new("Negative").fg(Color::Red),
        Sentiment::Neutral => Cell::new("Neutral").fg(Color::Yellow),
        Sentiment::Unknown => Cell::new("—").fg(Color::DarkGrey),
    }
}

fn truncate(s: &str, max: usize) -> String {
    crate::types::truncate_chars(s, max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Position, Sentiment};
    use chrono::Utc;

    fn make_result(mentioned: bool, cited: bool) -> MentionResult {
        MentionResult {
            domain: "myproject.com".into(),
            prompt: "what is myproject".into(),
            model: "openai".into(),
            timestamp: Utc::now(),
            mentioned,
            cited,
            position: if mentioned {
                Position::Top
            } else {
                Position::NotMentioned
            },
            sentiment: if mentioned {
                Sentiment::Positive
            } else {
                Sentiment::Unknown
            },
            snippet: None,
            raw_response: "test response".into(),
        }
    }

    #[test]
    fn csv_has_header() {
        let csv = export_csv(&[make_result(true, false)]);
        assert!(csv.starts_with("model,prompt,mentioned,cited,position,sentiment,timestamp\n"));
    }

    #[test]
    fn csv_row_count() {
        let csv = export_csv(&[make_result(true, true), make_result(false, false)]);
        assert_eq!(csv.lines().count(), 3); // header + 2 data rows
    }

    #[test]
    fn csv_escapes_commas_in_prompt() {
        let mut r = make_result(true, false);
        r.prompt = "best tool, for devs".into();
        let csv = export_csv(&[r]);
        assert!(csv.contains("\"best tool, for devs\""));
    }

    #[test]
    fn csv_escapes_quotes_in_prompt() {
        let mut r = make_result(true, false);
        r.prompt = r#"what is "myproject""#.into();
        let csv = export_csv(&[r]);
        assert!(csv.contains("\"\""));
    }

    #[test]
    fn markdown_contains_domain_heading() {
        let md = export_markdown(&[make_result(true, false)], "myproject.com");
        assert!(md.contains("myproject.com"));
        assert!(md.contains("| Model |"));
    }

    #[test]
    fn markdown_row_per_result() {
        let md = export_markdown(
            &[make_result(true, true), make_result(false, false)],
            "myproject.com",
        );
        // header + separator + 2 data rows = 4 table lines
        let table_lines = md.lines().filter(|l| l.starts_with('|')).count();
        assert_eq!(table_lines, 4);
    }

    #[test]
    fn truncate_long_string() {
        let s = "a".repeat(60);
        let t = truncate(&s, 44);
        assert!(t.len() <= 44 + 3); // '…' is multibyte
        assert!(t.ends_with('…'));
    }

    #[test]
    fn truncate_multibyte_never_panics_or_splits_chars() {
        // Every split point lands inside a multibyte char with byte slicing.
        for max in 0..12 {
            let t = truncate(&"🦀".repeat(10), max);
            assert!(t.chars().all(|c| c == '🦀' || c == '…'));
        }
        let t = truncate(&"日本語テストです。Hello world, this is long.", 10);
        assert!(t.ends_with('…'));
        assert_eq!(t.chars().count(), 10);
    }

    #[test]
    fn truncate_short_string_unchanged() {
        let s = "short";
        assert_eq!(truncate(s, 44), "short");
    }
}
