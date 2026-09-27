use anyhow::Result;
use chrono::Utc;
use colored::Colorize;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Semaphore;

use crate::{
    cache::Cache,
    config::Config,
    parser,
    providers::{
        anthropic::AnthropicProvider, gemini::GeminiProvider, ollama::OllamaProvider,
        openai::OpenAiProvider, perplexity::PerplexityProvider, xai::XaiProvider, LlmProvider,
    },
    storage::Storage,
    types::{MentionResult, TrackSummary},
};

pub fn build_providers(config: &Config) -> Vec<Arc<dyn LlmProvider>> {
    let mut v: Vec<Arc<dyn LlmProvider>> = Vec::new();
    if let Some(c) = &config.providers.openai {
        if c.enabled {
            v.push(Arc::new(OpenAiProvider::new(c.clone())));
        }
    }
    if let Some(c) = &config.providers.anthropic {
        if c.enabled {
            v.push(Arc::new(AnthropicProvider::new(c.clone())));
        }
    }
    if let Some(c) = &config.providers.gemini {
        if c.enabled {
            v.push(Arc::new(GeminiProvider::new(c.clone())));
        }
    }
    if let Some(c) = &config.providers.xai {
        if c.enabled {
            v.push(Arc::new(XaiProvider::new(c.clone())));
        }
    }
    if let Some(c) = &config.providers.perplexity {
        if c.enabled {
            v.push(Arc::new(PerplexityProvider::new(c.clone())));
        }
    }
    if let Some(c) = &config.providers.ollama {
        if c.enabled {
            v.push(Arc::new(OllamaProvider::new(c.clone())));
        }
    }
    v
}

pub fn build_providers_filtered(
    config: &Config,
    filter: Option<&str>,
) -> Vec<Arc<dyn LlmProvider>> {
    let all = build_providers(config);
    match filter {
        None => all,
        Some(f) => {
            let names: Vec<&str> = f.split(',').map(str::trim).collect();
            all.into_iter()
                .filter(|p| names.contains(&p.name()))
                .collect()
        }
    }
}

/// Build the judge provider from [judge] config, used when --judge is passed.
pub fn build_judge(config: &Config) -> Option<Arc<dyn LlmProvider>> {
    let j = &config.judge;
    Some(Arc::new(OllamaProvider::new(crate::config::OllamaConfig {
        base_url: j.base_url.clone(),
        model: j.model.clone(),
        enabled: true,
        temperature: 0.0,
    })))
}

pub struct TrackOptions {
    pub verbose: bool,
    pub concurrency: usize,
    /// When Some, re-evaluate each response through the LLM-as-judge for accuracy.
    pub judge: Option<Arc<dyn LlmProvider>>,
    /// Suppress per-query progress output (for CI / watch mode summary lines).
    pub quiet: bool,
}

impl Default for TrackOptions {
    fn default() -> Self {
        Self {
            verbose: false,
            concurrency: 5,
            judge: None,
            quiet: false,
        }
    }
}

