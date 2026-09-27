use anyhow::Result;
use chrono::Utc;
use colored::Colorize;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Semaphore;

use crate::{
    audit_storage::{AuditStorage, AuditSummary, NewAuditResult, NewPrompt},
    config::{Config, ProviderConfig},
    parser,
    project_config::ProjectProvidersConfig,
    providers::LlmProvider,
    types::{Position, Sentiment},
};

/// Options for running an audit
#[derive(Debug, Clone)]
pub struct AuditOptions {
    pub samples_per_prompt: usize,
    pub temperature: f32,
    pub store_raw_responses: bool,
    pub verbose: bool,
    pub quiet: bool,
    pub concurrency: usize,
}

impl Default for AuditOptions {
    fn default() -> Self {
        Self {
            samples_per_prompt: 3,
            temperature: 0.2,
            store_raw_responses: true,
            verbose: false,
            quiet: false,
            concurrency: 5,
        }
    }
}

/// A single audit query result (before storage)
#[derive(Debug, Clone)]
struct QueryResult {
    prompt_id: Option<i64>,
    provider: String,
    model: String,
    sample_index: usize,
    response_text: String,
    mentioned_project: bool,
    recommended_project: bool,
    mention_position: Position,
    sentiment: Sentiment,
    citations: Vec<(String, bool)>, // (url, is_project)
}

/// A planned query that failed before producing a storable response.
/// The error text is sanitized: truncated and scrubbed of secret-like tokens.
#[derive(Debug, Clone)]
struct FailedQuery {
    prompt_id: Option<i64>,
    provider: String,
    model: String,
    sample_index: usize,
    error: String,
}

/// The core audit engine
pub struct AuditEngine {
    providers: Vec<Arc<dyn LlmProvider>>,
    options: AuditOptions,
}

impl AuditEngine {
    pub fn new(providers: Vec<Arc<dyn LlmProvider>>, options: AuditOptions) -> Self {
        Self { providers, options }
    }

