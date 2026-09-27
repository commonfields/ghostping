use anyhow::{bail, Result};
use colored::Colorize;
use std::{collections::HashMap, sync::Arc};

use crate::{
    agent::{
        plan::{prompt_to_filename, GeneratedSection, OptimizationPlan},
        prompt_discovery,
        refiner::{self, GOOD_THRESHOLD},
    },
    cache::Cache,
    geo::{
        evaluator,
        generator::{self, GenerateOptions},
    },
    providers::LlmProvider,
    storage::Storage,
    tracker::{self, TrackOptions},
};

pub struct OptimizeOptions {
    pub domain: String,
    pub niche: String,
    pub competitors: Vec<String>,
    /// How many weak prompts to generate content for (default: 3).
    pub steps: usize,
    /// Max refinement rounds per section when citability is low (default: 2).
    pub max_rounds: usize,
    pub dry_run: bool,
    pub verbose: bool,
    pub quiet: bool,
    /// Optional plugin template override for the generate step.
    pub generate_template_override: Option<String>,
    /// Optional plugin template override for the discover step (system prompt).
    pub discover_template_override: Option<String>,
}

pub async fn optimize(
    opts: &OptimizeOptions,
    providers: &[Arc<dyn LlmProvider>],
    storage: &Storage,
    cache: &Cache,
) -> Result<OptimizationPlan> {
    // ── Step 1: Discover high-intent prompts ────────────────────────────────
    print_step(1, 5, "Discovering high-intent prompts…");
    let discovered = prompt_discovery::discover_with_providers(
        &opts.domain,
        &opts.niche,
        &opts.competitors,
        providers,
        opts.discover_template_override.as_deref(),
    )
    .await;
    let prompt_count = discovered.len().min(15);
    let audit_prompts = discovered[..prompt_count].to_vec();
    eprintln!("       → Found {} prompts", prompt_count);

    // ── Step 2: Audit current visibility ────────────────────────────────────
    print_step(2, 5, "Auditing current visibility…");
    let summary = tracker::run_track(
        &opts.domain,
        audit_prompts.clone(),
        providers.to_vec(),
        storage,
        cache,
        TrackOptions {
            verbose: opts.verbose,
            concurrency: 5,
            judge: None,
            quiet: opts.quiet,
        },
    )
    .await?;

    let current_rate = summary.mention_rate();
    eprintln!(
        "       → Mention rate: {:.0}%  ({}/{})",
        current_rate, summary.mention_count, summary.total_queries
    );

    if summary.total_queries == 0 {
        bail!("Audit returned no results. Check your provider configuration.");
    }

    // ── Step 3: Identify weak prompts ───────────────────────────────────────
    print_step(3, 5, "Identifying optimization opportunities…");
    let weak = find_weak_prompts(&summary.results, opts.steps);
    eprintln!(
        "       → {} weak topic(s) with low visibility — targeting {}",
        count_zero_mention_prompts(&summary.results),
        weak.len()
    );

    // ── Step 4: Generate + refine content ───────────────────────────────────
    print_step(4, 5, "Generating optimized content…");
    let mut sections: Vec<GeneratedSection> = Vec::new();
    let total = weak.len();

    for (i, prompt) in weak.iter().enumerate() {
        eprint!("       → [{}/{}] {}…  ", i + 1, total, truncate(prompt, 46));

        let gen_opts = GenerateOptions {
            prompt: prompt.clone(),
            about: format!("{} — {}", opts.domain, opts.niche),
            niche: opts.niche.clone(),
            verbose: false,
            system_prompt_override: opts.generate_template_override.clone(),
        };

        let initial = match generator::generate(&gen_opts, providers).await {
            Ok(results) if !results.is_empty() => results.into_iter().next().unwrap(),
            Ok(_) => {
                eprintln!("{}", "✗ no response".red());
                continue;
            }
            Err(e) => {
                eprintln!("{} {}", "✗".red(), e);
                continue;
            }
        };

        eprintln!("{} ({})", "✓".green(), initial.model.cyan());

        // ── Evaluate initial content ─────────────────────────────────────────
        let eval = match evaluator::score_content(prompt, &initial.content, providers).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("       → eval error: {}", e);
                sections.push(GeneratedSection {
                    prompt: prompt.clone(),
                    content: initial.content,
                    model: initial.model,
                    citability_rate: 0.0,
                    file_name: prompt_to_filename(prompt),
                    refinement_rounds: 0,
                });
                continue;
            }
        };
        let mut score = cite_rate(&eval);
        let mut best_content = initial.content.clone();
        let mut best_model = initial.model.clone();
        let mut rounds_used = 0usize;

        // ── Refinement loop ──────────────────────────────────────────────────
        let mut current_eval = eval;
        while score < GOOD_THRESHOLD && rounds_used < opts.max_rounds {
            rounds_used += 1;
            let critique = refiner::build_critique(&current_eval);
            eprintln!(
                "       {} Score {:.0}% — refining (round {}/{})…",
                "→".yellow(),
                score,
                rounds_used,
                opts.max_rounds
            );
            eprintln!(
                "         {}",
                truncate(&critique.lines().next().unwrap_or("").replace('•', "↳"), 60).dimmed()
            );

            match refiner::refine(prompt, &best_content, &current_eval, providers).await {
                Some((refined, model)) => {
                    let new_eval = match evaluator::score_content(prompt, &refined, providers).await
                    {
                        Ok(r) => r,
                        Err(_) => break,
                    };
                    let new_score = cite_rate(&new_eval);

                    if new_score > score {
                        eprintln!(
                            "       {} Improved: {:.0}% → {:.0}%",
                            "✓".green(),
                            score,
                            new_score
                        );
                        best_content = refined;
                        best_model = model;
                        score = new_score;
                        current_eval = new_eval;
                    } else {
                        eprintln!(
                            "       {} Refinement did not improve score ({:.0}% → {:.0}%) — keeping original",
                            "~".yellow(),
                            score,
                            new_score
                        );
                        break;
                    }
                }
                None => {
                    eprintln!("       {} Refinement returned no content", "✗".red());
                    break;
                }
            }
        }

        sections.push(GeneratedSection {
            prompt: prompt.clone(),
            content: best_content,
            model: best_model,
            citability_rate: score,
            file_name: prompt_to_filename(prompt),
            refinement_rounds: rounds_used,
        });
    }

    // ── Step 5: Summary ─────────────────────────────────────────────────────
    print_step(5, 5, "Scoring summary…");
    let refined_count = sections.iter().filter(|s| s.refinement_rounds > 0).count();
    for section in &sections {
        let icon = if section.citability_rate >= GOOD_THRESHOLD {
            "✓".green()
        } else {
            "~".yellow()
        };
        let refined_tag = if section.refinement_rounds > 0 {
            format!("  [{} round(s) refined]", section.refinement_rounds)
                .dimmed()
                .to_string()
        } else {
            String::new()
        };
        eprintln!(
            "       {} {:.0}%  — {}{}",
            icon,
            section.citability_rate,
            truncate(&section.prompt, 44).dimmed(),
            refined_tag
        );
    }

    if refined_count > 0 {
        eprintln!(
            "\n       {} {} of {} section(s) were refined for better citability",
            "→".cyan(),
            refined_count,
            sections.len()
        );
    }

    // Honest lift range: ±8pp uncertainty band
    let avg =
        sections.iter().map(|s| s.citability_rate).sum::<f64>() / sections.len().max(1) as f64;
    if !sections.is_empty() {
        let lo = (avg - 8.0).max(0.0);
        let hi = (avg + 8.0).min(100.0);
        eprintln!(
            "       {} Expected lift: +{:.0}–{:.0}% (estimated range based on current models)",
            "→".cyan(),
            lo,
            hi
        );
    }

    Ok(OptimizationPlan {
        domain: opts.domain.clone(),
        niche: opts.niche.clone(),
        current_mention_rate: current_rate,
        total_audit_queries: summary.total_queries,
        discovered_prompts: audit_prompts,
        weak_prompts: weak,
        sections,
    })
}

