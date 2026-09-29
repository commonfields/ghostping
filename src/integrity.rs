//! Representation integrity pilot: what the business asserts, what the AI
//! said, and what a human reviewer concludes — three different records.
//!
//! ```text
//! AuthoritativeFact (business-authorized, versioned, never overwritten)
//!       ↓ referenced by
//! CandidateClaim (manually selected from one immutable observation)
//!       ↓ reviewed in
//! HumanJudgment (append-only; new versions supersede, never overwrite)
//!       ↓ derived at read time as
//! IntegrityFinding (no duplicate source of truth, no scores)
//! ```
//!
//! Tables live in the existing `evidence.db` (additive migration only).
//! Judgments and facts are human-authored; no classifier, regex heuristic,
//! embedding, or LLM may create them (extraction_method is always MANUAL).

use anyhow::{bail, Result};
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};

use crate::audit_storage::AuditStorage;

// ── Value types and statuses ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactValueType {
    Text,
    Number,
    Currency,
    Boolean,
    Date,
    Url,
    Enum,
}

impl FactValueType {
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "text" => Ok(Self::Text),
            "number" => Ok(Self::Number),
            "currency" => Ok(Self::Currency),
            "boolean" => Ok(Self::Boolean),
            "date" => Ok(Self::Date),
            "url" => Ok(Self::Url),
            "enum" => Ok(Self::Enum),
            other => bail!(
                "Unknown fact type '{}': use text|number|currency|boolean|date|url|enum.",
                other
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Currency => "currency",
            Self::Boolean => "boolean",
            Self::Date => "date",
            Self::Url => "url",
            Self::Enum => "enum",
        }
    }

    /// Boring, inspectable validation. Accepts honest values, rejects
    /// shape violations with a diagnostic. Never "normalizes" the value.
    pub fn validate_value(self, value: &str) -> Result<()> {
        match self {
            Self::Text | Self::Currency | Self::Enum => {
                if value.trim().is_empty() {
                    bail!("Fact value must not be empty.");
                }
                Ok(())
            }
            Self::Number => value
                .trim()
                .replace(',', "")
                .parse::<f64>()
                .map(|_| ())
                .map_err(|_| anyhow::anyhow!("Value '{}' is not a number.", value)),
            Self::Boolean => match value.trim().to_lowercase().as_str() {
                "true" | "false" | "yes" | "no" | "1" | "0" => Ok(()),
                _ => bail!(
                    "Value '{}' is not a boolean (true|false|yes|no|1|0).",
                    value
                ),
            },
            Self::Date => chrono::NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
                .map(|_| ())
                .map_err(|_| anyhow::anyhow!("Value '{}' is not a YYYY-MM-DD date.", value)),
            Self::Url => {
                let v = value.trim();
                if v.starts_with("http://") || v.starts_with("https://") {
                    Ok(())
                } else {
                    bail!("Value '{}' is not an http(s) URL.", value)
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactStatus {
    Active,
    Superseded,
    Retired,
}

impl FactStatus {
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "active" => Ok(Self::Active),
            "superseded" => Ok(Self::Superseded),
            "retired" => Ok(Self::Retired),
            other => bail!("Unknown fact status '{}'.", other),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Superseded => "superseded",
            Self::Retired => "retired",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactSourceKind {
    Manual,
    Website,
    ProductCatalog,
    PolicyDocument,
    Other,
}

impl FactSourceKind {
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "manual" => Ok(Self::Manual),
            "website" => Ok(Self::Website),
            "product_catalog" => Ok(Self::ProductCatalog),
            "policy_document" => Ok(Self::PolicyDocument),
            "other" => Ok(Self::Other),
            other => bail!(
                "Unknown source kind '{}': use manual|website|product_catalog|policy_document|other.",
                other
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Website => "website",
            Self::ProductCatalog => "product_catalog",
            Self::PolicyDocument => "policy_document",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimOrigin {
    ExactSpan,
    ManualTranscription,
}

impl ClaimOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExactSpan => "exact_span",
            Self::ManualTranscription => "manual_transcription",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "exact_span" => Ok(Self::ExactSpan),
            "manual_transcription" => Ok(Self::ManualTranscription),
            other => bail!("Unknown claim origin '{}'.", other),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JudgmentVerdict {
    Supported,
    Contradicted,
    Partial,
    InsufficientEvidence,
}

impl JudgmentVerdict {
    pub fn parse(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "supported" => Ok(Self::Supported),
            "contradicted" => Ok(Self::Contradicted),
            "partial" => Ok(Self::Partial),
            "insufficient" | "insufficient_evidence" => Ok(Self::InsufficientEvidence),
            other => bail!(
                "Unknown verdict '{}': use supported|contradicted|partial|insufficient_evidence.",
                other
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::Contradicted => "contradicted",
            Self::Partial => "partial",
            Self::InsufficientEvidence => "insufficient_evidence",
        }
    }

    /// Visible finding state (CONTRADICTION, not CONTRADICTED).
    pub fn finding_state(self) -> &'static str {
        match self {
            Self::Supported => "SUPPORTED",
            Self::Contradicted => "CONTRADICTION",
            Self::Partial => "PARTIAL",
            Self::InsufficientEvidence => "INSUFFICIENT",
        }
    }
}

// ── Records ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthoritativeFact {
    pub fact_id: String,
    pub project_id: String,
    pub subject: String,
    pub predicate: String,
    pub value: String,
    pub value_type: FactValueType,
    pub status: FactStatus,
    pub valid_from: Option<String>,
    pub valid_until: Option<String>,
    pub source_kind: FactSourceKind,
    pub source_ref: Option<String>,
    pub source_digest: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub created_by: String,
    pub supersedes_fact_id: Option<String>,
}

pub struct NewFact<'a> {
    pub project_id: &'a str,
    pub subject: &'a str,
    pub predicate: &'a str,
    pub value: &'a str,
    pub value_type: FactValueType,
    pub valid_from: Option<&'a str>,
    pub valid_until: Option<&'a str>,
    pub source_kind: FactSourceKind,
    pub source_ref: Option<&'a str>,
    pub source_digest: Option<&'a str>,
    pub notes: Option<&'a str>,
    pub created_by: &'a str,
    pub supersedes_fact_id: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateClaim {
    pub claim_id: String,
    pub project_id: String,
    pub observation_id: String,
    pub claim_text: String,
    pub source_span_text: Option<String>,
    pub source_part: Option<i64>,
    pub start_offset: Option<i64>,
    pub end_offset: Option<i64>,
    pub claim_subject: Option<String>,
    pub claim_type: Option<String>,
    pub claim_origin: ClaimOrigin,
    pub created_at: String,
    pub created_by: String,
    pub extraction_method: String,
}

pub struct NewClaim<'a> {
    pub project_id: &'a str,
    pub observation_id: &'a str,
    pub claim_text: &'a str,
    pub source_span_text: Option<&'a str>,
    pub source_part: Option<i64>,
    pub start_offset: Option<i64>,
    pub end_offset: Option<i64>,
    pub claim_subject: Option<&'a str>,
    pub claim_type: Option<&'a str>,
    pub created_by: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HumanJudgment {
    pub judgment_id: String,
    pub claim_id: String,
    pub fact_ids: Vec<String>,
    pub verdict: JudgmentVerdict,
    pub rationale: Option<String>,
    pub reviewer: String,
    pub reviewed_at: String,
    pub judgment_version: u32,
    pub supersedes_judgment_id: Option<String>,
    pub created_at: String,
}

pub struct NewJudgment<'a> {
    pub claim_id: &'a str,
    pub fact_ids: &'a [String],
    pub verdict: JudgmentVerdict,
    pub rationale: Option<&'a str>,
    pub reviewer: &'a str,
    pub supersedes_judgment_id: Option<&'a str>,
}

/// Derived current state for one claim. Never stored: computed from the
/// claim + latest valid judgment + referenced facts at read time.
#[derive(Debug, Clone)]
pub struct IntegrityFinding {
    pub claim_id: String,
    /// None when no judgment exists yet.
    pub state: Option<&'static str>,
    pub judgment: Option<HumanJudgment>,
    pub facts: Vec<AuthoritativeFact>,
}

// ── Schema ──────────────────────────────────────────────────────────────────

pub fn init_integrity_schema(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS authoritative_facts (
            fact_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            predicate TEXT NOT NULL,
            value TEXT NOT NULL,
            value_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            valid_from TEXT,
            valid_until TEXT,
            source_kind TEXT NOT NULL,
            source_ref TEXT,
            source_digest TEXT,
            notes TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            supersedes_fact_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_facts_project ON authoritative_facts(project_id);
        CREATE INDEX IF NOT EXISTS idx_facts_subject ON authoritative_facts(project_id, subject, predicate);

        CREATE TABLE IF NOT EXISTS candidate_claims (
            claim_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            observation_id TEXT NOT NULL,
            claim_text TEXT NOT NULL,
            source_span_text TEXT,
            source_part INTEGER,
            start_offset INTEGER,
            end_offset INTEGER,
            claim_subject TEXT,
            claim_type TEXT,
            claim_origin TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            extraction_method TEXT NOT NULL DEFAULT 'manual'
        );
        CREATE INDEX IF NOT EXISTS idx_claims_project ON candidate_claims(project_id);
        CREATE INDEX IF NOT EXISTS idx_claims_observation ON candidate_claims(observation_id);

        CREATE TABLE IF NOT EXISTS human_judgments (
            judgment_id TEXT PRIMARY KEY,
            claim_id TEXT NOT NULL,
            fact_ids_json TEXT NOT NULL,
            verdict TEXT NOT NULL,
            rationale TEXT,
            reviewer TEXT NOT NULL,
            reviewed_at TEXT NOT NULL,
            judgment_version INTEGER NOT NULL DEFAULT 1,
            supersedes_judgment_id TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (claim_id) REFERENCES candidate_claims(claim_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_judgments_claim ON human_judgments(claim_id);
        "#,
    )?;
    Ok(())
}

// ── Temporal semantics ────────────────────────────────────────────────────────
// V1 rule (documented, UTC by engineering convention — NOT business-local
// time): date-only `valid_from` means 00:00:00 UTC that day; date-only
// `valid_until` means *exclusive* 00:00:00 UTC of the following day, so the
// whole calendar date is included. RFC3339 bounds normalize to absolute
// instants (offsets honored). Every interval is `[start, end)` internally,
// so adjacent bounds never double-include. Open (absent) bounds are
// unbounded. Original input strings are preserved verbatim; only the
// normalized instants participate in comparison.

/// A normalized validity bound: whole-day flag remembers date-only origin
/// so `valid_until = 2026-08-31` covers that entire date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoundKind {
    Day,
    Instant,
}

fn parse_bound(raw: &str) -> Result<(i64, BoundKind)> {
    let t = raw.trim();
    if let Ok(d) = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        let start = d
            .and_hms_opt(0, 0, 0)
            .ok_or_else(|| anyhow::anyhow!("Invalid date '{}'.", raw))?
            .and_utc()
            .timestamp();
        return Ok((start, BoundKind::Day));
    }
    let dt = chrono::DateTime::parse_from_rfc3339(t).map_err(|_| {
        anyhow::anyhow!(
            "Invalid temporal bound '{}': use YYYY-MM-DD or RFC3339.",
            raw
        )
    })?;
    Ok((dt.timestamp(), BoundKind::Instant))
}

/// Normalize one fact's window to `[start, end)` unix seconds.
/// `None` bounds are open. Errors on malformed input or empty windows.
fn normalize_window(
    valid_from: Option<&str>,
    valid_until: Option<&str>,
) -> Result<(Option<i64>, Option<i64>)> {
    let start = valid_from.map(parse_bound).transpose()?.map(|(t, _)| t);
    let end = match valid_until.map(parse_bound).transpose()? {
        Some((t, BoundKind::Day)) => Some(t + 86_400), // whole calendar date included
        Some((t, BoundKind::Instant)) => Some(t),
        None => None,
    };
    if let (Some(s), Some(e)) = (start, end) {
        if e <= s {
            bail!(
                "Empty validity window: end must be after start (got {:?} → {:?}).",
                valid_from,
                valid_until
            );
        }
    }
    Ok((start, end))
}

fn instant_in_window(ts: i64, start: Option<i64>, end: Option<i64>) -> bool {
    start.is_none_or(|s| s <= ts) && end.is_none_or(|e| ts < e)
}

fn parse_observation_instant(at: &str) -> Result<i64> {
    chrono::DateTime::parse_from_rfc3339(at.trim())
        .map(|dt| dt.timestamp())
        .map_err(|_| anyhow::anyhow!("Invalid observation timestamp '{}': expected RFC3339.", at))
}

/// Authority conflict between co-active facts. Derived, never stored:
/// Ghostping surfaces it and never chooses a winner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FactAuthorityConflict {
    pub project_id: String,
    pub subject: String,
    pub predicate: String,
    pub fact_ids: Vec<String>,
    /// Overlap interval, ISO date/datetime or open-ended.
    pub overlap_start: Option<String>,
    pub overlap_end: Option<String>,
    pub kind: AuthorityConflictKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuthorityConflictKind {
    /// Same values, overlapping authority: redundant, still surfaced.
    RedundantActiveFacts,
    /// Different values, overlapping authority: genuine conflict.
    ConflictingActiveFacts,
}

impl AuthorityConflictKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RedundantActiveFacts => "REDUNDANT_ACTIVE_FACTS",
            Self::ConflictingActiveFacts => "FACT_AUTHORITY_CONFLICT",
        }
    }
}

fn overlap_interval(windows: &[(Option<i64>, Option<i64>)]) -> Option<(Option<i64>, Option<i64>)> {
    let mut start: Option<i64> = None;
    let mut end: Option<i64> = None;
    for (s, e) in windows {
        start = match (start, s) {
            (Some(a), Some(b)) => Some(a.max(*b)),
            (None, b) => *b,
            (a, None) => a,
        };
        end = match (end, e) {
            (Some(a), Some(b)) => Some(a.min(*b)),
            (None, b) => *b,
            (a, None) => a,
        };
    }
    match (start, end) {
        (Some(s), Some(e)) if e <= s => None,
        _ => Some((start, end)),
    }
}

fn format_bound(ts: Option<i64>) -> Option<String> {
    ts.map(|t| {
        chrono::DateTime::<chrono::Utc>::from_timestamp(t, 0)
            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
            .unwrap_or_else(|| t.to_string())
    })
}

// ── Storage ─────────────────────────────────────────────────────────────────

fn next_prefixed_id(conn: &rusqlite::Connection, table: &str, prefix: &str) -> Result<String> {
    let count: i64 =
        conn.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))?;
    Ok(format!("{}-{:04}", prefix, count + 1))
}