    /// Run a full audit for a project
    pub async fn run_audit(
        &self,
        project_id: &str,
        prompts: &[PromptInput],
        storage: &AuditStorage,
    ) -> Result<AuditRunResult> {
        // Create audit run record (synchronous)
        let provider_models: Vec<String> = self
            .providers
            .iter()
            .map(|p| p.name().to_string())
            .collect();

        let run_id = storage.create_audit_run(
            project_id,
            &provider_models,
            self.options.samples_per_prompt,
            self.options.temperature,
        )?;

        if !self.options.quiet {
            println!(
                "  {} Starting audit run {} for {} with {} prompt(s) × {} sample(s) × {} model(s)",
                "→".cyan(),
                run_id,
                project_id.cyan(),
                prompts.len(),
                self.options.samples_per_prompt,
                self.providers.len()
            );
        }

        // Store prompts first (synchronous)
        let mut stored_prompt_ids: Vec<Option<i64>> = Vec::new();
        for prompt in prompts {
            let prompt_id = if let Some(existing_id) = prompt.id {
                Some(existing_id)
            } else {
                Some(storage.insert_prompt(
                    project_id,
                    &NewPrompt {
                        text: &prompt.text,
                        intent: prompt.intent.as_deref(),
                        funnel_stage: prompt.funnel_stage.as_deref(),
                        priority: prompt.priority,
                        expected_entity: prompt.expected_entity.as_deref(),
                        created_by: Some("audit_engine"),
                    },
                )?)
            };
            stored_prompt_ids.push(prompt_id);
        }

        // Run all queries asynchronously and collect results
        let total_queries = prompts.len() * self.options.samples_per_prompt * self.providers.len();
        let completed = Arc::new(AtomicUsize::new(0));
        let sem = Arc::new(Semaphore::new(self.options.concurrency));

        let mut all_results: Vec<QueryResult> = Vec::new();
        let mut failed_queries: Vec<FailedQuery> = Vec::new();

        for (prompt_idx, prompt) in prompts.iter().enumerate() {
            let prompt_id = stored_prompt_ids[prompt_idx];

            for provider in &self.providers {
                for sample_idx in 0..self.options.samples_per_prompt {
                    let provider = Arc::clone(provider);
                    let prompt_text = prompt.text.clone();
                    let sem = Arc::clone(&sem);
                    let completed = Arc::clone(&completed);
                    let opts = self.options.clone();
                    let project_id_owned = project_id.to_string();

                    // Execute query asynchronously
                    enum QueryOutcome {
                        Ok(QueryResult),
                        Err(FailedQuery),
                    }
                    let result: QueryOutcome = async move {
                        let _permit = sem.acquire().await.unwrap();

                        // Query the provider
                        let response = match provider.query(&prompt_text).await {
                            Ok(resp) => resp,
                            Err(e) => {
                                let error = Self::sanitize_error(&e.to_string());
                                eprintln!(
                                    "  {} Query failed for {}: {}",
                                    "✗".red(),
                                    provider.name().cyan(),
                                    error
                                );
                                let n = completed.fetch_add(1, Ordering::SeqCst) + 1;
                                if !opts.quiet {
                                    eprintln!(
                                        "  {} [{:>3}/{}] [{}] sample {} — failed",
                                        "✗".red(),
                                        n,
                                        total_queries,
                                        provider.name().cyan(),
                                        sample_idx + 1,
                                    );
                                }
                                return QueryOutcome::Err(FailedQuery {
                                    prompt_id,
                                    provider: provider.name().to_string(),
                                    model: provider.name().to_string(),
                                    sample_index: sample_idx,
                                    error,
                                });
                            }
                        };

                        // Parse the response
                        let parse_result = parser::parse_response(&project_id_owned, &response);

                        // Detect recommendation
                        let recommended = Self::detect_recommendation(&response, &project_id_owned);

                        // Extract citations
                        let citations = Self::extract_citations(&response, &project_id_owned);

                        // Progress
                        let n = completed.fetch_add(1, Ordering::SeqCst) + 1;
                        if !opts.quiet {
                            let icon = if parse_result.mentioned {
                                "✓".green()
                            } else {
                                "–".dimmed()
                            };
                            eprintln!(
                                "  {} [{:>3}/{}] [{}] sample {} — {}",
                                icon,
                                n,
                                total_queries,
                                provider.name().cyan(),
                                sample_idx + 1,
                                if parse_result.mentioned {
                                    "mentioned".green()
                                } else {
                                    "not mentioned".dimmed()
                                }
                            );
                            if opts.verbose {
                                eprintln!("      {}", Self::first_line(&response).dimmed());
                            }
                        }

                        QueryOutcome::Ok(QueryResult {
                            prompt_id,
                            provider: provider.name().to_string(),
                            model: provider.name().to_string(),
                            sample_index: sample_idx,
                            response_text: response,
                            mentioned_project: parse_result.mentioned,
                            recommended_project: recommended,
                            mention_position: parse_result.position,
                            sentiment: parse_result.sentiment,
                            citations,
                        })
                    }
                    .await;

                    match result {
                        QueryOutcome::Ok(r) => all_results.push(r),
                        QueryOutcome::Err(f) => failed_queries.push(f),
                    }
                }
            }
        }

        // Store all results synchronously
        for result in &all_results {
            let raw_json = if self.options.store_raw_responses {
                serde_json::json!({
                    "provider": result.provider,
                    "prompt_id": result.prompt_id,
                    "sample_index": result.sample_index,
                    "mentioned": result.mentioned_project,
                    "recommended": result.recommended_project,
                    "timestamp": Utc::now().to_rfc3339(),
                })
                .to_string()
            } else {
                String::new()
            };

            let result_id = storage.insert_audit_result(&NewAuditResult {
                audit_run_id: run_id,
                prompt_id: result.prompt_id,
                provider: &result.provider,
                model: &result.model,
                sample_index: result.sample_index,
                response_text: &result.response_text,
                raw_response_json: &raw_json,
                mentioned_project: result.mentioned_project,
                recommended_project: result.recommended_project,
                mention_position: result.mention_position.clone(),
                sentiment: result.sentiment.clone(),
            })?;

            // Store citations
            for (url, is_project) in &result.citations {
                storage.insert_citation(result_id, url, *is_project)?;
            }
        }

        // Store failure diagnostics (sanitized, no secrets) so partial runs
        // stay auditable.
        for failed in &failed_queries {
            storage.insert_audit_error(&crate::audit_storage::NewAuditError {
                audit_run_id: run_id,
                prompt_id: failed.prompt_id,
                provider: &failed.provider,
                model: &failed.model,
                sample_index: failed.sample_index,
                error: &failed.error,
            })?;
        }

        // Generate summary
        let summary = storage.get_audit_summary(run_id)?;
        let failed_count = summary.failed_queries;

        if summary.successful_queries == 0 {
            storage.fail_audit_run(run_id, "all queries failed")?;
            anyhow::bail!(
                "Audit run {} failed: all {} planned querie(s) failed. \
                 First error [{}]: {}. No results were stored, so there is \
                 nothing to report. Fix the provider configuration and retry.",
                run_id,
                summary.planned_queries,
                failed_queries
                    .first()
                    .map(|f| f.provider.as_str())
                    .unwrap_or("unknown"),
                failed_queries
                    .first()
                    .map(|f| f.error.as_str())
                    .unwrap_or("unknown error"),
            );
        }

        if failed_count > 0 {
            storage.complete_audit_run_with_status(run_id, "completed_with_errors", &summary)?;
        } else {
            storage.complete_audit_run(run_id, &summary)?;
        }

        if !self.options.quiet {
            if failed_count > 0 {
                println!(
                    "  {} Audit run {} completed WITH ERRORS — {}/{} queries failed. \
                     Mention rate: {:.1}%, Recommendation rate: {:.1}%. \
                     Results are partial and marked 'completed_with_errors', not 'completed'.",
                    "⚠".yellow(),
                    run_id,
                    failed_count,
                    summary.planned_queries,
                    summary.mention_rate * 100.0,
                    summary.recommendation_rate * 100.0
                );
            } else {
                println!(
                    "  {} Audit run {} completed — Mention rate: {:.1}%, Recommendation rate: {:.1}%",
                    "✓".green(),
                    run_id,
                    summary.mention_rate * 100.0,
                    summary.recommendation_rate * 100.0
                );
            }
        }

        Ok(AuditRunResult {
            run_id,
            project_id: project_id.to_string(),
            summary,
            planned_queries: total_queries,
            failed_queries: failed_queries
                .iter()
                .map(|f| format!("[{}] {}", f.provider, f.error))
                .collect(),
        })
    }