pub async fn run_track(
    domain: &str,
    prompts: Vec<String>,
    providers: Vec<Arc<dyn LlmProvider>>,
    storage: &Storage,
    cache: &Cache,
    opts: TrackOptions,
) -> Result<TrackSummary> {
    let total = providers.len() * prompts.len();
    let done = Arc::new(AtomicUsize::new(0));
    let sem = Arc::new(Semaphore::new(opts.concurrency));
    let judge = opts.judge.map(Arc::new);

    // Collect cached results immediately; spawn tasks for live queries.
    let mut results: Vec<MentionResult> = Vec::new();
    let mut handles: Vec<(String, String, tokio::task::JoinHandle<Result<String>>)> = Vec::new();

    for provider in &providers {
        for prompt in &prompts {
            let model = provider.name().to_string();
            if let Some(cached) = cache.get(domain, &model, prompt) {
                let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                let parsed = parser::parse_response(domain, &cached);
                if !opts.quiet {
                    let icon = if parsed.mentioned {
                        "✓".green()
                    } else {
                        "–".dimmed()
                    };
                    eprintln!(
                        "  {} [{:>3}/{}] [cached] [{}] {}",
                        icon,
                        n,
                        total,
                        model.cyan(),
                        prompt.dimmed()
                    );
                    if opts.verbose {
                        eprintln!("          {}", first_line(&cached).dimmed());
                    }
                }
                results.push(make_result(domain, prompt, &model, cached, parsed));
                continue;
            }

            let provider = Arc::clone(provider);
            let prompt_c = prompt.clone();
            let sem = Arc::clone(&sem);
            handles.push((
                model,
                prompt.clone(),
                tokio::spawn(async move {
                    let _permit = sem.acquire().await.unwrap();
                    provider.query(&prompt_c).await
                }),
            ));
        }
    }

    let judge_ref = judge.as_deref();

    for (model, prompt, handle) in handles {
        match handle.await {
            Ok(Ok(response)) => {
                let parsed = match judge_ref {
                    Some(j) => parser::parse_with_judge(domain, &response, j.as_ref()).await,
                    None => parser::parse_response(domain, &response),
                };
                let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                if !opts.quiet {
                    let icon = if parsed.mentioned {
                        "✓".green()
                    } else {
                        "–".dimmed()
                    };
                    let judge_tag = if judge_ref.is_some() { " [judge]" } else { "" };
                    eprintln!(
                        "  {} [{:>3}/{}] [{}{}] {}",
                        icon,
                        n,
                        total,
                        model.cyan(),
                        judge_tag.dimmed(),
                        prompt.dimmed()
                    );
                    if opts.verbose {
                        eprintln!("          {}", first_line(&response).dimmed());
                    }
                }
                let _ = cache.set(domain, &model, &prompt, &response);
                results.push(make_result(domain, &prompt, &model, response, parsed));
            }
            Ok(Err(e)) => {
                let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                eprintln!(
                    "  {} [{:>3}/{}] [{}] {}",
                    "✗".red(),
                    n,
                    total,
                    model.cyan(),
                    e.to_string().yellow()
                );
            }
            Err(e) => {
                eprintln!("  {} [{}] task panicked: {}", "✗".red(), model.cyan(), e);
            }
        }
    }

    for r in &results {
        if let Err(e) = storage.insert(r) {
            eprintln!("  {} failed to save result: {}", "!".yellow(), e);
        }
    }

    // Auto-prune records older than 90 days (silent, best-effort)
    let _ = storage.prune_old(90);

    let mention_count = results.iter().filter(|r| r.mentioned).count();
    let citation_count = results.iter().filter(|r| r.cited).count();
    let mut models_with_mention: Vec<String> = results
        .iter()
        .filter(|r| r.mentioned)
        .map(|r| r.model.clone())
        .collect();
    models_with_mention.sort();
    models_with_mention.dedup();

    Ok(TrackSummary {
        domain: domain.to_string(),
        total_queries: results.len(),
        mention_count,
        citation_count,
        models_with_mention,
        results,
        source: AUDIT_SOURCE_LEGACY.to_string(),
    })
}

/// Source marker for every summary produced by the legacy tracker path.
/// Legacy results live in `mentions.db` and must never be mistaken for
/// current evidence-engine audits (`evidence.db`, see `AuditSummary`).
/// Callers that surface these numbers (CLI, Tauri, TUI) must present the
/// legacy identity alongside them.
pub const AUDIT_SOURCE_LEGACY: &str = "legacy-tracker";

fn make_result(
    domain: &str,
    prompt: &str,
    model: &str,
    raw_response: String,
    parsed: parser::ParseResult,
) -> MentionResult {
    MentionResult {
        domain: domain.to_string(),
        prompt: prompt.to_string(),
        model: model.to_string(),
        timestamp: Utc::now(),
        mentioned: parsed.mentioned,
        cited: parsed.cited,
        position: parsed.position,
        sentiment: parsed.sentiment,
        snippet: parsed.snippet,
        raw_response,
    }
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("").trim()
}
