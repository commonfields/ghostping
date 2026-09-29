use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::types::{Position, Sentiment};

/// Represents a single audit run (a batch of queries)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRun {
    pub id: i64,
    pub project_id: String, // Domain/project identifier
    pub started_at: String,
    pub completed_at: Option<String>,
    pub status: String, // "running", "completed", "failed"
    pub provider_models_json: String,
    pub samples_per_prompt: i64,
    pub temperature: f64,
    pub summary_json: Option<String>,
}

/// Individual result from a single prompt/model/sample combination
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditResult {
    pub id: i64,
    pub audit_run_id: i64,
    pub prompt_id: Option<i64>,
    pub provider: String,
    pub model: String,
    pub sample_index: i64,
    pub response_text: String,
    pub raw_response_json: String,
    pub mentioned_project: bool,
    pub recommended_project: bool,
    pub mention_position: String,
    pub sentiment: String,
    pub created_at: String,
}

/// A discovered/stored prompt for auditing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prompt {
    pub id: i64,
    pub project_id: String,
    pub prompt_text: String,
    pub intent: Option<String>,
    pub funnel_stage: Option<String>,
    pub priority: Option<i64>,
    pub expected_entity: Option<String>,
    pub created_by: Option<String>,
    pub created_at: String,
}

/// A citation found in an audit response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Citation {
    pub id: i64,
    pub audit_result_id: i64,
    pub url: String,
    pub domain: String,
    pub is_project_domain: bool,
    pub created_at: String,
}

/// A single failed provider query within an audit run.
/// The `error` text is sanitized (truncated, secrets redacted) at insert time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditError {
    pub id: i64,
    pub audit_run_id: i64,
    pub prompt_id: Option<i64>,
    pub provider: String,
    pub model: String,
    pub sample_index: i64,
    pub error: String,
    pub created_at: String,
}

/// Input for recording a failed provider query.
pub struct NewAuditError<'a> {
    pub audit_run_id: i64,
    pub prompt_id: Option<i64>,
    pub provider: &'a str,
    pub model: &'a str,
    pub sample_index: usize,
    pub error: &'a str,
}

/// Competitor mention found in an audit response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompetitorMention {
    pub id: i64,
    pub audit_result_id: i64,
    pub competitor_name: String,
    pub mention_position: String,
    pub sentiment: String,
    pub created_at: String,
}

/// Generated content asset
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedAsset {
    pub id: i64,
    pub project_id: String,
    pub audit_run_id: Option<i64>,
    pub asset_type: String,
    pub title: String,
    pub slug: String,
    pub markdown_content: String,
    pub created_at: String,
}

/// Extended storage with audit engine tables
pub struct AuditStorage {
    conn: Connection,
}

impl AuditStorage {
    pub fn new(conn: Connection) -> Self {
        Self { conn }
    }

