//! Google Search Console CSV import (first-party evidence).
//!
//! Uses authorized user exports — there is no dedicated API assumption.
//!
//! ## Report identity
//!
//! Google publishes ordinary performance exports (`Top queries`, with
//! clicks) and dedicated **Generative AI** reports (Search: AI Overviews +
//! AI Mode; Discover: AI features) showing impressions/pages/countries/
//! devices/dates with **no clicks or CTR** (Google Search Central, June 2026).
//! Exports do not cryptographically establish origin: the caller declares
//! the identity with `--report`, and a declaration stays a declaration.
//!
//! Rules enforced here:
//! - `generic_search`: ordinary shape (clicks required). NEVER enters AI metrics.
//! - `generative_ai_search` / `generative_ai_discover`: clicks/CTR columns
//!   rejected outright; `query` dimension rejected (undocumented for AI
//!   reports); `device` rejected for Discover (Search-only per Google docs).
//! - The AI-report CSV shape is UNVERIFIED against a genuine authorized
//!   sample (none available): accepted headers are the documented dimension
//!   set, and every AI row/view is labeled UNVERIFIED.
//!
//! ## Aggregation honesty
//!
//! Query/page/country/device/date breakdowns of one export are different
//! cuts of the same exposure, not independent exposures — they are stored
//! as separate rows with their dimensions and reported per-breakdown, never
//! summed into one total (except clicks/impressions within a single
//! breakdown, which the source already aggregated compatibly).
//!
//! ## Unavailable vs zero
//!
//! Google renders unavailable CTR/position cells empty in CSV exports; empty
//! stays NULL (unknown), never zero. An explicit `0`/`0%` is an observed
//! zero. (Note: some Search Console UI views display unavailable values as
//! 0 — exports are authoritative here, not the UI rendering.)

use anyhow::{bail, Context, Result};

use crate::audit_storage::AuditStorage;
use crate::observations::{
    sha256_hex, FailureClass, ImportBatchRecord, NewObservation, ObservationType, ReportIdentity,
    RetrievalMode,
};

pub const GSC_SOURCE_KIND: &str = "search_console_csv";
pub const GSC_SURFACE: &str = "search-console";

/// Reporting period covered by one export.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportPeriod {
    pub start: String,
    pub end: String,
}

impl ImportPeriod {
    pub fn single(date: &str) -> Result<Self> {
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| anyhow::anyhow!("Invalid date '{}': use YYYY-MM-DD.", date))?;
        Ok(Self {
            start: date.to_string(),
            end: date.to_string(),
        })
    }

    pub fn range(start: &str, end: &str) -> Result<Self> {
        let s = chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d")
            .map_err(|_| anyhow::anyhow!("Invalid --start-date '{}': use YYYY-MM-DD.", start))?;
        let e = chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d")
            .map_err(|_| anyhow::anyhow!("Invalid --end-date '{}': use YYYY-MM-DD.", end))?;
        if e < s {
            bail!("--end-date {} is before --start-date {}.", end, start);
        }
        Ok(Self {
            start: start.to_string(),
            end: end.to_string(),
        })
    }

    pub fn key(&self) -> String {
        if self.start == self.end {
            self.start.clone()
        } else {
            format!("{}/{}", self.start, self.end)
        }
    }
}

/// One parsed export row with aggregation and dimensions preserved.
#[derive(Debug, Clone, PartialEq)]
pub struct GscRow {
    pub identity: ReportIdentity,
    /// Reporting dimension kind: query, page, country, device, or dimension.
    pub dimension_kind: String,
    pub dimension_value: String,
    pub country: Option<String>,
    pub device: Option<String>,
    pub clicks: Option<i64>,
    pub impressions: i64,
    /// CTR as a fraction (0.042 for "4.2%"); `None` when unavailable/absent.
    pub ctr: Option<f64>,
    /// Average position; `None` when unavailable/absent.
    pub position: Option<f64>,
    /// Original record exactly as read (keys lowercased).
    pub raw: serde_json::Value,
}

/// Outcome of [`import_gsc_csv`].
#[derive(Debug, Clone, PartialEq)]
pub struct GscImportOutcome {
    /// Rows stored as new observations.
    pub imported: usize,
    /// Rows skipped because the natural key already existed with identical data.
    pub skipped_duplicates: usize,
    /// Same natural key with different measurements: kept first, surfaced.
    pub conflicts: usize,
    /// True when the file digest was already imported for this period.
    pub skipped_file: bool,
    pub source_digest: String,
    pub identity: ReportIdentity,
    pub period: String,
}