fn print_step(n: u8, total: u8, msg: &str) {
    eprintln!();
    eprintln!("  [{}/{}]  {}", n, total, msg.bold());
}

fn find_weak_prompts(results: &[crate::types::MentionResult], limit: usize) -> Vec<String> {
    let mut scores: HashMap<&str, (usize, usize)> = HashMap::new();
    for r in results {
        let e = scores.entry(r.prompt.as_str()).or_insert((0, 0));
        e.1 += 1;
        if r.mentioned {
            e.0 += 1;
        }
    }
    let mut sorted: Vec<(&str, f64)> = scores
        .iter()
        .map(|(p, (m, t))| (*p, *m as f64 / (*t).max(1) as f64))
        .collect();
    sorted.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    sorted
        .into_iter()
        .take(limit)
        .map(|(p, _)| p.to_string())
        .collect()
}

fn count_zero_mention_prompts(results: &[crate::types::MentionResult]) -> usize {
    let mut scores: HashMap<&str, bool> = HashMap::new();
    for r in results {
        if r.mentioned {
            scores.insert(r.prompt.as_str(), true);
        } else {
            scores.entry(r.prompt.as_str()).or_insert(false);
        }
    }
    scores.values().filter(|&&v| !v).count()
}

fn cite_rate(results: &[crate::geo::evaluator::EvalResult]) -> f64 {
    if results.is_empty() {
        return 0.0;
    }
    let avg: f64 = results
        .iter()
        .map(|r| r.confidence * if r.would_cite { 1.0 } else { 0.0 })
        .sum::<f64>()
        / results.len() as f64;
    (avg * 100.0).round()
}

fn truncate(s: &str, max: usize) -> String {
    crate::types::truncate_chars(s, max)
}