    /// Direct connection access for the observation kernel module.
    /// All observation tables live in the same `evidence.db` file.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn open(db_path: &Path) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        let storage = Self::new(conn);
        storage.init_schema()?;
        Ok(storage)
    }

    /// Initialize the database schema with all audit tables
    pub fn init_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            -- Core audit tables
            CREATE TABLE IF NOT EXISTS audit_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                status TEXT NOT NULL DEFAULT 'running',
                provider_models_json TEXT NOT NULL,
                samples_per_prompt INTEGER NOT NULL DEFAULT 3,
                temperature REAL NOT NULL DEFAULT 0.2,
                summary_json TEXT
            );

            CREATE TABLE IF NOT EXISTS prompts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                prompt_text TEXT NOT NULL,
                intent TEXT,
                funnel_stage TEXT,
                priority INTEGER,
                expected_entity TEXT,
                created_by TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audit_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                audit_run_id INTEGER NOT NULL,
                prompt_id INTEGER,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                sample_index INTEGER NOT NULL DEFAULT 0,
                response_text TEXT NOT NULL,
                raw_response_json TEXT NOT NULL,
                mentioned_project INTEGER NOT NULL DEFAULT 0,
                recommended_project INTEGER NOT NULL DEFAULT 0,
                mention_position TEXT NOT NULL DEFAULT 'NotMentioned',
                sentiment TEXT NOT NULL DEFAULT 'Unknown',
                created_at TEXT NOT NULL,
                FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id) ON DELETE CASCADE,
                FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS citations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                audit_result_id INTEGER NOT NULL,
                url TEXT NOT NULL,
                domain TEXT NOT NULL,
                is_project_domain INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (audit_result_id) REFERENCES audit_results(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS competitor_mentions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                audit_result_id INTEGER NOT NULL,
                competitor_name TEXT NOT NULL,
                mention_position TEXT NOT NULL,
                sentiment TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (audit_result_id) REFERENCES audit_results(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS generated_assets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                audit_run_id INTEGER,
                asset_type TEXT NOT NULL,
                title TEXT NOT NULL,
                slug TEXT NOT NULL,
                markdown_content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id) ON DELETE SET NULL
            );

            -- Indexes for performance
            CREATE INDEX IF NOT EXISTS idx_audit_runs_project_id ON audit_runs(project_id);
            CREATE INDEX IF NOT EXISTS idx_audit_runs_started_at ON audit_runs(started_at);
            CREATE INDEX IF NOT EXISTS idx_prompts_project_id ON prompts(project_id);
            CREATE INDEX IF NOT EXISTS idx_audit_results_run_id ON audit_results(audit_run_id);
            CREATE INDEX IF NOT EXISTS idx_audit_results_prompt_id ON audit_results(prompt_id);
            CREATE INDEX IF NOT EXISTS idx_citations_result_id ON citations(audit_result_id);
            CREATE INDEX IF NOT EXISTS idx_competitor_mentions_result_id ON competitor_mentions(audit_result_id);
            CREATE INDEX IF NOT EXISTS idx_generated_assets_project_id ON generated_assets(project_id);
            CREATE INDEX IF NOT EXISTS idx_generated_assets_run_id ON generated_assets(audit_run_id);

            -- Backwards compatibility: migrate old mentions table if it exists
            -- We keep the old table for backwards compatibility

            -- Per-query provider failure diagnostics (added in trust baseline).
            -- Additive only: old databases gain this table on open.
            CREATE TABLE IF NOT EXISTS audit_errors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                audit_run_id INTEGER NOT NULL,
                prompt_id INTEGER,
                provider TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                sample_index INTEGER NOT NULL DEFAULT 0,
                error TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_audit_errors_run_id ON audit_errors(audit_run_id);
            "#,
        )?;
        // Observation Kernel tables (same database, additive migration).
        crate::observations::init_observation_schema(&self.conn)?;
        // Representation integrity tables (same database, additive).
        crate::integrity::init_integrity_schema(&self.conn)?;
        Ok(())
    }

    // ── Audit Run Operations ────────────────────────────────────────────────

    pub fn create_audit_run(
        &self,
        project_id: &str,
        provider_models: &[String],
        samples_per_prompt: usize,
        temperature: f32,
    ) -> Result<i64> {
        let models_json = serde_json::to_string(provider_models)?;
        self.conn.execute(
            "INSERT INTO audit_runs 
             (project_id, started_at, status, provider_models_json, samples_per_prompt, temperature)
             VALUES (?1, ?2, 'running', ?3, ?4, ?5)",
            params![
                project_id,
                Utc::now().to_rfc3339(),
                models_json,
                samples_per_prompt as i64,
                temperature as f64,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn complete_audit_run(&self, run_id: i64, summary: &AuditSummary) -> Result<()> {
        self.complete_audit_run_with_status(run_id, "completed", summary)
    }

    /// Complete a run with an explicit status. Use "completed_with_errors"
    /// when some planned queries failed so partial results are never silently
    /// presented as a complete audit.
    pub fn complete_audit_run_with_status(
        &self,
        run_id: i64,
        status: &str,
        summary: &AuditSummary,
    ) -> Result<()> {
        let summary_json = serde_json::to_string(summary)?;
        self.conn.execute(
            "UPDATE audit_runs
             SET status = ?1, completed_at = ?2, summary_json = ?3
             WHERE id = ?4",
            params![status, Utc::now().to_rfc3339(), summary_json, run_id],
        )?;
        Ok(())
    }

    /// Record a single failed provider query for an audit run.
    /// The `error` text must already be sanitized (truncated, secrets
    /// redacted) by the caller.
    pub fn insert_audit_error(&self, error: &NewAuditError) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO audit_errors
             (audit_run_id, prompt_id, provider, model, sample_index, error, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                error.audit_run_id,
                error.prompt_id,
                error.provider,
                error.model,
                error.sample_index as i64,
                error.error,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_audit_errors(&self, run_id: i64) -> Result<Vec<AuditError>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, audit_run_id, prompt_id, provider, model, sample_index,
                    error, created_at
             FROM audit_errors
             WHERE audit_run_id = ?1
             ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![run_id], Self::map_audit_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn fail_audit_run(&self, run_id: i64, _error: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE audit_runs 
             SET status = 'failed', completed_at = ?1
             WHERE id = ?2",
            params![Utc::now().to_rfc3339(), run_id],
        )?;
        Ok(())
    }

    pub fn get_audit_run(&self, run_id: i64) -> Result<Option<AuditRun>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, started_at, completed_at, status, 
                    provider_models_json, samples_per_prompt, temperature, summary_json
             FROM audit_runs WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![run_id], Self::map_audit_run)?;
        Ok(rows.next().transpose()?)
    }

    pub fn list_audit_runs(&self, project_id: &str, limit: usize) -> Result<Vec<AuditRun>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, started_at, completed_at, status, 
                    provider_models_json, samples_per_prompt, temperature, summary_json
             FROM audit_runs 
             WHERE project_id = ?1
             ORDER BY started_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_id, limit as i64], Self::map_audit_run)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // ── Prompt Operations ───────────────────────────────────────────────────

    pub fn insert_prompt(&self, project_id: &str, prompt: &NewPrompt) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO prompts 
             (project_id, prompt_text, intent, funnel_stage, priority, expected_entity, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                project_id,
                prompt.text,
                prompt.intent,
                prompt.funnel_stage,
                prompt.priority,
                prompt.expected_entity,
                prompt.created_by,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn list_prompts(&self, project_id: &str) -> Result<Vec<Prompt>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, prompt_text, intent, funnel_stage, priority, 
                    expected_entity, created_by, created_at
             FROM prompts 
             WHERE project_id = ?1
             ORDER BY priority ASC NULLS LAST, created_at DESC",
        )?;
        let rows = stmt.query_map(params![project_id], Self::map_prompt)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn get_prompt(&self, prompt_id: i64) -> Result<Option<Prompt>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, prompt_text, intent, funnel_stage, priority, 
                    expected_entity, created_by, created_at
             FROM prompts WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![prompt_id], Self::map_prompt)?;
        Ok(rows.next().transpose()?)
    }

    pub fn dedupe_prompts(&self, project_id: &str) -> Result<usize> {
        // Find and remove near-duplicate prompts (same normalized text)
        let prompts = self.list_prompts(project_id)?;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut duplicates: Vec<i64> = Vec::new();

        for p in prompts {
            let normalized = Self::normalize_prompt(&p.prompt_text);
            if seen.contains(&normalized) {
                duplicates.push(p.id);
            } else {
                seen.insert(normalized);
            }
        }

        let count = duplicates.len();
        for id in duplicates {
            self.conn
                .execute("DELETE FROM prompts WHERE id = ?1", params![id])?;
        }
        Ok(count)
    }

    fn normalize_prompt(text: &str) -> String {
        text.to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    // ── Audit Result Operations ─────────────────────────────────────────────

    pub fn insert_audit_result(&self, result: &NewAuditResult) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO audit_results 
             (audit_run_id, prompt_id, provider, model, sample_index, response_text,
              raw_response_json, mentioned_project, recommended_project, mention_position, 
              sentiment, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                result.audit_run_id,
                result.prompt_id,
                result.provider,
                result.model,
                result.sample_index as i64,
                result.response_text,
                result.raw_response_json,
                result.mentioned_project as i32,
                result.recommended_project as i32,
                result.mention_position.to_string(),
                result.sentiment.to_string(),
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_audit_results(&self, run_id: i64) -> Result<Vec<AuditResult>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, audit_run_id, prompt_id, provider, model, sample_index,
                    response_text, raw_response_json, mentioned_project, recommended_project,
                    mention_position, sentiment, created_at
             FROM audit_results 
             WHERE audit_run_id = ?1
             ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![run_id], Self::map_audit_result)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // ── Citation Operations ─────────────────────────────────────────────────

    pub fn insert_citation(&self, result_id: i64, url: &str, is_project: bool) -> Result<i64> {
        let domain = Self::extract_domain(url);
        self.conn.execute(
            "INSERT INTO citations 
             (audit_result_id, url, domain, is_project_domain, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                result_id,
                url,
                domain,
                is_project as i32,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_citations_for_result(&self, result_id: i64) -> Result<Vec<Citation>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, audit_result_id, url, domain, is_project_domain, created_at
             FROM citations WHERE audit_result_id = ?1",
        )?;
        let rows = stmt.query_map(params![result_id], Self::map_citation)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // ── Competitor Mention Operations ───────────────────────────────────────

    pub fn insert_competitor_mention(
        &self,
        result_id: i64,
        competitor: &str,
        position: &Position,
        sentiment: &Sentiment,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO competitor_mentions 
             (audit_result_id, competitor_name, mention_position, sentiment, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                result_id,
                competitor,
                position.to_string(),
                sentiment.to_string(),
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_competitor_mentions_for_result(
        &self,
        result_id: i64,
    ) -> Result<Vec<CompetitorMention>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, audit_result_id, competitor_name, mention_position, sentiment, created_at
             FROM competitor_mentions WHERE audit_result_id = ?1",
        )?;
        let rows = stmt.query_map(params![result_id], Self::map_competitor_mention)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // ── Generated Asset Operations ──────────────────────────────────────────

    pub fn insert_generated_asset(&self, asset: &NewGeneratedAsset) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO generated_assets 
             (project_id, audit_run_id, asset_type, title, slug, markdown_content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                asset.project_id,
                asset.audit_run_id,
                asset.asset_type,
                asset.title,
                asset.slug,
                asset.markdown_content,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn list_generated_assets(&self, project_id: &str) -> Result<Vec<GeneratedAsset>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, audit_run_id, asset_type, title, slug, markdown_content, created_at
             FROM generated_assets 
             WHERE project_id = ?1
             ORDER BY created_at DESC"
        )?;
        let rows = stmt.query_map(params![project_id], Self::map_generated_asset)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // ── Summary Statistics ──────────────────────────────────────────────────

    pub fn get_audit_summary(&self, run_id: i64) -> Result<AuditSummary> {
        // Ensure the audit_errors table exists so runs created by older
        // versions (pre trust-baseline) still summarize correctly.
        self.init_schema()?;
        let results = self.get_audit_results(run_id)?;
        let failed = self.get_audit_errors(run_id).map(|e| e.len()).unwrap_or(0);

        let total = results.len();
        let mentioned = results.iter().filter(|r| r.mentioned_project).count();
        let recommended = results.iter().filter(|r| r.recommended_project).count();

        // Citation semantics (trust baseline):
        // - citation_count: total extracted citations (all URLs), reported
        //   separately and never used as a rate numerator.
        // - citation_rate: project-citation *response* rate — the fraction of
        //   successful responses containing at least one project-domain
        //   citation. Always within 0.0..=1.0, even when a single response
        //   contains multiple citations.
        let mut citation_count: usize = 0;
        let mut project_citation_count: usize = 0;
        let mut citation_response_count: usize = 0;
        for r in &results {
            let citations = self.get_citations_for_result(r.id).unwrap_or_default();
            citation_count += citations.len();
            let project_citations = citations.iter().filter(|c| c.is_project_domain).count();
            project_citation_count += project_citations;
            if project_citations > 0 {
                citation_response_count += 1;
            }
        }

        // Get unique models
        let mut models: Vec<String> = results
            .iter()
            .map(|r| format!("{}:{}", r.provider, r.model))
            .collect();
        models.sort();
        models.dedup();

        Ok(AuditSummary {
            total_queries: total,
            mention_count: mentioned,
            recommendation_count: recommended,
            citation_count,
            mention_rate: if total > 0 {
                mentioned as f64 / total as f64
            } else {
                0.0
            },
            recommendation_rate: if total > 0 {
                recommended as f64 / total as f64
            } else {
                0.0
            },
            citation_rate: if total > 0 {
                citation_response_count as f64 / total as f64
            } else {
                0.0
            },
            models_used: models,
            planned_queries: total + failed,
            successful_queries: total,
            failed_queries: failed,
            citation_response_count,
            project_citation_count,
        })
    }

    // ── Helper Methods ──────────────────────────────────────────────────────

    fn extract_domain(url: &str) -> String {
        let host = canonical_host(url);
        if host.is_empty() {
            "unknown".to_string()
        } else {
            host
        }
    }

    fn map_audit_run(row: &Row) -> std::result::Result<AuditRun, rusqlite::Error> {
        Ok(AuditRun {
            id: row.get(0)?,
            project_id: row.get(1)?,
            started_at: row.get(2)?,
            completed_at: row.get(3)?,
            status: row.get(4)?,
            provider_models_json: row.get(5)?,
            samples_per_prompt: row.get(6)?,
            temperature: row.get(7)?,
            summary_json: row.get(8)?,
        })
    }

    fn map_prompt(row: &Row) -> std::result::Result<Prompt, rusqlite::Error> {
        Ok(Prompt {
            id: row.get(0)?,
            project_id: row.get(1)?,
            prompt_text: row.get(2)?,
            intent: row.get(3)?,
            funnel_stage: row.get(4)?,
            priority: row.get(5)?,
            expected_entity: row.get(6)?,
            created_by: row.get(7)?,
            created_at: row.get(8)?,
        })
    }

    fn map_audit_result(row: &Row) -> std::result::Result<AuditResult, rusqlite::Error> {
        Ok(AuditResult {
            id: row.get(0)?,
            audit_run_id: row.get(1)?,
            prompt_id: row.get(2)?,
            provider: row.get(3)?,
            model: row.get(4)?,
            sample_index: row.get(5)?,
            response_text: row.get(6)?,
            raw_response_json: row.get(7)?,
            mentioned_project: row.get::<_, i32>(8)? != 0,
            recommended_project: row.get::<_, i32>(9)? != 0,
            mention_position: row.get(10)?,
            sentiment: row.get(11)?,
            created_at: row.get(12)?,
        })
    }

    fn map_citation(row: &Row) -> std::result::Result<Citation, rusqlite::Error> {
        Ok(Citation {
            id: row.get(0)?,
            audit_result_id: row.get(1)?,
            url: row.get(2)?,
            domain: row.get(3)?,
            is_project_domain: row.get::<_, i32>(4)? != 0,
            created_at: row.get(5)?,
        })
    }

    fn map_audit_error(row: &Row) -> std::result::Result<AuditError, rusqlite::Error> {
        Ok(AuditError {
            id: row.get(0)?,
            audit_run_id: row.get(1)?,
            prompt_id: row.get(2)?,
            provider: row.get(3)?,
            model: row.get(4)?,
            sample_index: row.get(5)?,
            error: row.get(6)?,
            created_at: row.get(7)?,
        })
    }

    fn map_competitor_mention(
        row: &Row,
    ) -> std::result::Result<CompetitorMention, rusqlite::Error> {
        Ok(CompetitorMention {
            id: row.get(0)?,
            audit_result_id: row.get(1)?,
            competitor_name: row.get(2)?,
            mention_position: row.get(3)?,
            sentiment: row.get(4)?,
            created_at: row.get(5)?,
        })
    }

    fn map_generated_asset(row: &Row) -> std::result::Result<GeneratedAsset, rusqlite::Error> {
        Ok(GeneratedAsset {
            id: row.get(0)?,
            project_id: row.get(1)?,
            audit_run_id: row.get(2)?,
            asset_type: row.get(3)?,
            title: row.get(4)?,
            slug: row.get(5)?,
            markdown_content: row.get(6)?,
            created_at: row.get(7)?,
        })
    }
}

/// Extract the canonical host from a URL or bare domain: lowercase, no
/// scheme/userinfo/port/path/query, no trailing dot. Returns "" when no
/// host can be determined.
pub fn canonical_host(input: &str) -> String {
    let s = input.trim().to_lowercase();
    // Strip scheme.
    let after_scheme = match s.find("://") {
        Some(i) => &s[i + 3..],
        None => &s[..],
    };
    // Strip userinfo.
    let after_userinfo = match after_scheme.rfind('@') {
        Some(i) => &after_scheme[i + 1..],
        None => after_scheme,
    };
    // Host ends at the first /, ?, #, or whitespace.
    let host_port = after_userinfo
        .split(['/', '?', '#', ' ', '\t', '\n', ')', '>', '"', '\''])
        .next()
        .unwrap_or("");
    // Strip port (careful with IPv6 literals, which we leave intact).
    let host = if host_port.starts_with('[') {
        match host_port.find(']') {
            Some(i) => &host_port[..=i],
            None => host_port,
        }
    } else {
        match host_port.rfind(':') {
            // Only treat as port when the suffix is all digits.
            Some(i) if host_port[i + 1..].chars().all(|c| c.is_ascii_digit()) => &host_port[..i],
            _ => host_port,
        }
    };
    // Only accept strings that plausibly denote a host: either a scheme
    // was present, or the result contains a dot (or is localhost/IPv6).
    // Bare garbage ("not a url") yields "" rather than a junk host.
    let host = host.trim_end_matches('.');
    if host.is_empty() {
        return String::new();
    }
    let had_scheme = input.contains("://");
    if had_scheme || host.contains('.') || host == "localhost" || host.starts_with('[') {
        host.to_string()
    } else {
        String::new()
    }
}

/// True when `url` points at the project's canonical host or a valid
/// subdomain of it. Suffix spoofs (`evilexample.com` vs `example.com`)
/// do NOT match: subdomains require a `.` boundary. The base must contain
/// a dot so bare TLDs can never match everything.
pub fn is_project_citation(url: &str, project: &str) -> bool {
    let base = canonical_host(project);
    if base.is_empty() || !base.contains('.') {
        return false;
    }
    let host = canonical_host(url);
    host == base || host.ends_with(&format!(".{}", base))
}

/// Input for creating a new prompt
pub struct NewPrompt<'a> {
    pub text: &'a str,
    pub intent: Option<&'a str>,
    pub funnel_stage: Option<&'a str>,
    pub priority: Option<i64>,
    pub expected_entity: Option<&'a str>,
    pub created_by: Option<&'a str>,
}

/// Input for creating a new audit result
pub struct NewAuditResult<'a> {
    pub audit_run_id: i64,
    pub prompt_id: Option<i64>,
    pub provider: &'a str,
    pub model: &'a str,
    pub sample_index: usize,
    pub response_text: &'a str,
    pub raw_response_json: &'a str,
    pub mentioned_project: bool,
    pub recommended_project: bool,
    pub mention_position: Position,
    pub sentiment: Sentiment,
}

/// Input for creating a new generated asset
pub struct NewGeneratedAsset<'a> {
    pub project_id: &'a str,
    pub audit_run_id: Option<i64>,
    pub asset_type: &'a str,
    pub title: &'a str,
    pub slug: &'a str,
    pub markdown_content: &'a str,
}