    /// Sanitize a provider error for storage and display: truncate to a
    /// bounded length and redact secret-like tokens (API keys, bearer tokens)
    /// so failure diagnostics never leak credentials.
    fn sanitize_error(raw: &str) -> String {
        let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        let truncated: String = collapsed.chars().take(500).collect();
        Self::redact_secrets(&truncated)
    }

    fn redact_secrets(s: &str) -> String {
        // Secret-shaped tokens we must never persist or print in full.
        let patterns = [
            r"sk-[A-Za-z0-9._\-]{8,}",
            r"sk-ant-[A-Za-z0-9._\-]{8,}",
            r"xai-[A-Za-z0-9._\-]{8,}",
            r"pplx-[A-Za-z0-9._\-]{8,}",
            r"AIza[A-Za-z0-9._\-]{8,}",
            r"(?i)bearer\s+[A-Za-z0-9._\-]{8,}",
        ];
        let mut out = s.to_string();
        for pattern in patterns {
            if let Ok(re) = regex::Regex::new(pattern) {
                out = re.replace_all(&out, "[REDACTED]").to_string();
            }
        }
        out
    }

    /// Detect if the response contains a recommendation
    fn detect_recommendation(response: &str, project: &str) -> bool {
        let response_lower = response.to_lowercase();
        let project_lower = project.to_lowercase();

        // Only check if project is mentioned
        if !response_lower.contains(&project_lower) {
            return false;
        }

        // Recommendation keywords
        const RECOMMENDATION_INDICATORS: &[&str] = &[
            "recommend",
            "best",
            "best choice",
            "good choice",
            "use",
            "try",
            "consider",
            "suggest",
            "advise",
            "optimal",
            "ideal",
            "excellent",
            "highly",
            "strongly recommend",
            "should use",
        ];

        // Find sentences mentioning the project
        let sentences: Vec<&str> = response_lower
            .split(['.', '!', '?', '\n'])
            .filter(|s| s.contains(&project_lower))
            .collect();

        for sentence in sentences {
            for indicator in RECOMMENDATION_INDICATORS {
                if sentence.contains(indicator) {
                    return true;
                }
            }
        }

        false
    }