fn map_fact(row: &Row) -> std::result::Result<AuthoritativeFact, rusqlite::Error> {
    let value_type: String = row.get(5)?;
    let status: String = row.get(6)?;
    let source_kind: String = row.get(9)?;
    Ok(AuthoritativeFact {
        fact_id: row.get(0)?,
        project_id: row.get(1)?,
        subject: row.get(2)?,
        predicate: row.get(3)?,
        value: row.get(4)?,
        value_type: FactValueType::parse(&value_type).unwrap_or(FactValueType::Text),
        status: FactStatus::parse(&status).unwrap_or(FactStatus::Active),
        valid_from: row.get(7)?,
        valid_until: row.get(8)?,
        source_kind: FactSourceKind::parse(&source_kind).unwrap_or(FactSourceKind::Manual),
        source_ref: row.get(10)?,
        source_digest: row.get(11)?,
        notes: row.get(12)?,
        created_at: row.get(13)?,
        created_by: row.get(14)?,
        supersedes_fact_id: row.get(15)?,
    })
}

fn map_claim(row: &Row) -> std::result::Result<CandidateClaim, rusqlite::Error> {
    let origin: String = row.get(10)?;
    Ok(CandidateClaim {
        claim_id: row.get(0)?,
        project_id: row.get(1)?,
        observation_id: row.get(2)?,
        claim_text: row.get(3)?,
        source_span_text: row.get(4)?,
        source_part: row.get(5)?,
        start_offset: row.get(6)?,
        end_offset: row.get(7)?,
        claim_subject: row.get(8)?,
        claim_type: row.get(9)?,
        claim_origin: ClaimOrigin::parse(&origin).unwrap_or(ClaimOrigin::ManualTranscription),
        created_at: row.get(11)?,
        created_by: row.get(12)?,
        extraction_method: row.get(13)?,
    })
}

