//! Observation Kernel V1: one canonical, versioned observation schema.
//!
//! Design (see `docs/engineering/observation-kernel.md`):
//! - Immutable [`ObservationEnvelope`] rows: provenance, surface, retrieval
//!   mode, timestamps, raw-evidence digest, typed payload, execution status.
//! - Derived metrics are views computed at read time, never stored facts.
//! - UNKNOWN is a real state (`None` / explicit `Unknown` variants).
//! - No visibility score lives in this schema.
//!
//! Tables live in the existing `evidence.db` (no new database).
//! `init_schema` is additive, so pre-kernel databases migrate on open.

use anyhow::{bail, Result};
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::audit_storage::AuditStorage;

/// Envelope schema version written by this implementation.
pub const OBS_SCHEMA_VERSION: i64 = 1;
/// Collector identity stamped on kernel-written observations.
pub const OBS_COLLECTOR_VERSION: &str =
    concat!("ghostping-observations/", env!("CARGO_PKG_VERSION"));

/// Canonical observation types. First-party platform measurements and
/// Ghostping-controlled sampling are different types by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationType {
    /// Aggregate first-party Search Console export row (query/page × dimensions).
    SearchConsoleAggregate,
    /// Model answer produced with provider-native grounding/citations.
    GroundedAnswer,
    /// Model answer produced without citations (memory-only output).
    ParametricAnswer,
    /// Generative impression sampled from a provider (evidence-engine origin).
    GenerativeImpression,
    /// Something about the collection was off; accompanies affected rows.
    Integrity,
}

impl ObservationType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SearchConsoleAggregate => "search_console_aggregate",
            Self::GroundedAnswer => "grounded_answer",
            Self::ParametricAnswer => "parametric_answer",
            Self::GenerativeImpression => "generative_impression",
            Self::Integrity => "integrity",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "search_console_aggregate" => Ok(Self::SearchConsoleAggregate),
            "grounded_answer" => Ok(Self::GroundedAnswer),
            "parametric_answer" => Ok(Self::ParametricAnswer),
            "generative_impression" => Ok(Self::GenerativeImpression),
            "integrity" => Ok(Self::Integrity),
            other => bail!("Unknown observation type '{}'", other),
        }
    }
}

/// How the underlying answer was produced, when known.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalMode {
    Unknown,
    Grounded,
    Parametric,
}

impl RetrievalMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Grounded => "grounded",
            Self::Parametric => "parametric",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "unknown" => Ok(Self::Unknown),
            "grounded" => Ok(Self::Grounded),
            "parametric" => Ok(Self::Parametric),
            other => bail!("Unknown retrieval mode '{}'", other),
        }
    }
}

/// Failure classification for a collection batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    None,
    Timeout,
    Auth,
    RateLimit,
    MalformedResponse,
    Transport,
    Unknown,
}

impl FailureClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Timeout => "timeout",
            Self::Auth => "auth",
            Self::RateLimit => "rate_limit",
            Self::MalformedResponse => "malformed_response",
            Self::Transport => "transport",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "none" => Ok(Self::None),
            "timeout" => Ok(Self::Timeout),
            "auth" => Ok(Self::Auth),
            "rate_limit" => Ok(Self::RateLimit),
            "malformed_response" => Ok(Self::MalformedResponse),
            "transport" => Ok(Self::Transport),
            "unknown" => Ok(Self::Unknown),
            other => bail!("Unknown failure class '{}'", other),
        }
    }
}

/// One immutable observation. Raw bytes live in `raw_evidence` keyed by
/// digest; this row pins them via `raw_digest` + `raw_ref`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservationEnvelope {
    pub observation_id: String,
    pub project_id: String,
    pub observation_type: ObservationType,
    pub surface: String,
    pub collected_at: String,
    pub collector_version: String,
    pub schema_version: i64,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub retrieval_mode: RetrievalMode,
    pub region: Option<String>,
    pub language: Option<String>,
    pub prompt_group: Option<String>,
    pub prompt_variant: Option<String>,
    pub url_digest: Option<String>,
    pub planned: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub failure_class: FailureClass,
    pub latency_ms: Option<i64>,
    pub cost_usd: Option<f64>,
    pub raw_digest: String,
    pub raw_ref: String,
    pub payload: serde_json::Value,
}