fn parse_int_cell(raw: &str, line_no: usize, col: &str) -> Result<i64> {
    let cleaned: String = raw.chars().filter(|c| *c != ',').collect();
    cleaned
        .trim()
        .parse::<i64>()
        .with_context(|| format!("Line {}: bad integer in '{}': '{}'", line_no, col, raw))
}

fn parse_opt_float_cell(raw: &str, line_no: usize, col: &str) -> Result<Option<f64>> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    t.parse::<f64>()
        .with_context(|| format!("Line {}: bad number in '{}': '{}'", line_no, col, raw))
        .map(Some)
}

fn parse_ctr_cell(raw: &str, line_no: usize) -> Result<Option<f64>> {
    let t = raw.trim().trim_end_matches('%').trim();
    if t.is_empty() {
        return Ok(None);
    }
    t.parse::<f64>()
        .with_context(|| format!("Line {}: bad CTR value: '{}'", line_no, raw))
        .map(|v| Some(v / 100.0))
}

fn dimension_kind_for(header: &str) -> &str {
    match header.trim().to_lowercase().as_str() {
        "query" | "queries" | "top queries" => "query",
        "page" | "pages" | "top pages" | "url" | "urls" => "page",
        "country" | "countries" | "top countries" => "country",
        "device" | "devices" | "top devices" => "device",
        "date" | "dates" => "date",
        _ => "dimension",
    }
}

struct ParsedTable {
    headers: Vec<String>,
    records: Vec<Vec<String>>,
    title_skipped: bool,
}

/// Split bytes into header + records, skipping an optional `Top X` title line.
fn read_table(bytes: &[u8]) -> Result<ParsedTable> {
    let text = std::str::from_utf8(bytes).context("CSV is not valid UTF-8")?;
    let (body, title_skipped) = match text.lines().next() {
        Some(first) if !first.contains(',') && first.trim().to_lowercase().starts_with("top ") => {
            (text.lines().skip(1).collect::<Vec<_>>().join("\n"), true)
        }
        _ => (text.to_string(), false),
    };
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(body.as_bytes());
    let headers: Vec<String> = reader
        .headers()
        .context("CSV has no header row")?
        .iter()
        .map(|h| h.to_string())
        .collect();
    let mut records = Vec::new();
    for (i, record) in reader.records().enumerate() {
        let line_no = i + 2 + usize::from(title_skipped);
        let record = record.with_context(|| format!("Line {}: malformed CSV record", line_no))?;
        records.push(record.iter().map(|v| v.to_string()).collect());
    }
    Ok(ParsedTable {
        headers,
        records,
        title_skipped,
    })
}

/// Parse an ordinary Search export (clicks required). Identity: generic.
pub fn parse_generic_csv(bytes: &[u8]) -> Result<Vec<GscRow>> {
    let table = read_table(bytes)?;
    let names: Vec<String> = table.headers.iter().map(|h| h.to_lowercase()).collect();
    let line_base = usize::from(table.title_skipped);
    for required in ["clicks", "impressions"] {
        if !names.iter().any(|h| h == required) {
            bail!(
                "CSV header must contain '{}' for generic Search exports",
                required
            );
        }
    }
    let clicks_idx = names.iter().position(|h| h == "clicks").unwrap();
    let impressions_idx = names.iter().position(|h| h == "impressions").unwrap();
    let ctr_idx = names.iter().position(|h| h == "ctr");
    let position_idx = names.iter().position(|h| h == "position");
    let kind = dimension_kind_for(&table.headers[0]).to_string();

    let mut rows = Vec::new();
    for (i, record) in table.records.iter().enumerate() {
        let line_no = i + 2 + line_base;
        let get = |idx: usize| record.get(idx).map(|s| s.trim()).unwrap_or("");
        let value = get(0);
        if value.is_empty() {
            continue;
        }
        let mut raw_map = serde_json::Map::new();
        for (h, v) in table.headers.iter().zip(record.iter()) {
            raw_map.insert(h.to_lowercase(), serde_json::Value::String(v.clone()));
        }
        rows.push(GscRow {
            identity: ReportIdentity::GenericSearch,
            dimension_kind: kind.clone(),
            dimension_value: value.to_string(),
            country: column_value(&table.headers, record, "country"),
            device: column_value(&table.headers, record, "device"),
            clicks: Some(parse_int_cell(get(clicks_idx), line_no, "clicks")?),
            impressions: parse_int_cell(get(impressions_idx), line_no, "impressions")?,
            ctr: match ctr_idx {
                Some(idx) => parse_ctr_cell(get(idx), line_no)?,
                None => None,
            },
            position: match position_idx {
                Some(idx) => parse_opt_float_cell(get(idx), line_no, "position")?,
                None => None,
            },
            raw: serde_json::Value::Object(raw_map),
        });
    }
    if rows.is_empty() {
        bail!("CSV contains no data rows");
    }
    Ok(rows)
}