fn map_judgment(row: &Row) -> std::result::Result<HumanJudgment, rusqlite::Error> {
    let verdict: String = row.get(3)?;
    let facts_raw: String = row.get(2)?;
    Ok(HumanJudgment {
        judgment_id: row.get(0)?,
        claim_id: row.get(1)?,
        fact_ids: serde_json::from_str(&facts_raw).unwrap_or_default(),
        verdict: JudgmentVerdict::parse(&verdict).unwrap_or(JudgmentVerdict::InsufficientEvidence),
        rationale: row.get(4)?,
        reviewer: row.get(5)?,
        reviewed_at: row.get(6)?,
        judgment_version: row.get::<_, i64>(7)? as u32,
        supersedes_judgment_id: row.get(8)?,
        created_at: row.get(9)?,
    })
}

const FACT_COLUMNS: &str = "fact_id, project_id, subject, predicate, value, value_type,
    status, valid_from, valid_until, source_kind, source_ref, source_digest,
    notes, created_at, created_by, supersedes_fact_id";
const CLAIM_COLUMNS: &str = "claim_id, project_id, observation_id, claim_text,
    source_span_text, source_part, start_offset, end_offset, claim_subject,
    claim_type, claim_origin, created_at, created_by, extraction_method";
const JUDGMENT_COLUMNS: &str = "judgment_id, claim_id, fact_ids_json, verdict,
    rationale, reviewer, reviewed_at, judgment_version, supersedes_judgment_id, created_at";

impl AuditStorage {
    /// Insert a business-approved fact. The (subject, predicate, value,
    /// type) triple is validated; values are never normalized.
    pub fn insert_fact(&self, fact: &NewFact) -> Result<String> {
        fact.value_type.validate_value(fact.value)?;
        // Parsed temporal validation: malformed bounds and empty windows are
        // rejected here. Original strings are stored verbatim.
        normalize_window(fact.valid_from, fact.valid_until)?;
        if let Some(prev) = fact.supersedes_fact_id {
            let old = self
                .get_fact(prev)?
                .ok_or_else(|| anyhow::anyhow!("Superseded fact '{}' not found.", prev))?;
            if old.project_id != fact.project_id {
                bail!("Cannot supersede a fact from another project.");
            }
        }
        let id = next_prefixed_id(self.connection(), "authoritative_facts", "FACT")?;
        let now = chrono::Utc::now().to_rfc3339();
        self.connection().execute(
            "INSERT INTO authoritative_facts
             (fact_id, project_id, subject, predicate, value, value_type, status,
              valid_from, valid_until, source_kind, source_ref, source_digest,
              notes, created_at, created_by, supersedes_fact_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                id,
                fact.project_id,
                fact.subject,
                fact.predicate,
                fact.value,
                fact.value_type.as_str(),
                fact.valid_from,
                fact.valid_until,
                fact.source_kind.as_str(),
                fact.source_ref,
                fact.source_digest,
                fact.notes,
                now,
                fact.created_by,
                fact.supersedes_fact_id,
            ],
        )?;
        // Versioning, not overwriting: the superseded row stays readable.
        if let Some(prev) = fact.supersedes_fact_id {
            self.connection().execute(
                "UPDATE authoritative_facts SET status = 'superseded' WHERE fact_id = ?1",
                params![prev],
            )?;
        }
        Ok(id)
    }

    pub fn get_fact(&self, fact_id: &str) -> Result<Option<AuthoritativeFact>> {
        let sql = format!(
            "SELECT {} FROM authoritative_facts WHERE fact_id = ?1",
            FACT_COLUMNS
        );
        let mut stmt = self.connection().prepare(&sql)?;
        let mut rows = stmt.query_map(params![fact_id], map_fact)?;
        Ok(rows.next().transpose()?)
    }