/// Input for recording one observation. `observation_id` is generated when
/// `None` via [`new_observation_id`]; pass an explicit id for idempotent
/// adapters.
pub struct NewObservation<'a> {
    pub observation_id: Option<&'a str>,
    pub project_id: &'a str,
    pub observation_type: ObservationType,
    pub surface: &'a str,
    pub collected_at: &'a str,
    pub provider: Option<&'a str>,
    pub model: Option<&'a str>,
    pub retrieval_mode: RetrievalMode,
    pub region: Option<&'a str>,
    pub language: Option<&'a str>,
    pub prompt_group: Option<&'a str>,
    pub prompt_variant: Option<&'a str>,
    pub url_digest: Option<&'a str>,
    pub planned: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub failure_class: FailureClass,
    pub latency_ms: Option<i64>,
    pub cost_usd: Option<f64>,
    /// Dedupe key scoped to (project, type): re-importing the same source
    /// row must not create a second observation.
    pub dedupe_key: &'a str,
    /// Raw evidence bytes, stored content-addressed.
    pub raw_bytes: &'a [u8],
    pub payload: &'a serde_json::Value,
}

/// Record of one import batch, used to reject duplicate file imports.
#[derive(Debug, Clone)]
pub struct ImportBatch {
    pub id: i64,
    pub project_id: String,
    pub source_kind: String,
    pub source_digest: String,
    pub source_name: String,
    pub row_count: i64,
    pub imported_at: String,
}

/// SHA-256 hex digest (content addressing for raw evidence + file identity).
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Generate a unique observation id (`obs_<nanos>_<pid>_<counter>`).
pub fn new_observation_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("obs_{}_{}_{}", nanos, std::process::id(), n)
}