fn column_value(headers: &[String], record: &[String], name: &str) -> Option<String> {
    headers
        .iter()
        .position(|h| h.to_lowercase() == name)
        .and_then(|i| record.get(i))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Parse a declared generative-AI report export.
///
/// UNVERIFIED against a genuine authorized sample: accepts the documented
/// dimension set (page/impressions with optional country/device/date) and
/// rejects everything that would mix ordinary Search data into AI metrics:
/// clicks/CTR columns, `query` dimensions, and `device` for Discover
/// (Search-only per Google's documentation).
pub fn parse_ai_csv(bytes: &[u8], identity: ReportIdentity) -> Result<Vec<GscRow>> {
    if !identity.is_confirmed_ai() {
        bail!("AI parsing requires a generative_ai_search or generative_ai_discover identity");
    }
    let table = read_table(bytes)?;
    let names: Vec<String> = table.headers.iter().map(|h| h.to_lowercase()).collect();
    let line_base = usize::from(table.title_skipped);

    if names.iter().any(|h| h == "clicks" || h == "ctr") {
        bail!(
            "AI report export must not contain clicks/CTR columns: ordinary Search data \
             MUST NOT enter generative-AI metrics. Import this file as generic_search instead."
        );
    }
    if !names.iter().any(|h| h == "impressions") {
        bail!("AI report header must contain an 'impressions' column");
    }
    let impressions_idx = names.iter().position(|h| h == "impressions").unwrap();
    let kind = dimension_kind_for(&table.headers[0]).to_string();
    if kind == "query" {
        bail!("'query' is not a documented generative-AI report dimension; refusing AI import");
    }
    if identity == ReportIdentity::GenerativeAiDiscover && names.iter().any(|h| h == "device") {
        bail!(
            "'device' is documented as Search-only; refusing Discover AI import with device data"
        );
    }
    let page_idx = names
        .iter()
        .position(|h| h == "page" || h == "url" || h == "pages" || h == "urls");
    if page_idx.is_none() && kind != "page" {
        bail!("AI report must identify pages (documented core dimension)");
    }

    let mut rows = Vec::new();
    for (i, record) in table.records.iter().enumerate() {
        let line_no = i + 2 + line_base;
        let get = |idx: usize| record.get(idx).map(|s| s.trim()).unwrap_or("");
        // Page value: dedicated column wins, else first column when it is page-shaped.
        let page = match page_idx {
            Some(idx) => get(idx),
            None => get(0),
        };
        if page.is_empty() {
            continue;
        }
        let mut raw_map = serde_json::Map::new();
        for (h, v) in table.headers.iter().zip(record.iter()) {
            raw_map.insert(h.to_lowercase(), serde_json::Value::String(v.clone()));
        }
        rows.push(GscRow {
            identity,
            dimension_kind: "page".to_string(),
            dimension_value: page.to_string(),
            country: column_value(&table.headers, record, "country"),
            device: column_value(&table.headers, record, "device"),
            clicks: None, // AI reports carry no clicks; None, never zero.
            impressions: parse_int_cell(get(impressions_idx), line_no, "impressions")?,
            ctr: None,
            position: position_from(&table.headers, record, line_no)?,
            raw: serde_json::Value::Object(raw_map),
        });
    }
    if rows.is_empty() {
        bail!("CSV contains no data rows");
    }
    Ok(rows)
}

fn position_from(headers: &[String], record: &[String], line_no: usize) -> Result<Option<f64>> {
    match headers.iter().position(|h| h.to_lowercase() == "position") {
        Some(idx) => parse_opt_float_cell(
            record.get(idx).map(|s| s.as_str()).unwrap_or(""),
            line_no,
            "position",
        ),
        None => Ok(None),
    }
}

/// Import one authorized export file for `period`. The whole file is
/// parsed and validated BEFORE any database write; rows, raw bytes and the
/// batch record persist atomically (full rollback on failure).
pub fn import_gsc_csv(
    storage: &AuditStorage,
    project_id: &str,
    path: &std::path::Path,
    identity: ReportIdentity,
    period: &ImportPeriod,
) -> Result<GscImportOutcome> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("Cannot read import file {}", path.display()))?;
    let digest = sha256_hex(&bytes);
    let source_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    let period_key = period.key();

    if storage.import_batch_exists(
        project_id,
        GSC_SOURCE_KIND,
        &digest,
        identity.as_str(),
        &period_key,
    )? {
        return Ok(GscImportOutcome {
            imported: 0,
            skipped_duplicates: 0,
            conflicts: 0,
            skipped_file: true,
            source_digest: digest,
            identity,
            period: period_key,
        });
    }

    // Parse + validate everything before touching the database.
    let rows = match identity {
        ReportIdentity::GenericSearch => parse_generic_csv(&bytes)?,
        ReportIdentity::GenerativeAiSearch | ReportIdentity::GenerativeAiDiscover => {
            parse_ai_csv(&bytes, identity)?
        }
        ReportIdentity::Unknown => {
            bail!("Refusing import with unknown report identity: declare --report explicitly");
        }
    };
    let collected_at = format!("{}T00:00:00Z", period.start);

    storage.import_transaction(|| {
        let mut imported = 0usize;
        let mut skipped = 0usize;
        let mut conflicts = 0usize;
        for row in &rows {
            let payload = serde_json::json!({
                "report_identity": row.identity.as_str(),
                "dimension_kind": row.dimension_kind,
                "dimension_value": row.dimension_value,
                "country": row.country,
                "device": row.device,
                "period": period_key,
                "period_start": period.start,
                "period_end": period.end,
                "clicks": row.clicks,
                "impressions": row.impressions,
                "ctr": row.ctr,
                "position": row.position,
                "raw": row.raw,
            });
            let region = row.country.clone();
            let url_digest = if row.dimension_kind == "page" {
                Some(sha256_hex(row.dimension_value.as_bytes()))
            } else {
                None
            };
            // Natural key scopes project, report identity, surface, period.
            let dedupe_key = format!(
                "{}|{}|{}|{}|{}",
                row.identity.as_str(),
                GSC_SURFACE,
                period_key,
                row.dimension_kind,
                row.dimension_value,
            );
            // Preserve the ORIGINAL FILE BYTES content-addressed — never a
            // synthetic reconstruction of the row.
            let stored = storage.insert_observation(&NewObservation {
                observation_id: None,
                project_id,
                observation_type: ObservationType::SearchConsoleAggregate,
                surface: GSC_SURFACE,
                collected_at: &collected_at,
                provider: None,
                model: None,
                retrieval_mode: RetrievalMode::Unknown,
                region: region.as_deref(),
                language: None,
                prompt_group: None,
                prompt_variant: None,
                url_digest: url_digest.as_deref(),
                planned: 1,
                succeeded: 1,
                failed: 0,
                failure_class: FailureClass::None,
                latency_ms: None,
                cost_usd: None,
                dedupe_key: &dedupe_key,
                report_identity: row.identity,
                raw_bytes: &bytes,
                payload: &payload,
            })?;
            if stored {
                imported += 1;
                continue;
            }
            // Same key exists: identical data is a quiet duplicate,
            // differing measurements are a surfaced conflict (first wins).
            match storage.find_observation(
                project_id,
                ObservationType::SearchConsoleAggregate,
                row.identity,
                &dedupe_key,
            )? {
                Some(existing)
                    if existing.payload.get("clicks") == payload.get("clicks")
                        && existing.payload.get("impressions") == payload.get("impressions")
                        && existing.payload.get("ctr") == payload.get("ctr")
                        && existing.payload.get("position") == payload.get("position") =>
                {
                    skipped += 1;
                }
                _ => {
                    conflicts += 1;
                    let detail = serde_json::json!({
                        "kind": "measurement_conflict",
                        "dedupe_key": dedupe_key,
                        "period": period_key,
                        "source_digest": digest,
                        "note": "Conflicting measurements for the same natural key; first import kept, this file's values NOT stored.",
                    });
                    storage.record_integrity_observation(
                        project_id,
                        GSC_SURFACE,
                        &detail,
                        &bytes,
                    )?;
                }
            }
        }
        if !storage.record_import_batch(&ImportBatchRecord {
            project_id,
            source_kind: GSC_SOURCE_KIND,
            source_digest: &digest,
            source_name: &source_name,
            identity: identity.as_str(),
            period: &period_key,
            row_count: (imported + skipped) as i64,
        })? {
            bail!("Import batch raced: file was recorded concurrently");
        }
        Ok(GscImportOutcome {
            imported,
            skipped_duplicates: skipped,
            conflicts,
            skipped_file: false,
            source_digest: digest,
            identity,
            period: period_key,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUERIES_FIXTURE: &str = include_str!("../tests/fixtures/gsc_queries.csv");
    const PAGES_FIXTURE: &str = include_str!("../tests/fixtures/gsc_pages.csv");
    const AI_SEARCH_FIXTURE: &str = include_str!("../tests/fixtures/gsc_ai_search_synthetic.csv");

    #[test]
    fn test_parse_queries_fixture() {
        let rows = parse_generic_csv(QUERIES_FIXTURE.as_bytes()).unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].identity, ReportIdentity::GenericSearch);
        assert_eq!(rows[0].dimension_kind, "query");
        assert_eq!(rows[0].dimension_value, "best rust cli tool");
        assert_eq!(rows[0].clicks, Some(120));
        assert_eq!(rows[0].impressions, 3000);
        assert!((rows[0].ctr.unwrap() - 0.04).abs() < 1e-9);
        assert!((rows[0].position.unwrap() - 2.1).abs() < 1e-9);
        // Unavailable CTR/position stay None, not zero.
        assert_eq!(rows[3].ctr, None);
        assert_eq!(rows[3].position, None);
        assert_eq!(rows[3].clicks, Some(0)); // explicit zero is observed zero
    }

    #[test]
    fn test_parse_pages_fixture_preserves_dimensions() {
        let rows = parse_generic_csv(PAGES_FIXTURE.as_bytes()).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.dimension_kind == "page"));
        assert!(rows[0].dimension_value.starts_with("https://"));
    }

    #[test]
    fn test_malformed_files_are_explicit_errors() {
        // No header at all.
        assert!(parse_generic_csv(b"just some text\nno columns here\n").is_err());
        // Missing required columns.
        assert!(parse_generic_csv(b"Query,Clicks\nfoo,3\n").is_err());
        // Bad numbers name the line (title line shifts numbering).
        let err = parse_generic_csv(b"Query,Clicks,Impressions,CTR,Position\nfoo,abc,10,1%,2\n")
            .unwrap_err();
        assert!(err.to_string().contains("Line 2"), "got: {}", err);
        // No data rows.
        assert!(parse_generic_csv(b"Query,Clicks,Impressions\n").is_err());
        // Invalid UTF-8.
        assert!(parse_generic_csv(b"\xff\xfe bad").is_err());
    }

    #[test]
    fn test_ai_parser_rejects_ordinary_search_data() {
        // Clicks/CTR present: MUST NOT enter AI metrics.
        assert!(parse_ai_csv(
            QUERIES_FIXTURE.as_bytes(),
            ReportIdentity::GenerativeAiSearch
        )
        .is_err());
        assert!(parse_ai_csv(
            PAGES_FIXTURE.as_bytes(),
            ReportIdentity::GenerativeAiDiscover
        )
        .is_err());
        // Query dimension is undocumented for AI reports.
        let q = b"Top queries\nQuery,Impressions\nfoo,10\n";
        assert!(parse_ai_csv(q, ReportIdentity::GenerativeAiSearch).is_err());
        // Device is Search-only: Discover refuses it.
        let d = b"Top devices\nPage,Device,Impressions\nhttps://x.example/,mobile,10\n";
        assert!(parse_ai_csv(d, ReportIdentity::GenerativeAiDiscover).is_err());
        assert!(parse_ai_csv(d, ReportIdentity::GenerativeAiSearch).is_ok());
    }

    #[test]
    fn test_ai_parser_accepts_documented_shape_unverified() {
        // SYNTHETIC shape (not an authorized export): documents the accepted
        // dimension set. The importer path stays UNVERIFIED.
        let rows = parse_ai_csv(
            AI_SEARCH_FIXTURE.as_bytes(),
            ReportIdentity::GenerativeAiSearch,
        )
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows
            .iter()
            .all(|r| r.identity == ReportIdentity::GenerativeAiSearch));
        assert!(rows.iter().all(|r| r.clicks.is_none())); // no clicks, never zero
        assert_eq!(rows[0].dimension_value, "https://example.com/docs");
        assert_eq!(rows[0].country.as_deref(), Some("United States"));
    }

    #[test]
    fn test_import_is_idempotent_and_atomic() {
        use crate::audit_storage::AuditStorage;
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let csv_path = dir.path().join("Queries.csv");
        std::fs::write(&csv_path, QUERIES_FIXTURE).unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
        let period = ImportPeriod::single("2026-09-01").unwrap();

        let first = import_gsc_csv(
            &storage,
            "example.com",
            &csv_path,
            ReportIdentity::GenericSearch,
            &period,
        )
        .unwrap();
        assert_eq!(first.imported, 4);
        assert_eq!(first.skipped_duplicates, 0);
        assert_eq!(first.conflicts, 0);
        assert!(!first.skipped_file);

        // Same file + period: skipped whole, zero new rows.
        let second = import_gsc_csv(
            &storage,
            "example.com",
            &csv_path,
            ReportIdentity::GenericSearch,
            &period,
        )
        .unwrap();
        assert!(second.skipped_file);
        assert_eq!(
            storage
                .count_observations(
                    "example.com",
                    Some(crate::observations::ObservationType::SearchConsoleAggregate)
                )
                .unwrap(),
            4
        );

        // Identical bytes asserted for ANOTHER period: separate batch, but
        // same logical rows land on distinct period-scoped keys.
        let other_period = ImportPeriod::single("2026-09-02").unwrap();
        let third = import_gsc_csv(
            &storage,
            "example.com",
            &csv_path,
            ReportIdentity::GenericSearch,
            &other_period,
        )
        .unwrap();
        assert!(
            !third.skipped_file,
            "other periods must not silently disappear"
        );
        assert_eq!(third.imported, 4);

        // Failed import leaves nothing: malformed file rolls back fully.
        let bad_path = dir.path().join("Bad.csv");
        std::fs::write(&bad_path, b"Query,Clicks\nfoo,3\n").unwrap();
        assert!(import_gsc_csv(
            &storage,
            "example.com",
            &bad_path,
            ReportIdentity::GenericSearch,
            &period,
        )
        .is_err());
        // No batch record, no rows from the failed file.
        assert_eq!(
            storage
                .count_observations(
                    "example.com",
                    Some(crate::observations::ObservationType::SearchConsoleAggregate)
                )
                .unwrap(),
            8
        );
        // Safe retry with fixed content works.
        std::fs::write(&bad_path, QUERIES_FIXTURE).unwrap();
        let retry = import_gsc_csv(
            &storage,
            "example.com",
            &bad_path,
            ReportIdentity::GenericSearch,
            &ImportPeriod::single("2026-09-03").unwrap(),
        )
        .unwrap();
        assert_eq!(retry.imported, 4);
    }

    #[test]
    fn test_conflicting_measurements_are_surfaced_not_overwritten() {
        use crate::audit_storage::AuditStorage;
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
        // Two different files, same natural key, different numbers.
        let a = dir.path().join("A.csv");
        let b = dir.path().join("B.csv");
        std::fs::write(&a, "Query,Clicks,Impressions\nfoo,10,100\n").unwrap();
        std::fs::write(&b, "Query,Clicks,Impressions\nfoo,99,100\n").unwrap();
        let period = ImportPeriod::single("2026-09-01").unwrap();
        let first = import_gsc_csv(
            &storage,
            "example.com",
            &a,
            ReportIdentity::GenericSearch,
            &period,
        )
        .unwrap();
        assert_eq!(first.imported, 1);
        let second = import_gsc_csv(
            &storage,
            "example.com",
            &b,
            ReportIdentity::GenericSearch,
            &period,
        )
        .unwrap();
        assert_eq!(second.imported, 0);
        assert_eq!(second.conflicts, 1);
        // First measurement kept; integrity row recorded.
        let rows = storage
            .list_observations(
                "example.com",
                Some(crate::observations::ObservationType::SearchConsoleAggregate),
            )
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].payload["clicks"], 10);
        let integrity = storage
            .list_observations(
                "example.com",
                Some(crate::observations::ObservationType::Integrity),
            )
            .unwrap();
        assert_eq!(integrity.len(), 1);
        assert_eq!(integrity[0].payload["kind"], "measurement_conflict");
    }
}