/// Summary of an audit run
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditSummary {
    /// Successful (stored) query responses. Kept as the denominator for all
    /// rates so percentages stay comparable with pre-baseline reports.
    pub total_queries: usize,
    pub mention_count: usize,
    pub recommendation_count: usize,
    /// Total extracted citations across all responses (all URLs, including
    /// unrelated domains). Reported separately; never a rate numerator.
    pub citation_count: usize,
    pub mention_rate: f64,
    pub recommendation_rate: f64,
    /// Project-citation response rate: fraction of successful responses with
    /// at least one project-domain citation. Always 0.0..=1.0.
    pub citation_rate: f64,
    pub models_used: Vec<String>,
    /// Planned = successful + failed. Explicit so partial runs cannot be
    /// mistaken for complete audits. Defaults keep old summary JSON readable.
    #[serde(default)]
    pub planned_queries: usize,
    #[serde(default)]
    pub successful_queries: usize,
    #[serde(default)]
    pub failed_queries: usize,
    /// Successful responses containing at least one project-domain citation.
    #[serde(default)]
    pub citation_response_count: usize,
    /// Total project-domain citations extracted.
    #[serde(default)]
    pub project_citation_count: usize,
}

impl AuditSummary {
    /// True when every planned query produced a stored response.
    pub fn is_complete(&self) -> bool {
        self.failed_queries == 0 && self.planned_queries == self.successful_queries
    }