    /// Extract URLs from response and identify if they belong to the project
    fn extract_citations(response: &str, project: &str) -> Vec<(String, bool)> {
        let url_regex = regex::Regex::new(r"https?://[^\s\)>]+").unwrap();
        let mut citations = Vec::new();

        for cap in url_regex.captures_iter(response) {
            let url = cap.get(0).unwrap().as_str().to_string();
            let is_project = crate::audit_storage::is_project_citation(&url, project);
            citations.push((url, is_project));
        }

        citations
    }

    fn first_line(s: &str) -> &str {
        s.lines().next().unwrap_or("").trim()
    }
}

/// Input prompt for auditing
#[derive(Debug, Clone)]
pub struct PromptInput {
    pub id: Option<i64>,
    pub text: String,
    pub intent: Option<String>,
    pub funnel_stage: Option<String>,
    pub priority: Option<i64>,
    pub expected_entity: Option<String>,
}

impl PromptInput {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            id: None,
            text: text.into(),
            intent: None,
            funnel_stage: None,
            priority: None,
            expected_entity: None,
        }
    }

    pub fn with_intent(mut self, intent: impl Into<String>) -> Self {
        self.intent = Some(intent.into());
        self
    }

    pub fn with_funnel_stage(mut self, stage: impl Into<String>) -> Self {
        self.funnel_stage = Some(stage.into());
        self
    }

    pub fn with_priority(mut self, priority: i64) -> Self {
        self.priority = Some(priority);
        self
    }
}

/// Result of an audit run
#[derive(Debug, Clone)]
pub struct AuditRunResult {
    pub run_id: i64,
    pub project_id: String,
    pub summary: AuditSummary,
    /// Total planned queries (prompts × samples × providers).
    pub planned_queries: usize,
    /// Sanitized per-query failure diagnostics ("[provider] error").
    /// Empty when the run had no failures.
    pub failed_queries: Vec<String>,
}

fn cloud_provider_config(
    configured: Option<&ProviderConfig>,
    env_var: &str,
    default_model: &str,
) -> Option<ProviderConfig> {
    if let Some(config) = configured {
        return Some(config.clone());
    }

    std::env::var(env_var)
        .ok()
        .filter(|key| !key.trim().is_empty())
        .map(|api_key| ProviderConfig {
            api_key,
            model: default_model.to_string(),
            enabled: true,
            temperature: 0.0,
            timeout_secs: 30,
        })
}