    pub fn list_facts(&self, project_id: &str) -> Result<Vec<AuthoritativeFact>> {
        let sql = format!(
            "SELECT {} FROM authoritative_facts WHERE project_id = ?1 ORDER BY created_at ASC",
            FACT_COLUMNS
        );
        let mut stmt = self.connection().prepare(&sql)?;
        let rows = stmt.query_map(params![project_id], map_fact)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Facts whose normalized validity window covers `at` (RFC3339).
    /// History stays comparable against the fact valid at observation time.
    /// Malformed stored windows fail loudly rather than silently matching.
    pub fn facts_valid_at(&self, project_id: &str, at: &str) -> Result<Vec<AuthoritativeFact>> {
        let ts = parse_observation_instant(at)?;
        let mut out = Vec::new();
        for f in self.list_facts(project_id)? {
            let (start, end) = normalize_window(f.valid_from.as_deref(), f.valid_until.as_deref())
                .map_err(|e| {
                    anyhow::anyhow!("Stored fact '{}' has an invalid window: {}", f.fact_id, e)
                })?;
            if instant_in_window(ts, start, end) {
                out.push(f);
            }
        }
        Ok(out)
    }

    /// Derived authority conflicts: groups of 2+ ACTIVE facts sharing
    /// (project, subject, predicate) whose normalized windows overlap.
    /// SUPERSEDED/RETIRED rows are history, never conflicts. No winner is
    /// chosen; identical values surface as REDUNDANT, differing values as
    /// FACT_AUTHORITY_CONFLICT.
    pub fn authority_conflicts(&self, project_id: &str) -> Result<Vec<FactAuthorityConflict>> {
        use std::collections::BTreeMap;
        let mut groups: BTreeMap<(String, String), Vec<AuthoritativeFact>> = BTreeMap::new();
        for f in self.list_facts(project_id)? {
            if f.status != FactStatus::Active {
                continue;
            }
            // Skip rows whose stored window cannot normalize: surfaced
            // through facts_valid_at errors, not hidden inside conflicts.
            if normalize_window(f.valid_from.as_deref(), f.valid_until.as_deref()).is_err() {
                continue;
            }
            groups
                .entry((f.subject.clone(), f.predicate.clone()))
                .or_default()
                .push(f);
        }
        let mut out = Vec::new();
        for ((subject, predicate), facts) in groups {
            if facts.len() < 2 {
                continue;
            }
            // Pairwise overlap via the joint interval: all windows must share
            // a common instant for a group conflict. Report maximal
            // overlapping subsets (simple O(n^2) pairwise scan is enough).
            let mut windows = Vec::new();
            for f in &facts {
                let (s, e) = normalize_window(f.valid_from.as_deref(), f.valid_until.as_deref())?;
                windows.push((s, e));
            }
            // Find connected overlapping components.
            let n = facts.len();
            let mut parent: Vec<usize> = (0..n).collect();
            fn find(p: &mut [usize], mut x: usize) -> usize {
                while p[x] != x {
                    p[x] = p[p[x]];
                    x = p[x];
                }
                x
            }
            let overlaps = |a: (Option<i64>, Option<i64>), b: (Option<i64>, Option<i64>)| {
                overlap_interval(&[a, b]).is_some()
            };
            for i in 0..n {
                for j in (i + 1)..n {
                    if overlaps(windows[i], windows[j]) {
                        let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                        parent[ri] = rj;
                    }
                }
            }
            let mut components: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
            for i in 0..n {
                let r = find(&mut parent, i);
                components.entry(r).or_default().push(i);
            }
            for members in components.values() {
                if members.len() < 2 {
                    continue;
                }
                let member_windows: Vec<_> = members.iter().map(|&i| windows[i]).collect();
                let (os, oe) = overlap_interval(&member_windows).unwrap_or((None, None));
                let values: std::collections::HashSet<&str> =
                    members.iter().map(|&i| facts[i].value.as_str()).collect();
                out.push(FactAuthorityConflict {
                    project_id: project_id.to_string(),
                    subject: subject.clone(),
                    predicate: predicate.clone(),
                    fact_ids: members.iter().map(|&i| facts[i].fact_id.clone()).collect(),
                    overlap_start: format_bound(os),
                    overlap_end: format_bound(oe),
                    kind: if values.len() == 1 {
                        AuthorityConflictKind::RedundantActiveFacts
                    } else {
                        AuthorityConflictKind::ConflictingActiveFacts
                    },
                });
            }
        }
        Ok(out)
    }

    /// True when any referenced fact participates in an unresolved conflict.
    pub fn facts_in_conflict(&self, project_id: &str, fact_ids: &[String]) -> Result<bool> {
        for conflict in self.authority_conflicts(project_id)? {
            if conflict.fact_ids.iter().any(|id| fact_ids.contains(id)) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn retire_fact(&self, fact_id: &str) -> Result<AuthoritativeFact> {
        self.get_fact(fact_id)?
            .ok_or_else(|| anyhow::anyhow!("Fact '{}' not found.", fact_id))?;
        self.connection().execute(
            "UPDATE authoritative_facts SET status = 'retired' WHERE fact_id = ?1",
            params![fact_id],
        )?;
        self.get_fact(fact_id)?
            .ok_or_else(|| anyhow::anyhow!("Fact vanished."))
    }

    /// Insert a manually selected claim. The observation MUST exist —
    /// unknown IDs fail, never fabricate.
    pub fn insert_claim(&self, claim: &NewClaim) -> Result<String> {
        if claim.claim_text.trim().is_empty() {
            bail!("Claim text must not be empty.");
        }
        let obs_exists: i64 = self.connection().query_row(
            "SELECT COUNT(*) FROM observations WHERE observation_id = ?1",
            params![claim.observation_id],
            |r| r.get(0),
        )?;
        if obs_exists == 0 {
            bail!(
                "Observation '{}' not found. Claims must reference an existing observation.",
                claim.observation_id
            );
        }
        let origin = if claim.source_span_text.is_some() {
            ClaimOrigin::ExactSpan
        } else {
            ClaimOrigin::ManualTranscription
        };
        let id = next_prefixed_id(self.connection(), "candidate_claims", "CLM")?;
        let now = chrono::Utc::now().to_rfc3339();
        self.connection().execute(
            "INSERT INTO candidate_claims
             (claim_id, project_id, observation_id, claim_text, source_span_text,
              source_part, start_offset, end_offset, claim_subject, claim_type,
              claim_origin, created_at, created_by, extraction_method)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'manual')",
            params![
                id,
                claim.project_id,
                claim.observation_id,
                claim.claim_text,
                claim.source_span_text,
                claim.source_part,
                claim.start_offset,
                claim.end_offset,
                claim.claim_subject,
                claim.claim_type,
                origin.as_str(),
                now,
                claim.created_by,
            ],
        )?;
        Ok(id)
    }

    pub fn get_claim(&self, claim_id: &str) -> Result<Option<CandidateClaim>> {
        let sql = format!(
            "SELECT {} FROM candidate_claims WHERE claim_id = ?1",
            CLAIM_COLUMNS
        );
        let mut stmt = self.connection().prepare(&sql)?;
        let mut rows = stmt.query_map(params![claim_id], map_claim)?;
        Ok(rows.next().transpose()?)
    }

    pub fn list_claims(&self, project_id: &str) -> Result<Vec<CandidateClaim>> {
        let sql = format!(
            "SELECT {} FROM candidate_claims WHERE project_id = ?1 ORDER BY created_at ASC",
            CLAIM_COLUMNS
        );
        let mut stmt = self.connection().prepare(&sql)?;
        let rows = stmt.query_map(params![project_id], map_claim)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Insert a human judgment. Contract: an identical judgment
    /// (same claim + facts + verdict + reviewer) is idempotent and returns
    /// the existing id; a changed decision is a new version, optionally
    /// linked via `supersedes_judgment_id`. Never silently duplicates.
    pub fn insert_judgment(&self, judgment: &NewJudgment) -> Result<String> {
        if judgment.fact_ids.is_empty() {
            bail!("A judgment must reference at least one fact.");
        }
        let claim = self
            .get_claim(judgment.claim_id)?
            .ok_or_else(|| anyhow::anyhow!("Claim '{}' not found.", judgment.claim_id))?;
        for fid in judgment.fact_ids {
            let fact = self
                .get_fact(fid)?
                .ok_or_else(|| anyhow::anyhow!("Fact '{}' not found.", fid))?;
            if fact.project_id != claim.project_id {
                bail!("Fact '{}' belongs to another project.", fid);
            }
        }
        if let Some(prev) = judgment.supersedes_judgment_id {
            let old = self
                .get_judgment(prev)?
                .ok_or_else(|| anyhow::anyhow!("Superseded judgment '{}' not found.", prev))?;
            if old.claim_id != judgment.claim_id {
                bail!("Can only supersede a judgment on the same claim.");
            }
        }
        // Idempotency: identical (claim, facts, verdict, reviewer) returns
        // the existing row instead of duplicating.
        let mut want_facts = judgment.fact_ids.to_vec();
        want_facts.sort();
        for existing in self.list_judgments(judgment.claim_id)? {
            let mut have_facts = existing.fact_ids.clone();
            have_facts.sort();
            if have_facts == want_facts
                && existing.verdict == judgment.verdict
                && existing.reviewer == judgment.reviewer
                && existing.supersedes_judgment_id.as_deref() == judgment.supersedes_judgment_id
            {
                return Ok(existing.judgment_id);
            }
        }
        let version = self.list_judgments(judgment.claim_id)?.len() as u32 + 1;
        let id = next_prefixed_id(self.connection(), "human_judgments", "JDG")?;
        let now = chrono::Utc::now().to_rfc3339();
        self.connection().execute(
            "INSERT INTO human_judgments
             (judgment_id, claim_id, fact_ids_json, verdict, rationale, reviewer,
              reviewed_at, judgment_version, supersedes_judgment_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                judgment.claim_id,
                serde_json::to_string(&want_facts)?,
                judgment.verdict.as_str(),
                judgment.rationale,
                judgment.reviewer,
                now,
                version as i64,
                judgment.supersedes_judgment_id,
                now,
            ],
        )?;
        Ok(id)
    }

    pub fn get_judgment(&self, judgment_id: &str) -> Result<Option<HumanJudgment>> {
        let sql = format!(
            "SELECT {} FROM human_judgments WHERE judgment_id = ?1",
            JUDGMENT_COLUMNS
        );
        let mut stmt = self.connection().prepare(&sql)?;
        let mut rows = stmt.query_map(params![judgment_id], map_judgment)?;
        Ok(rows.next().transpose()?)
    }

    pub fn list_judgments(&self, claim_id: &str) -> Result<Vec<HumanJudgment>> {
        let sql = format!(
            "SELECT {} FROM human_judgments WHERE claim_id = ?1 ORDER BY judgment_version ASC",
            JUDGMENT_COLUMNS
        );
        let mut stmt = self.connection().prepare(&sql)?;
        let rows = stmt.query_map(params![claim_id], map_judgment)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Latest valid judgment for a claim: the one no other judgment
    /// supersedes (ties broken by version). None when unjudged.
    pub fn latest_judgment(&self, claim_id: &str) -> Result<Option<HumanJudgment>> {
        let all = self.list_judgments(claim_id)?;
        if all.is_empty() {
            return Ok(None);
        }
        let superseded: std::collections::HashSet<String> = all
            .iter()
            .filter_map(|j| j.supersedes_judgment_id.clone())
            .collect();
        Ok(all
            .into_iter()
            .filter(|j| !superseded.contains(&j.judgment_id))
            .max_by_key(|j| j.judgment_version))
    }

    /// Derive the current integrity state for one claim. Explicitly derived,
    /// never stored: claim + latest judgment + referenced facts.
    pub fn integrity_finding(&self, claim_id: &str) -> Result<Option<IntegrityFinding>> {
        let claim = match self.get_claim(claim_id)? {
            Some(c) => c,
            None => return Ok(None),
        };
        let judgment = self.latest_judgment(claim_id)?;
        let mut facts = Vec::new();
        if let Some(j) = &judgment {
            for fid in &j.fact_ids {
                if let Some(f) = self.get_fact(fid)? {
                    facts.push(f);
                }
            }
        }
        let state = judgment.as_ref().map(|j| j.verdict.finding_state());
        Ok(Some(IntegrityFinding {
            claim_id: claim.claim_id,
            state,
            judgment,
            facts,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observations::{
        FailureClass, NewObservation, ObservationType, ReportIdentity, RetrievalMode,
    };
    use tempfile::TempDir;

    fn open_test_db() -> (TempDir, AuditStorage) {
        let dir = TempDir::new().unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
        (dir, storage)
    }

    fn fact<'a>(
        subject: &'a str,
        predicate: &'a str,
        value: &'a str,
        vtype: FactValueType,
    ) -> NewFact<'a> {
        NewFact {
            project_id: "example.com",
            subject,
            predicate,
            value,
            value_type: vtype,
            valid_from: None,
            valid_until: None,
            source_kind: FactSourceKind::Manual,
            source_ref: None,
            source_digest: None,
            notes: None,
            created_by: "human",
            supersedes_fact_id: None,
        }
    }

    fn seed_observation(storage: &AuditStorage) -> String {
        let payload = serde_json::json!({"text": "Ghostping costs $29 per month."});
        let raw = b"ghostping-observation-bytes";
        // Capture the generated id via a second read: insert, then list.
        storage
            .insert_observation(&NewObservation {
                observation_id: None,
                project_id: "example.com",
                observation_type: ObservationType::ParametricAnswer,
                surface: "gemini-api",
                collected_at: "2026-09-29T00:00:00Z",
                provider: Some("gemini"),
                model: Some("gemini-2.0-flash"),
                retrieval_mode: RetrievalMode::Parametric,
                region: None,
                language: None,
                prompt_group: Some("demo"),
                prompt_variant: None,
                url_digest: None,
                planned: 1,
                succeeded: 1,
                failed: 0,
                failure_class: FailureClass::None,
                latency_ms: None,
                cost_usd: None,
                dedupe_key: "seed-obs-1",
                report_identity: ReportIdentity::Unknown,
                raw_bytes: raw,
                payload: &payload,
            })
            .unwrap();
        let listed = storage
            .list_observations("example.com", Some(ObservationType::ParametricAnswer))
            .unwrap();
        listed[0].observation_id.clone()
    }

    #[test]
    fn test_fact_versioning_never_overwrites() {
        let (_dir, storage) = open_test_db();
        let id1 = storage
            .insert_fact(&fact(
                "pricing",
                "monthly_price",
                "$29",
                FactValueType::Currency,
            ))
            .unwrap();
        assert_eq!(&id1, "FACT-0001");
        let mut v2 = fact("pricing", "monthly_price", "$39", FactValueType::Currency);
        v2.valid_from = Some("2026-09-01");
        v2.supersedes_fact_id = Some(&id1);
        let id2 = storage.insert_fact(&v2).unwrap();

        // Old row intact, now marked superseded; new row active.
        assert_eq!(
            storage.get_fact(&id1).unwrap().unwrap().status,
            FactStatus::Superseded
        );
        assert_eq!(storage.get_fact(&id1).unwrap().unwrap().value, "$29");
        assert_eq!(
            storage.get_fact(&id2).unwrap().unwrap().status,
            FactStatus::Active
        );
        assert_eq!(storage.list_facts("example.com").unwrap().len(), 2);

        // Retire keeps the row readable.
        storage.retire_fact(&id2).unwrap();
        assert_eq!(
            storage.get_fact(&id2).unwrap().unwrap().status,
            FactStatus::Retired
        );
    }

    #[test]
    fn test_fact_validation_rejects_bad_values() {
        let (_dir, storage) = open_test_db();
        // Wrong value type.
        assert!(storage
            .insert_fact(&fact("x", "y", "not-a-number", FactValueType::Number))
            .is_err());
        assert!(storage
            .insert_fact(&fact("x", "y", "maybe", FactValueType::Boolean))
            .is_err());
        assert!(storage
            .insert_fact(&fact("x", "y", "09/29/2026", FactValueType::Date))
            .is_err());
        assert!(storage
            .insert_fact(&fact("x", "y", "example.com", FactValueType::Url))
            .is_err());
        // Inverted validity window.
        let mut bad = fact("x", "y", "v", FactValueType::Text);
        bad.valid_from = Some("2026-09-02");
        bad.valid_until = Some("2026-09-01");
        assert!(storage.insert_fact(&bad).is_err());
        // Unknown supersede target and cross-project supersede.
        let mut ghost = fact("x", "y", "v", FactValueType::Text);
        ghost.supersedes_fact_id = Some("FACT-9999");
        assert!(storage.insert_fact(&ghost).is_err());
        // Valid shapes pass for every type.
        for (vtype, value) in [
            (FactValueType::Text, "hello"),
            (FactValueType::Number, "1,299.50"),
            (FactValueType::Currency, "$39"),
            (FactValueType::Boolean, "yes"),
            (FactValueType::Date, "2026-09-01"),
            (FactValueType::Url, "https://example.com/x"),
            (FactValueType::Enum, "pro"),
        ] {
            assert!(storage.insert_fact(&fact("s", "p", value, vtype)).is_ok());
        }
    }

    #[test]
    fn test_temporal_boundaries_half_open_utc() {
        let (_dir, storage) = open_test_db();
        // Required historical scenario: FACT-A [$29, 2026-01-01 → 2026-08-31],
        // FACT-B [$39, 2026-09-01 → open].
        let mut fa = fact("pricing", "monthly_price", "$29", FactValueType::Currency);
        fa.valid_from = Some("2026-01-01");
        fa.valid_until = Some("2026-08-31");
        storage.insert_fact(&fa).unwrap();
        let mut fb = fact("pricing", "monthly_price", "$39", FactValueType::Currency);
        fb.valid_from = Some("2026-09-01");
        storage.insert_fact(&fb).unwrap();

        let at = |ts: &str| {
            storage
                .facts_valid_at("example.com", ts)
                .unwrap()
                .into_iter()
                .map(|f| f.value)
                .collect::<Vec<_>>()
        };
        // Whole-day rule: 2026-08-31T15:00Z is inside FACT-A's final day.
        let aug31 = at("2026-08-31T15:00:00Z");
        assert!(aug31.contains(&"$29".to_string()), "{:?}", aug31);
        assert!(!aug31.contains(&"$39".to_string()));
        // Exclusive end: midnight belongs to FACT-B, not FACT-A.
        let sep01 = at("2026-09-01T00:00:00Z");
        assert!(sep01.contains(&"$39".to_string()), "{:?}", sep01);
        assert!(!sep01.contains(&"$29".to_string()));

        // Mixed precision: date-only start with RFC3339 offset end.
        let mut m = fact("x", "y", "v", FactValueType::Text);
        m.valid_from = Some("2026-09-01");
        m.valid_until = Some("2026-10-01T03:00:00+08:00"); // = 2026-09-30T19:00Z
        storage.insert_fact(&m).unwrap();
        assert!(storage
            .facts_valid_at("example.com", "2026-09-30T18:00:00Z")
            .unwrap()
            .iter()
            .any(|f| f.value == "v"));
        assert!(!storage
            .facts_valid_at("example.com", "2026-09-30T19:00:00Z")
            .unwrap()
            .iter()
            .any(|f| f.value == "v"));

        // Adjacent [start,end) bounds never double-include.
        let mut adj_a = fact("adj", "k", "a", FactValueType::Text);
        adj_a.valid_until = Some("2026-09-01T00:00:00Z");
        storage.insert_fact(&adj_a).unwrap();
        let mut adj_b = fact("adj", "k", "b", FactValueType::Text);
        adj_b.valid_from = Some("2026-09-01T00:00:00Z");
        storage.insert_fact(&adj_b).unwrap();
        assert!(storage
            .authority_conflicts("example.com")
            .unwrap()
            .iter()
            .all(|c| !(c.subject == "adj" && c.predicate == "k")));

        // Malformed and inverted windows rejected at creation.
        for (from, until) in [
            (Some("09/01/2026"), None),
            (Some("2026-09-01"), Some("not-a-date")),
            (Some("2026-09-02"), Some("2026-09-01")),
            (Some("2026-09-01T10:00:00Z"), Some("2026-09-01T09:00:00Z")),
        ] {
            let mut bad = fact("bad", "w", "v", FactValueType::Text);
            bad.valid_from = from;
            bad.valid_until = until;
            assert!(
                storage.insert_fact(&bad).is_err(),
                "accepted {:?} → {:?}",
                from,
                until
            );
        }
    }

    #[test]
    fn test_conflict_regression_matrix() {
        let (_dir, storage) = open_test_db();
        let add = |storage: &AuditStorage,
                   subject: &str,
                   predicate: &str,
                   value: &str,
                   from: Option<&str>,
                   until: Option<&str>,
                   retire: bool| {
            let id = storage
                .insert_fact(&NewFact {
                    project_id: "example.com",
                    subject,
                    predicate,
                    value,
                    value_type: FactValueType::Text,
                    valid_from: from,
                    valid_until: until,
                    source_kind: FactSourceKind::Manual,
                    source_ref: None,
                    source_digest: None,
                    notes: None,
                    created_by: "human",
                    supersedes_fact_id: None,
                })
                .unwrap();
            if retire {
                storage.retire_fact(&id).unwrap();
            }
            id
        };
        let conflicts_for = |s: &str, p: &str| {
            storage
                .authority_conflicts("example.com")
                .unwrap()
                .into_iter()
                .filter(|c| c.subject == s && c.predicate == p)
                .collect::<Vec<_>>()
        };

        // Non-overlapping windows: no conflict.
        add(
            &storage,
            "a",
            "p",
            "v1",
            Some("2026-01-01"),
            Some("2026-06-30"),
            false,
        );
        add(&storage, "a", "p", "v2", Some("2026-07-01"), None, false);
        assert!(conflicts_for("a", "p").is_empty());

        // Overlapping windows, different values: conflict with overlap math.
        add(&storage, "b", "p", "$29", Some("2026-01-01"), None, false);
        add(&storage, "b", "p", "$39", Some("2026-09-01"), None, false);
        let c = conflicts_for("b", "p");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].kind, AuthorityConflictKind::ConflictingActiveFacts);
        assert_eq!(c[0].fact_ids.len(), 2);
        assert_eq!(c[0].overlap_start.as_deref(), Some("2026-09-01T00:00:00Z"));
        assert_eq!(c[0].overlap_end, None); // open-ended

        // Both open-ended: conflict.
        add(&storage, "c", "p", "x", None, None, false);
        add(&storage, "c", "p", "y", None, None, false);
        assert_eq!(conflicts_for("c", "p").len(), 1);

        // Identical values overlapping: redundant, still surfaced.
        add(&storage, "d", "p", "same", Some("2026-01-01"), None, false);
        add(&storage, "d", "p", "same", Some("2026-06-01"), None, false);
        let d = conflicts_for("d", "p");
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].kind, AuthorityConflictKind::RedundantActiveFacts);

        // Different predicate / subject: no conflict.
        add(&storage, "e", "p1", "v", Some("2026-01-01"), None, false);
        add(&storage, "e", "p2", "v", Some("2026-01-01"), None, false);
        add(&storage, "f", "p1", "v", Some("2026-01-01"), None, false);
        assert!(conflicts_for("e", "p1").is_empty());
        assert!(conflicts_for("e", "p2").is_empty());

        // ACTIVE + SUPERSEDED via real supersession: no active conflict.
        let old = add(&storage, "g", "p", "old", Some("2026-01-01"), None, false);
        storage
            .insert_fact(&NewFact {
                project_id: "example.com",
                subject: "g",
                predicate: "p",
                value: "new",
                value_type: FactValueType::Text,
                valid_from: Some("2026-01-01"),
                valid_until: None,
                source_kind: FactSourceKind::Manual,
                source_ref: None,
                source_digest: None,
                notes: None,
                created_by: "human",
                supersedes_fact_id: Some(&old),
            })
            .unwrap();
        assert!(conflicts_for("g", "p").is_empty());

        // ACTIVE + RETIRED: no active conflict.
        add(&storage, "h", "p", "old", Some("2026-01-01"), None, true);
        add(&storage, "h", "p", "new", Some("2026-01-01"), None, false);
        assert!(conflicts_for("h", "p").is_empty());
    }

    #[test]
    fn test_export_assay_matrix() {
        // Full export contract at storage level: label mapping, version
        // gating, multi-fact preservation, determinism.
        let (_dir, storage) = open_test_db();
        let obs = seed_observation(&storage);
        for (verdict, state) in [
            (JudgmentVerdict::Supported, "SUPPORTED"),
            (JudgmentVerdict::Contradicted, "CONTRADICTION"),
            (JudgmentVerdict::Partial, "PARTIAL"),
            (JudgmentVerdict::InsufficientEvidence, "INSUFFICIENT"),
        ] {
            let claim_id = storage
                .insert_claim(&NewClaim {
                    project_id: "example.com",
                    observation_id: &obs,
                    claim_text: "Some claim.",
                    source_span_text: None,
                    source_part: None,
                    start_offset: None,
                    end_offset: None,
                    claim_subject: None,
                    claim_type: None,
                    created_by: "human",
                })
                .unwrap();
            let f1 = storage
                .insert_fact(&fact("s", "p", "v1", FactValueType::Text))
                .unwrap();
            let f2 = storage
                .insert_fact(&fact("s", "p", "v2", FactValueType::Text))
                .unwrap();
            let jid = storage
                .insert_judgment(&NewJudgment {
                    claim_id: &claim_id,
                    fact_ids: &[f1.clone(), f2.clone()],
                    verdict,
                    rationale: Some("notes"),
                    reviewer: "human",
                    supersedes_judgment_id: None,
                })
                .unwrap();
            let finding = storage.integrity_finding(&claim_id).unwrap().unwrap();
            assert_eq!(finding.state, Some(state));
            assert_eq!(finding.facts.len(), 2);
            assert_eq!(finding.judgment.as_ref().unwrap().judgment_id, jid);
            // Supersede, then confirm only the latest is current.
            let jid2 = storage
                .insert_judgment(&NewJudgment {
                    claim_id: &claim_id,
                    fact_ids: std::slice::from_ref(&f1),
                    verdict: JudgmentVerdict::InsufficientEvidence,
                    rationale: None,
                    reviewer: "human",
                    supersedes_judgment_id: Some(&jid),
                })
                .unwrap();
            assert_eq!(
                storage
                    .latest_judgment(&claim_id)
                    .unwrap()
                    .unwrap()
                    .judgment_id,
                jid2
            );
        }
    }

    #[test]
    fn test_facts_valid_at_window() {
        let (_dir, storage) = open_test_db();
        let mut old = fact("pricing", "monthly_price", "$29", FactValueType::Currency);
        old.valid_from = Some("2026-01-01");
        old.valid_until = Some("2026-08-31");
        storage.insert_fact(&old).unwrap();
        let mut new = fact("pricing", "monthly_price", "$39", FactValueType::Currency);
        new.valid_from = Some("2026-09-01");
        storage.insert_fact(&new).unwrap();
        let mut undated = fact("brand", "name", "Ghostping", FactValueType::Text);
        undated.valid_from = None;
        storage.insert_fact(&undated).unwrap();

        let july: Vec<String> = storage
            .facts_valid_at("example.com", "2026-07-15T00:00:00Z")
            .unwrap()
            .into_iter()
            .map(|f| f.value)
            .collect();
        assert!(july.contains(&"$29".to_string()));
        assert!(!july.contains(&"$39".to_string()));
        let sept: Vec<String> = storage
            .facts_valid_at("example.com", "2026-09-29T00:00:00Z")
            .unwrap()
            .into_iter()
            .map(|f| f.value)
            .collect();
        assert!(sept.contains(&"$39".to_string()));
        assert!(!sept.contains(&"$29".to_string()));
        assert!(sept.contains(&"Ghostping".to_string()));
    }

    #[test]
    fn test_claim_requires_existing_observation() {
        let (_dir, storage) = open_test_db();
        let bad = NewClaim {
            project_id: "example.com",
            observation_id: "obs_nope",
            claim_text: "Ghostping costs $29 per month.",
            source_span_text: None,
            source_part: None,
            start_offset: None,
            end_offset: None,
            claim_subject: None,
            claim_type: None,
            created_by: "human",
        };
        // Unknown observation: hard error, never fabricated.
        assert!(storage.insert_claim(&bad).is_err());

        let obs = seed_observation(&storage);
        let mut manual = bad;
        let obs_owned = obs.clone();
        manual.observation_id = &obs_owned;
        let id = storage.insert_claim(&manual).unwrap();
        assert_eq!(&id, "CLM-0001");
        let saved = storage.get_claim(&id).unwrap().unwrap();
        assert_eq!(saved.claim_origin, ClaimOrigin::ManualTranscription);
        assert_eq!(saved.extraction_method, "manual");

        // Exact span with offsets preserved verbatim.
        let spanned = NewClaim {
            project_id: "example.com",
            observation_id: &saved.observation_id,
            claim_text: "Ghostping costs $29 per month.",
            source_span_text: Some("Ghostping costs $29 per month."),
            source_part: Some(0),
            start_offset: Some(0),
            end_offset: Some(32),
            claim_subject: None,
            claim_type: None,
            created_by: "human",
        };
        let id2 = storage.insert_claim(&spanned).unwrap();
        let saved2 = storage.get_claim(&id2).unwrap().unwrap();
        assert_eq!(saved2.claim_origin, ClaimOrigin::ExactSpan);
        assert_eq!(saved2.start_offset, Some(0));
        assert_eq!(saved2.end_offset, Some(32));

        // Empty text rejected.
        let mut empty = spanned;
        empty.claim_text = "  ";
        assert!(storage.insert_claim(&empty).is_err());
    }

    #[test]
    fn test_judgment_idempotent_versioned_and_validated() {
        let (_dir, storage) = open_test_db();
        let obs = seed_observation(&storage);
        let claim_id = storage
            .insert_claim(&NewClaim {
                project_id: "example.com",
                observation_id: &obs,
                claim_text: "Ghostping costs $29 per month.",
                source_span_text: None,
                source_part: None,
                start_offset: None,
                end_offset: None,
                claim_subject: None,
                claim_type: None,
                created_by: "human",
            })
            .unwrap();
        let fact_id = storage
            .insert_fact(&fact(
                "pricing",
                "monthly_price",
                "$39",
                FactValueType::Currency,
            ))
            .unwrap();

        let base = NewJudgment {
            claim_id: &claim_id,
            fact_ids: std::slice::from_ref(&fact_id),
            verdict: JudgmentVerdict::Contradicted,
            rationale: Some("Fact says $39."),
            reviewer: "human",
            supersedes_judgment_id: None,
        };
        let j1 = storage.insert_judgment(&base).unwrap();
        assert_eq!(&j1, "JDG-0001");
        // Identical repeat: idempotent, same id, no duplicate row.
        let j1_again = storage.insert_judgment(&base).unwrap();
        assert_eq!(j1_again, j1);
        assert_eq!(storage.list_judgments(&claim_id).unwrap().len(), 1);

        // Changed decision: new version, linked (base rebuilt: NewJudgment
        // carries borrowed fields, so each version is constructed explicitly).
        let v2 = NewJudgment {
            claim_id: &claim_id,
            fact_ids: std::slice::from_ref(&fact_id),
            verdict: JudgmentVerdict::Partial,
            rationale: Some("On reflection, partially."),
            reviewer: "human",
            supersedes_judgment_id: Some(&j1),
        };
        let j2 = storage.insert_judgment(&v2).unwrap();
        assert_ne!(j2, j1);
        // Latest resolves to V2; V1 intact.
        let latest = storage.latest_judgment(&claim_id).unwrap().unwrap();
        assert_eq!(latest.judgment_id, j2);
        assert_eq!(latest.judgment_version, 2);
        assert!(storage.get_judgment(&j1).unwrap().is_some());

        // Unknown claim / fact / cross-claim supersede: hard errors.
        let bad_claim = NewJudgment {
            claim_id: "CLM-9999",
            ..v2
        };
        assert!(storage.insert_judgment(&bad_claim).is_err());
        let bad_fact = NewJudgment {
            fact_ids: &["FACT-9999".to_string()],
            ..v2
        };
        assert!(storage.insert_judgment(&bad_fact).is_err());
        let empty_facts = NewJudgment {
            fact_ids: &[],
            ..v2
        };
        assert!(storage.insert_judgment(&empty_facts).is_err());
    }

    #[test]
    fn test_finding_derivation_and_unjudged_state() {
        let (_dir, storage) = open_test_db();
        let obs = seed_observation(&storage);
        let claim_id = storage
            .insert_claim(&NewClaim {
                project_id: "example.com",
                observation_id: &obs,
                claim_text: "Ghostping costs $29 per month.",
                source_span_text: None,
                source_part: None,
                start_offset: None,
                end_offset: None,
                claim_subject: None,
                claim_type: None,
                created_by: "human",
            })
            .unwrap();
        // Unjudged: explicit None state, not an error.
        let finding = storage.integrity_finding(&claim_id).unwrap().unwrap();
        assert_eq!(finding.state, None);
        assert!(finding.judgment.is_none());

        let fact_id = storage
            .insert_fact(&fact(
                "pricing",
                "monthly_price",
                "$39",
                FactValueType::Currency,
            ))
            .unwrap();
        storage
            .insert_judgment(&NewJudgment {
                claim_id: &claim_id,
                fact_ids: std::slice::from_ref(&fact_id),
                verdict: JudgmentVerdict::Contradicted,
                rationale: None,
                reviewer: "human",
                supersedes_judgment_id: None,
            })
            .unwrap();
        let finding = storage.integrity_finding(&claim_id).unwrap().unwrap();
        assert_eq!(finding.state, Some("CONTRADICTION"));
        assert_eq!(finding.facts.len(), 1);
        assert_eq!(finding.facts[0].fact_id, fact_id);
        // Unknown claim: None, not an error.
        assert!(storage.integrity_finding("CLM-9999").unwrap().is_none());
    }

    #[test]
    fn test_legacy_database_gains_integrity_tables() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("legacy.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE audit_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,
                 project_id TEXT NOT NULL, started_at TEXT NOT NULL);",
            )
            .unwrap();
        }
        let storage = AuditStorage::open(&db_path).unwrap();
        let id = storage
            .insert_fact(&fact("s", "p", "v", FactValueType::Text))
            .unwrap();
        assert_eq!(&id, "FACT-0001");
        assert_eq!(storage.list_facts("example.com").unwrap().len(), 1);
    }
}