    /// True when at least one model name indicates mock/test data.
    pub fn uses_mock_provider(&self) -> bool {
        self.models_used
            .iter()
            .any(|m| m.to_lowercase().contains("mock"))
    }

    /// Calculate visibility score using weighted formula
    pub fn visibility_score(&self) -> f64 {
        let mention_weight = 0.35;
        let recommendation_weight = 0.25;
        let citation_weight = 0.20;
        // Note: position and sentiment weights would need more detailed data
        let position_weight = 0.10;
        let sentiment_weight = 0.10;

        // Normalize to 0-100 scale
        let mention_score = self.mention_rate * 100.0;
        let recommendation_score = self.recommendation_rate * 100.0;
        let citation_score = self.citation_rate * 100.0;

        // Position and sentiment would need per-result data, use placeholders
        let position_score = if self.mention_rate > 0.0 { 50.0 } else { 0.0 };
        let sentiment_score = if self.mention_rate > 0.0 { 70.0 } else { 0.0 };

        mention_score * mention_weight
            + recommendation_score * recommendation_weight
            + citation_score * citation_weight
            + position_score * position_weight
            + sentiment_score * sentiment_weight
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_storage_init() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let storage = AuditStorage::open(&db_path).unwrap();

        // Create an audit run
        let run_id = storage
            .create_audit_run("test-project", &["ollama:llama3.2".to_string()], 3, 0.2)
            .unwrap();

        assert!(run_id > 0);

        let run = storage.get_audit_run(run_id).unwrap().unwrap();
        assert_eq!(run.project_id, "test-project");
        assert_eq!(run.status, "running");
    }