/// Build providers from project config and global config
pub fn build_providers_for_project(
    project_config: &ProjectProvidersConfig,
    global_config: &Config,
    filter: Option<&str>,
) -> Vec<Arc<dyn LlmProvider>> {
    use crate::providers::{
        anthropic::AnthropicProvider, gemini::GeminiProvider, ollama::OllamaProvider,
        openai::OpenAiProvider, perplexity::PerplexityProvider, xai::XaiProvider,
    };

    let mut providers: Vec<Arc<dyn LlmProvider>> = Vec::new();

    // If specific models are requested in filter, use those
    if let Some(f) = filter {
        let names: Vec<&str> = f.split(',').map(str::trim).collect();
        for name in names {
            let parts: Vec<&str> = name.split(':').collect();
            let provider_name = parts[0];
            let model_name = parts.get(1).copied();

            match provider_name {
                "ollama" => {
                    if let Some(ref c) = global_config.providers.ollama {
                        let mut config = c.clone();
                        if let Some(m) = model_name {
                            config.model = m.to_string();
                        }
                        config.enabled = true;
                        providers.push(Arc::new(OllamaProvider::new(config)));
                    }
                }
                "openai" => {
                    if let Some(mut config) = cloud_provider_config(
                        global_config.providers.openai.as_ref(),
                        "OPENAI_API_KEY",
                        "gpt-4o-mini",
                    ) {
                        if let Some(m) = model_name {
                            config.model = m.to_string();
                        }
                        config.enabled = true;
                        providers.push(Arc::new(OpenAiProvider::new(config)));
                    }
                }
                "anthropic" => {
                    if let Some(mut config) = cloud_provider_config(
                        global_config.providers.anthropic.as_ref(),
                        "ANTHROPIC_API_KEY",
                        "claude-3-5-haiku-20241022",
                    ) {
                        if let Some(m) = model_name {
                            config.model = m.to_string();
                        }
                        config.enabled = true;
                        providers.push(Arc::new(AnthropicProvider::new(config)));
                    }
                }
                "xai" | "grok" => {
                    if let Some(mut config) = cloud_provider_config(
                        global_config.providers.xai.as_ref(),
                        "XAI_API_KEY",
                        "grok-2-latest",
                    ) {
                        if let Some(m) = model_name {
                            config.model = m.to_string();
                        }
                        config.enabled = true;
                        providers.push(Arc::new(XaiProvider::new(config)));
                    }
                }
                "gemini" | "google" => {
                    if let Some(mut config) = cloud_provider_config(
                        global_config.providers.gemini.as_ref(),
                        "GEMINI_API_KEY",
                        "gemini-2.0-flash",
                    ) {
                        if let Some(m) = model_name {
                            config.model = m.to_string();
                        }
                        config.enabled = true;
                        providers.push(Arc::new(GeminiProvider::new(config)));
                    }
                }
                "perplexity" => {
                    if let Some(mut config) = cloud_provider_config(
                        global_config.providers.perplexity.as_ref(),
                        "PERPLEXITY_API_KEY",
                        "sonar",
                    ) {
                        if let Some(m) = model_name {
                            config.model = m.to_string();
                        }
                        config.enabled = true;
                        providers.push(Arc::new(PerplexityProvider::new(config)));
                    }
                }
                _ => {}
            }
        }
        return providers;
    }

    // Otherwise, use project config or global enabled providers
    if !project_config.models.is_empty() {
        // Parse project models
        for model_str in &project_config.models {
            let parts: Vec<&str> = model_str.split(':').collect();
            if parts.len() >= 2 {
                let provider_name = parts[0];
                let model_name = parts[1];

                match provider_name {
                    "ollama" => {
                        if let Some(ref c) = global_config.providers.ollama {
                            let mut config = c.clone();
                            config.model = model_name.to_string();
                            config.enabled = true;
                            providers.push(Arc::new(OllamaProvider::new(config)));
                        }
                    }
                    "openai" => {
                        if let Some(mut config) = cloud_provider_config(
                            global_config.providers.openai.as_ref(),
                            "OPENAI_API_KEY",
                            "gpt-4o-mini",
                        ) {
                            config.model = model_name.to_string();
                            config.enabled = true;
                            providers.push(Arc::new(OpenAiProvider::new(config)));
                        }
                    }
                    "anthropic" => {
                        if let Some(mut config) = cloud_provider_config(
                            global_config.providers.anthropic.as_ref(),
                            "ANTHROPIC_API_KEY",
                            "claude-3-5-haiku-20241022",
                        ) {
                            config.model = model_name.to_string();
                            config.enabled = true;
                            providers.push(Arc::new(AnthropicProvider::new(config)));
                        }
                    }
                    "xai" | "grok" => {
                        if let Some(mut config) = cloud_provider_config(
                            global_config.providers.xai.as_ref(),
                            "XAI_API_KEY",
                            "grok-2-latest",
                        ) {
                            config.model = model_name.to_string();
                            config.enabled = true;
                            providers.push(Arc::new(XaiProvider::new(config)));
                        }
                    }
                    "gemini" | "google" => {
                        if let Some(mut config) = cloud_provider_config(
                            global_config.providers.gemini.as_ref(),
                            "GEMINI_API_KEY",
                            "gemini-2.0-flash",
                        ) {
                            config.model = model_name.to_string();
                            config.enabled = true;
                            providers.push(Arc::new(GeminiProvider::new(config)));
                        }
                    }
                    "perplexity" => {
                        if let Some(mut config) = cloud_provider_config(
                            global_config.providers.perplexity.as_ref(),
                            "PERPLEXITY_API_KEY",
                            "sonar",
                        ) {
                            config.model = model_name.to_string();
                            config.enabled = true;
                            providers.push(Arc::new(PerplexityProvider::new(config)));
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // Fall back to globally enabled providers
    if providers.is_empty() {
        if let Some(ref c) = global_config.providers.openai {
            if c.enabled {
                providers.push(Arc::new(OpenAiProvider::new(c.clone())));
            }
        }
        if let Some(ref c) = global_config.providers.anthropic {
            if c.enabled {
                providers.push(Arc::new(AnthropicProvider::new(c.clone())));
            }
        }
        if let Some(ref c) = global_config.providers.gemini {
            if c.enabled {
                providers.push(Arc::new(GeminiProvider::new(c.clone())));
            }
        }
        if let Some(ref c) = global_config.providers.xai {
            if c.enabled {
                providers.push(Arc::new(XaiProvider::new(c.clone())));
            }
        }
        if let Some(ref c) = global_config.providers.perplexity {
            if c.enabled {
                providers.push(Arc::new(PerplexityProvider::new(c.clone())));
            }
        }
        if let Some(ref c) = global_config.providers.ollama {
            if c.enabled {
                providers.push(Arc::new(OllamaProvider::new(c.clone())));
            }
        }
    }

    providers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::LlmProvider;
    use async_trait::async_trait;

    struct StubProvider {
        name: String,
        response: Option<String>,
    }

    impl StubProvider {
        fn ok(name: &str, response: &str) -> Self {
            Self {
                name: name.to_string(),
                response: Some(response.to_string()),
            }
        }

        fn failing(name: &str) -> Self {
            Self {
                name: name.to_string(),
                response: None,
            }
        }
    }

    #[async_trait]
    impl LlmProvider for StubProvider {
        fn name(&self) -> &str {
            &self.name
        }

        async fn query_with_system(&self, _system: Option<&str>, _prompt: &str) -> Result<String> {
            match &self.response {
                Some(r) => Ok(r.clone()),
                None => anyhow::bail!("stub provider {} is down", self.name),
            }
        }
    }

    fn test_storage() -> (tempfile::TempDir, AuditStorage) {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
        (dir, storage)
    }

    fn quiet_options(samples: usize) -> AuditOptions {
        AuditOptions {
            samples_per_prompt: samples,
            temperature: 0.0,
            store_raw_responses: false,
            verbose: false,
            quiet: true,
            concurrency: 2,
        }
    }

    fn prompts(n: usize) -> Vec<PromptInput> {
        (0..n)
            .map(|i| PromptInput::new(format!("fixture prompt {}", i)))
            .collect()
    }

    #[test]
    fn test_detect_recommendation() {
        let response = "I recommend using MyProject for this task.";
        assert!(AuditEngine::detect_recommendation(response, "MyProject"));

        let response2 = "MyProject is a tool that exists.";
        assert!(!AuditEngine::detect_recommendation(response2, "MyProject"));
    }

    #[test]
    fn test_extract_citations() {
        let response = "Visit https://example.com/docs and https://myproject.com for more info.";
        let citations = AuditEngine::extract_citations(response, "myproject.com");

        assert_eq!(citations.len(), 2);
        assert!(!citations[0].1); // example.com is not project
        assert!(citations[1].1); // myproject.com is project
    }

    #[test]
    fn test_sanitize_error_truncates_and_redacts_secrets() {
        let long = format!(
            "connection reset sk-SECRETKEY1234567890 {}",
            "x".repeat(600)
        );
        let clean = AuditEngine::sanitize_error(&long);
        assert!(clean.chars().count() <= 500);
        assert!(!clean.contains("SECRETKEY"));
        assert!(clean.contains("[REDACTED]"));

        let bearer = AuditEngine::sanitize_error("401 Unauthorized: Bearer abcdefgh12345678");
        assert!(!bearer.contains("abcdefgh"));
    }

    #[tokio::test]
    async fn test_zero_successful_queries_marks_run_failed() {
        let (_dir, storage) = test_storage();
        let engine = AuditEngine::new(
            vec![Arc::new(StubProvider::failing("down"))],
            quiet_options(2),
        );

        let err = engine
            .run_audit("example.com", &prompts(2), &storage)
            .await
            .expect_err("all-failing audit must return an error");

        let msg = err.to_string();
        assert!(msg.contains("all 4 planned querie(s) failed"), "got: {msg}");

        let run = storage.get_audit_run(1).unwrap().unwrap();
        assert_eq!(run.status, "failed");
        assert_eq!(storage.get_audit_results(1).unwrap().len(), 0);
        assert_eq!(storage.get_audit_errors(1).unwrap().len(), 4);
    }

    #[tokio::test]
    async fn test_partial_provider_failures_are_explicit_not_completed() {
        let (_dir, storage) = test_storage();
        let engine = AuditEngine::new(
            vec![
                Arc::new(StubProvider::ok(
                    "good",
                    "Example is great, I recommend Example.",
                )),
                Arc::new(StubProvider::failing("bad")),
            ],
            quiet_options(2),
        );

        let result = engine
            .run_audit("example.com", &prompts(1), &storage)
            .await
            .expect("partial audit must still return a result");

        // 1 prompt × 2 samples × 2 providers = 4 planned; the "good"
        // provider succeeds twice, the "bad" one fails twice.
        assert_eq!(result.planned_queries, 4);
        assert_eq!(result.summary.successful_queries, 2);
        assert_eq!(result.summary.failed_queries, 2);
        assert_eq!(result.summary.planned_queries, 4);
        assert!(!result.summary.is_complete());
        assert_eq!(result.failed_queries.len(), 2);
        assert!(result.failed_queries[0].starts_with("[bad]"));

        let run = storage.get_audit_run(result.run_id).unwrap().unwrap();
        assert_eq!(run.status, "completed_with_errors");
    }

    #[tokio::test]
    async fn test_complete_mock_audit_reports_full_counts() {
        let (_dir, storage) = test_storage();
        let engine = AuditEngine::new(
            vec![Arc::new(StubProvider::ok(
                "mock",
                "Example is great. See https://example.com for details.",
            ))],
            quiet_options(3),
        );

        let result = engine
            .run_audit("example.com", &prompts(2), &storage)
            .await
            .unwrap();

        assert_eq!(result.planned_queries, 6);
        assert_eq!(result.summary.successful_queries, 6);
        assert_eq!(result.summary.failed_queries, 0);
        assert!(result.summary.is_complete());
        assert!(result.failed_queries.is_empty());

        let run = storage.get_audit_run(result.run_id).unwrap().unwrap();
        assert_eq!(run.status, "completed");
    }
}