pub fn init_observation_schema(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS observations (
            observation_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            observation_type TEXT NOT NULL,
            surface TEXT NOT NULL,
            collected_at TEXT NOT NULL,
            collector_version TEXT NOT NULL,
            schema_version INTEGER NOT NULL DEFAULT 1,
            provider TEXT,
            model TEXT,
            retrieval_mode TEXT NOT NULL DEFAULT 'unknown',
            region TEXT,
            language TEXT,
            prompt_group TEXT,
            prompt_variant TEXT,
            url_digest TEXT,
            planned INTEGER NOT NULL DEFAULT 0,
            succeeded INTEGER NOT NULL DEFAULT 0,
            failed INTEGER NOT NULL DEFAULT 0,
            failure_class TEXT NOT NULL DEFAULT 'none',
            latency_ms INTEGER,
            cost_usd REAL,
            raw_digest TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            dedupe_key TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_observations_project_type
            ON observations(project_id, observation_type);
        CREATE INDEX IF NOT EXISTS idx_observations_collected
            ON observations(project_id, collected_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_natural_key
            ON observations(project_id, observation_type, dedupe_key);

        CREATE TABLE IF NOT EXISTS raw_evidence (
            digest TEXT PRIMARY KEY,
            bytes BLOB NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS import_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_digest TEXT NOT NULL,
            source_name TEXT NOT NULL,
            row_count INTEGER NOT NULL DEFAULT 0,
            imported_at TEXT NOT NULL,
            UNIQUE (project_id, source_kind, source_digest)
        );
        "#,
    )?;
    Ok(())
}

/// Columns selected by `observation_select_sql`, in order. `map_observation`
/// reads positions 0..=22; `raw_ref` always equals `raw_digest`.
const OBS_COLUMNS: &str = "observation_id, project_id, observation_type, surface,
    collected_at, collector_version, schema_version, provider,
    model, retrieval_mode, region, language, prompt_group,
    prompt_variant, url_digest, planned, succeeded, failed,
    failure_class, latency_ms, cost_usd, raw_digest, payload_json";

fn map_observation(row: &Row) -> std::result::Result<ObservationEnvelope, rusqlite::Error> {
    let obs_type: String = row.get(2)?;
    let retrieval: String = row.get(9)?;
    let failure: String = row.get(18)?;
    let payload_raw: String = row.get(22)?;
    Ok(ObservationEnvelope {
        observation_id: row.get(0)?,
        project_id: row.get(1)?,
        observation_type: ObservationType::parse(&obs_type).unwrap_or(ObservationType::Integrity),
        surface: row.get(3)?,
        collected_at: row.get(4)?,
        collector_version: row.get(5)?,
        schema_version: row.get(6)?,
        provider: row.get(7)?,
        model: row.get(8)?,
        retrieval_mode: RetrievalMode::parse(&retrieval).unwrap_or(RetrievalMode::Unknown),
        region: row.get(10)?,
        language: row.get(11)?,
        prompt_group: row.get(12)?,
        prompt_variant: row.get(13)?,
        url_digest: row.get(14)?,
        planned: row.get(15)?,
        succeeded: row.get(16)?,
        failed: row.get(17)?,
        failure_class: FailureClass::parse(&failure).unwrap_or(FailureClass::Unknown),
        latency_ms: row.get(19)?,
        cost_usd: row.get(20)?,
        raw_digest: row.get(21)?,
        raw_ref: row.get(21)?,
        payload: serde_json::from_str(&payload_raw).unwrap_or(serde_json::Value::Null),
    })
}

impl AuditStorage {
    /// Store raw evidence bytes content-addressed; returns the digest.
    /// Insert is idempotent (`INSERT OR IGNORE`).
    pub fn store_raw_evidence(&self, bytes: &[u8]) -> Result<String> {
        let digest = sha256_hex(bytes);
        self.connection().execute(
            "INSERT OR IGNORE INTO raw_evidence (digest, bytes, created_at)
             VALUES (?1, ?2, ?3)",
            params![digest, bytes, chrono::Utc::now().to_rfc3339(),],
        )?;
        Ok(digest)
    }

    /// Fetch raw evidence bytes by digest. `None` when absent.
    pub fn get_raw_evidence(&self, digest: &str) -> Result<Option<Vec<u8>>> {
        let mut stmt = self
            .connection()
            .prepare("SELECT bytes FROM raw_evidence WHERE digest = ?1")?;
        let mut rows = stmt.query_map(params![digest], |r| r.get::<_, Vec<u8>>(0))?;
        Ok(rows.next().transpose()?)
    }

    /// Insert one observation. Returns `Ok(false)` when a row with the same
    /// (project, type, dedupe key) already exists — re-imports are
    /// idempotent and never duplicate evidence.
    pub fn insert_observation(&self, obs: &NewObservation) -> Result<bool> {
        let digest = self.store_raw_evidence(obs.raw_bytes)?;
        let id = obs
            .observation_id
            .map(|s| s.to_string())
            .unwrap_or_else(new_observation_id);
        let changed = self.connection().execute(
            "INSERT OR IGNORE INTO observations
             (observation_id, project_id, observation_type, surface, collected_at,
              collector_version, schema_version, provider, model, retrieval_mode,
              region, language, prompt_group, prompt_variant, url_digest,
              planned, succeeded, failed, failure_class, latency_ms, cost_usd,
              raw_digest, payload_json, dedupe_key, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                     ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                     ?21, ?22, ?23, ?24, ?25)",
            params![
                id,
                obs.project_id,
                obs.observation_type.as_str(),
                obs.surface,
                obs.collected_at,
                OBS_COLLECTOR_VERSION,
                OBS_SCHEMA_VERSION,
                obs.provider,
                obs.model,
                obs.retrieval_mode.as_str(),
                obs.region,
                obs.language,
                obs.prompt_group,
                obs.prompt_variant,
                obs.url_digest,
                obs.planned,
                obs.succeeded,
                obs.failed,
                obs.failure_class.as_str(),
                obs.latency_ms,
                obs.cost_usd,
                digest,
                obs.payload.to_string(),
                obs.dedupe_key,
                chrono::Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(changed == 1)
    }

    /// List observations for a project, optionally filtered by type.
    pub fn list_observations(
        &self,
        project_id: &str,
        obs_type: Option<ObservationType>,
    ) -> Result<Vec<ObservationEnvelope>> {
        let base = format!("SELECT {} FROM observations", OBS_COLUMNS);
        let (sql, param): (String, Option<&str>) = match obs_type {
            Some(t) => (
                format!(
                    "{} WHERE project_id = ?1 AND observation_type = ?2 ORDER BY collected_at ASC",
                    base
                ),
                Some(t.as_str()),
            ),
            None => (
                format!("{} WHERE project_id = ?1 ORDER BY collected_at ASC", base),
                None,
            ),
        };
        let mut stmt = self.connection().prepare(&sql)?;
        let rows = match param {
            Some(p) => stmt.query_map(params![project_id, p], Self::map_observation_row)?,
            None => stmt.query_map(params![project_id], Self::map_observation_row)?,
        };
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn map_observation_row(row: &Row) -> std::result::Result<ObservationEnvelope, rusqlite::Error> {
        map_observation(row)
    }

    /// Count observations for a project, optionally filtered by type.
    pub fn count_observations(
        &self,
        project_id: &str,
        obs_type: Option<ObservationType>,
    ) -> Result<i64> {
        let (sql, param): (&str, Option<&str>) = match obs_type {
            Some(t) => (
                "SELECT COUNT(*) FROM observations WHERE project_id = ?1 AND observation_type = ?2",
                Some(t.as_str()),
            ),
            None => (
                "SELECT COUNT(*) FROM observations WHERE project_id = ?1",
                None,
            ),
        };
        let mut stmt = self.connection().prepare(sql)?;
        let n = match param {
            Some(p) => stmt.query_row(params![project_id, p], |r| r.get(0))?,
            None => stmt.query_row(params![project_id], |r| r.get(0))?,
        };
        Ok(n)
    }

    /// Record an import batch. Returns `Ok(false)` when this exact
    /// (project, kind, file digest) was already imported — the caller must
    /// skip the file to prevent duplicate imports.
    pub fn record_import_batch(
        &self,
        project_id: &str,
        source_kind: &str,
        source_digest: &str,
        source_name: &str,
        row_count: i64,
    ) -> Result<bool> {
        let changed = self.connection().execute(
            "INSERT OR IGNORE INTO import_batches
             (project_id, source_kind, source_digest, source_name, row_count, imported_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                project_id,
                source_kind,
                source_digest,
                source_name,
                row_count,
                chrono::Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(changed == 1)
    }

    /// Previously imported file digests for a project + source kind.
    pub fn imported_source_digests(
        &self,
        project_id: &str,
        source_kind: &str,
    ) -> Result<Vec<String>> {
        let mut stmt = self.connection().prepare(
            "SELECT source_digest FROM import_batches WHERE project_id = ?1 AND source_kind = ?2",
        )?;
        let rows = stmt.query_map(params![project_id, source_kind], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn open_test_db() -> (TempDir, AuditStorage) {
        let dir = TempDir::new().unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
        (dir, storage)
    }

    fn sample_observation<'a>(
        dedupe_key: &'a str,
        raw: &'a [u8],
        payload: &'a serde_json::Value,
    ) -> NewObservation<'a> {
        NewObservation {
            observation_id: None,
            project_id: "example.com",
            observation_type: ObservationType::SearchConsoleAggregate,
            surface: "search-console",
            collected_at: "2026-09-01T00:00:00Z",
            provider: None,
            model: None,
            retrieval_mode: RetrievalMode::Unknown,
            region: None,
            language: None,
            prompt_group: None,
            prompt_variant: None,
            url_digest: None,
            planned: 1,
            succeeded: 1,
            failed: 0,
            failure_class: FailureClass::None,
            latency_ms: None,
            cost_usd: None,
            dedupe_key,
            raw_bytes: raw,
            payload,
        }
    }

    #[test]
    fn test_observation_roundtrip_with_raw_evidence() {
        let (_dir, storage) = open_test_db();
        let payload = serde_json::json!({"clicks": 10, "position": null});
        let raw = b"2026-09-01|query|best tool|10|100";
        assert!(storage
            .insert_observation(&sample_observation("k1", raw, &payload))
            .unwrap());

        assert_eq!(
            storage
                .count_observations("example.com", Some(ObservationType::SearchConsoleAggregate))
                .unwrap(),
            1
        );
        let listed = storage
            .list_observations("example.com", Some(ObservationType::SearchConsoleAggregate))
            .unwrap();
        assert_eq!(listed.len(), 1);
        let env = &listed[0];
        assert_eq!(env.schema_version, OBS_SCHEMA_VERSION);
        assert_eq!(env.retrieval_mode, RetrievalMode::Unknown);
        assert_eq!(env.region, None); // unknown stays unknown
        assert_eq!(env.payload, payload);
        // Raw bytes recoverable by digest; raw_ref pins the same digest.
        assert_eq!(env.raw_ref, env.raw_digest);
        assert_eq!(
            storage.get_raw_evidence(&env.raw_digest).unwrap().unwrap(),
            raw
        );
        assert!(env.observation_id.starts_with("obs_"));
        assert!(env.collector_version.starts_with("ghostping-observations/"));
    }

    #[test]
    fn test_duplicate_observations_are_rejected() {
        let (_dir, storage) = open_test_db();
        let payload = serde_json::json!({"clicks": 1});
        assert!(storage
            .insert_observation(&sample_observation("dup", b"r1", &payload))
            .unwrap());
        // Same (project, type, dedupe key): second insert is a no-op.
        assert!(!storage
            .insert_observation(&sample_observation("dup", b"r1", &payload))
            .unwrap());
        assert_eq!(storage.count_observations("example.com", None).unwrap(), 1);
        // Different key inserts normally.
        assert!(storage
            .insert_observation(&sample_observation("dup2", b"r2", &payload))
            .unwrap());
        assert_eq!(storage.count_observations("example.com", None).unwrap(), 2);
    }

    #[test]
    fn test_import_batch_dedupe_rejects_same_file() {
        let (_dir, storage) = open_test_db();
        assert!(storage
            .record_import_batch("example.com", "search_console_csv", "abc123", "Q.csv", 4)
            .unwrap());
        assert!(!storage
            .record_import_batch("example.com", "search_console_csv", "abc123", "Q.csv", 4)
            .unwrap());
        // Same digest, different project: independent.
        assert!(storage
            .record_import_batch("other.com", "search_console_csv", "abc123", "Q.csv", 4)
            .unwrap());
        assert_eq!(
            storage
                .imported_source_digests("example.com", "search_console_csv")
                .unwrap(),
            vec!["abc123".to_string()]
        );
    }

    #[test]
    fn test_pre_kernel_database_migrates_on_open() {
        // A database from before the kernel (no observation tables at all)
        // must open and gain the tables without losing existing rows.
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
                 temperature REAL NOT NULL DEFAULT 0.2, summary_json TEXT);
                 INSERT INTO audit_runs (project_id, started_at, status,
                 provider_models_json) VALUES ('p', 't', 'completed', '[]');",
            )
            .unwrap();
        }
        let storage = AuditStorage::open(&db_path).unwrap();
        // Old rows intact, observation tables present and usable.
        assert_eq!(storage.count_observations("p", None).unwrap(), 0);
        let payload = serde_json::json!({"ok": true});
        assert!(storage
            .insert_observation(&sample_observation("m1", b"raw", &payload))
            .unwrap());
        assert_eq!(storage.count_observations("example.com", None).unwrap(), 1);
    }

    #[test]
    fn test_unknown_enum_values_degrade_safely() {
        assert!(ObservationType::parse("nope").is_err());
        assert!(RetrievalMode::parse("nope").is_err());
        assert!(FailureClass::parse("nope").is_err());
        // Future schema values stored as text still read back (mapped to
        // Integrity/Unknown rather than failing the whole query).
        let (_dir, storage) = open_test_db();
        storage
            .connection()
            .execute(
                "INSERT INTO observations (observation_id, project_id, observation_type,
                 surface, collected_at, collector_version, schema_version, retrieval_mode,
                 failure_class, raw_digest, payload_json, dedupe_key, created_at)
                 VALUES ('x', 'p', 'future_type', 's', 't', 'c', 99, 'future_mode',
                 'future_fail', 'd', '{}', 'k', 't')",
                [],
            )
            .unwrap();
        let listed = storage.list_observations("p", None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].observation_type, ObservationType::Integrity);
        assert_eq!(listed[0].retrieval_mode, RetrievalMode::Unknown);
        assert_eq!(listed[0].failure_class, FailureClass::Unknown);
    }
}