    #[test]
    fn test_prompt_dedupe() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let storage = AuditStorage::open(&db_path).unwrap();

        // Insert duplicate prompts
        let prompt1 = NewPrompt {
            text: "What is the best tool?",
            intent: Some("discovery"),
            funnel_stage: Some("awareness"),
            priority: Some(1),
            expected_entity: Some("tool"),
            created_by: Some("test"),
        };

        let prompt2 = NewPrompt {
            text: "what   is the best tool?", // normalized should match
            intent: Some("discovery"),
            funnel_stage: Some("awareness"),
            priority: Some(1),
            expected_entity: Some("tool"),
            created_by: Some("test"),
        };

        storage.insert_prompt("test-project", &prompt1).unwrap();
        storage.insert_prompt("test-project", &prompt2).unwrap();

        let deduped = storage.dedupe_prompts("test-project").unwrap();
        assert_eq!(deduped, 1);

        let remaining = storage.list_prompts("test-project").unwrap();
        assert_eq!(remaining.len(), 1);
    }

    fn insert_result(
        storage: &AuditStorage,
        run_id: i64,
        mentioned: bool,
        recommended: bool,
    ) -> i64 {
        storage
            .insert_audit_result(&NewAuditResult {
                audit_run_id: run_id,
                prompt_id: None,
                provider: "mock",
                model: "mock",
                sample_index: 0,
                response_text: "fixture response",
                raw_response_json: "{}",
                mentioned_project: mentioned,
                recommended_project: recommended,
                mention_position: Position::NotMentioned,
                sentiment: Sentiment::Unknown,
            })
            .unwrap()
    }

    fn fresh_run(storage: &AuditStorage) -> i64 {
        storage
            .create_audit_run("fixture-project", &["mock".to_string()], 1, 0.0)
            .unwrap()
    }

    #[test]
    fn test_citation_rate_bounded_with_multiple_citations_per_response() {
        let dir = TempDir::new().unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
        let run_id = fresh_run(&storage);

        // One response containing three project-domain citations.
        let result_id = insert_result(&storage, run_id, true, false);
        for url in [
            "https://example.com/a",
            "https://example.com/b",
            "https://example.com/c",
        ] {
            storage.insert_citation(result_id, url, true).unwrap();
        }
        // A second response with no citations at all.
        insert_result(&storage, run_id, false, false);

        let summary = storage.get_audit_summary(run_id).unwrap();
        assert_eq!(summary.total_queries, 2);
        // Total citations are reported separately ...
        assert_eq!(summary.citation_count, 3);
        assert_eq!(summary.project_citation_count, 3);
        // ... while the rate counts cited *responses* and can never exceed 1.
        assert_eq!(summary.citation_response_count, 1);
        assert!((summary.citation_rate - 0.5).abs() < 1e-9);
        assert!(summary.citation_rate <= 1.0);
    }

    #[test]
    fn test_unrelated_domain_citations_do_not_inflate_project_rate() {
        let dir = TempDir::new().unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
        let run_id = fresh_run(&storage);

        let result_id = insert_result(&storage, run_id, false, false);
        storage
            .insert_citation(result_id, "https://competitor.example/docs", false)
            .unwrap();
        storage
            .insert_citation(result_id, "https://other.example/x", false)
            .unwrap();

        let summary = storage.get_audit_summary(run_id).unwrap();
        assert_eq!(summary.citation_count, 2);
        assert_eq!(summary.project_citation_count, 0);
        assert_eq!(summary.citation_response_count, 0);
        assert_eq!(summary.citation_rate, 0.0);
    }

    #[test]
    fn test_summary_with_zero_successful_queries() {
        let dir = TempDir::new().unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
        let run_id = fresh_run(&storage);

        storage
            .insert_audit_error(&NewAuditError {
                audit_run_id: run_id,
                prompt_id: None,
                provider: "openai",
                model: "openai",
                sample_index: 0,
                error: "connection refused",
            })
            .unwrap();

        let summary = storage.get_audit_summary(run_id).unwrap();
        assert_eq!(summary.total_queries, 0);
        assert_eq!(summary.successful_queries, 0);
        assert_eq!(summary.failed_queries, 1);
        assert_eq!(summary.planned_queries, 1);
        assert_eq!(summary.mention_rate, 0.0);
        assert_eq!(summary.citation_rate, 0.0);
        assert!(!summary.is_complete());
    }

    #[test]
    fn test_partial_failures_are_explicit_in_summary() {
        let dir = TempDir::new().unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
        let run_id = fresh_run(&storage);

        insert_result(&storage, run_id, true, false);
        insert_result(&storage, run_id, false, false);
        for sample in 0..2 {
            storage
                .insert_audit_error(&NewAuditError {
                    audit_run_id: run_id,
                    prompt_id: None,
                    provider: "openai",
                    model: "openai",
                    sample_index: sample,
                    error: "timeout",
                })
                .unwrap();
        }

        let summary = storage.get_audit_summary(run_id).unwrap();
        assert_eq!(summary.successful_queries, 2);
        assert_eq!(summary.failed_queries, 2);
        assert_eq!(summary.planned_queries, 4);
        assert!(!summary.is_complete());

        let errors = storage.get_audit_errors(run_id).unwrap();
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0].provider, "openai");

        storage
            .complete_audit_run_with_status(run_id, "completed_with_errors", &summary)
            .unwrap();
        let run = storage.get_audit_run(run_id).unwrap().unwrap();
        assert_eq!(run.status, "completed_with_errors");
    }

    #[test]
    fn test_old_summary_json_without_new_fields_still_deserializes() {
        // Summaries written before the trust baseline lack the new counters.
        let old = serde_json::json!({
            "total_queries": 4,
            "mention_count": 2,
            "recommendation_count": 1,
            "citation_count": 5,
            "mention_rate": 0.5,
            "recommendation_rate": 0.25,
            "citation_rate": 1.25,
            "models_used": ["mock:mock"],
        });
        let summary: AuditSummary = serde_json::from_value(old).unwrap();
        assert_eq!(summary.total_queries, 4);
        assert_eq!(summary.planned_queries, 0);
        assert_eq!(summary.failed_queries, 0);
        assert_eq!(summary.citation_response_count, 0);
        assert!(summary.uses_mock_provider());
    }

    #[test]
    fn test_audit_errors_table_created_for_legacy_database() {
        // A database created without the audit_errors table (e.g. by an older
        // release) must remain readable and gain the new table on open.
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("legacy.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE audit_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,
                 project_id TEXT NOT NULL, started_at TEXT NOT NULL,
                 completed_at TEXT, status TEXT NOT NULL DEFAULT 'running',
                 provider_models_json TEXT NOT NULL,
                 samples_per_prompt INTEGER NOT NULL DEFAULT 3,
                 temperature REAL NOT NULL DEFAULT 0.2, summary_json TEXT);",
            )
            .unwrap();
        }
        let storage = AuditStorage::open(&db_path).unwrap();
        let run_id = fresh_run(&storage);
        // Summarizing must not fail even though the table is new.
        let summary = storage.get_audit_summary(run_id).unwrap();
        assert_eq!(summary.total_queries, 0);
        storage
            .insert_audit_error(&NewAuditError {
                audit_run_id: run_id,
                prompt_id: None,
                provider: "mock",
                model: "mock",
                sample_index: 0,
                error: "boom",
            })
            .unwrap();
        assert_eq!(storage.get_audit_errors(run_id).unwrap().len(), 1);
    }

    #[test]
    fn test_canonical_host_normalizes_inputs() {
        assert_eq!(
            canonical_host("https://Example.COM/docs?a=1"),
            "example.com"
        );
        assert_eq!(canonical_host("example.com"), "example.com");
        assert_eq!(
            canonical_host("http://user:pw@Sub.Example.com:8080/x"),
            "sub.example.com"
        );
        assert_eq!(canonical_host("example.com."), "example.com");
        assert_eq!(canonical_host("not a url at all well"), "");
    }

    #[test]
    fn test_project_citation_matching_exact_and_subdomain() {
        // Exact domain.
        assert!(is_project_citation(
            "https://example.com/docs",
            "example.com"
        ));
        // Valid subdomains at any depth.
        assert!(is_project_citation(
            "https://docs.example.com/guide",
            "example.com"
        ));
        assert!(is_project_citation(
            "https://a.b.example.com/x",
            "example.com"
        ));
        // Project given as a full URL; ports, case, and trailing dots ignored.
        assert!(is_project_citation(
            "https://DOCS.EXAMPLE.COM.:8443/y",
            "https://example.com"
        ));
    }

    #[test]
    fn test_project_citation_matching_rejects_spoofs() {
        // Attacker-controlled suffix domain: shares a string suffix but no
        // dot boundary — must NOT count as a project citation.
        assert!(!is_project_citation(
            "https://evilexample.com/phish",
            "example.com"
        ));
        assert!(!is_project_citation(
            "https://example.com.evil.com/phish",
            "example.com"
        ));
        // Unrelated domains never match.
        assert!(!is_project_citation(
            "https://competitor.example/docs",
            "example.com"
        ));
        assert!(!is_project_citation("https://other.io/x", "example.com"));
        // Degenerate bases never match everything.
        assert!(!is_project_citation("https://example.com/", "com"));
        assert!(!is_project_citation("https://example.com/", ""));
    }
}
