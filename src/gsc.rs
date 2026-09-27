//! Google Search Console CSV import (first-party evidence).
//!
//! Uses authorized user exports — there is no dedicated API assumption.
//! Supported layouts are the real Search Console download shapes:
//!
//! ```text
//! Top queries
//! Query,Clicks,Impressions,CTR,Position
//! "best rust cli",120,3000,4%,2.1
//! ```
//!
//! The optional first title line (`Top queries|pages|countries|devices`) is
//! skipped. The header row must contain `clicks` and `impressions`
//! (case-insensitive); the first column is the reporting dimension. CTR
//! (`4.2%`) and position may be empty — unavailable stays unavailable
//! (`None`), never zero-filled. Source bytes are preserved content-addressed
//! and each row keeps its original record in the payload.

use anyhow::{bail, Context, Result};

use crate::audit_storage::AuditStorage;
use crate::observations::{
    sha256_hex, FailureClass, NewObservation, ObservationType, RetrievalMode,
};

pub const GSC_SOURCE_KIND: &str = "search_console_csv";
pub const GSC_SURFACE: &str = "search-console";

/// One parsed export row with aggregation and dimensions preserved.
#[derive(Debug, Clone, PartialEq)]
pub struct GscRow {
    /// Reporting dimension kind: query, page, country, device, or dimension.
    pub dimension_kind: String,
    pub dimension_value: String,
    pub clicks: i64,
    pub impressions: i64,
    /// CTR as a fraction (0.042 for "4.2%"); `None` when the cell is empty.
    pub ctr: Option<f64>,
    /// Average position; `None` when the cell is empty.
    pub position: Option<f64>,
    /// Original record exactly as read (keys lowercased).
    pub raw: serde_json::Value,
}

/// Outcome of [`import_gsc_csv`].
#[derive(Debug, Clone, PartialEq)]
pub struct GscImportOutcome {
    /// Rows stored as new observations.
    pub imported: usize,
    /// Rows skipped because the natural key already existed.
    pub skipped_duplicates: usize,
    /// True when the file digest was already imported (nothing parsed).
    pub skipped_file: bool,
    pub source_digest: String,
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
        "page" | "pages" | "top pages" => "page",
        "country" | "countries" | "top countries" => "country",
        "device" | "devices" | "top devices" => "device",
        _ => "dimension",
    }
}

/// Parse Search Console CSV bytes into rows. Errors name the line and
/// column; malformed files never yield partial silent output.
pub fn parse_gsc_csv(bytes: &[u8]) -> Result<Vec<GscRow>> {
    let text = std::str::from_utf8(bytes).context("CSV is not valid UTF-8")?;
    // Skip an optional title line (`Top queries`, ...): a single field
    // starting with "top " is a title, not a header.
    let body = match text.lines().next() {
        Some(first) if !first.contains(',') && first.trim().to_lowercase().starts_with("top ") => {
            text.lines().skip(1).collect::<Vec<_>>().join("\n")
        }
        _ => text.to_string(),
    };
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(body.as_bytes());

    let headers = reader.headers().context("CSV has no header row")?.clone();
    let names: Vec<String> = headers.iter().map(|h| h.to_lowercase()).collect();

    if !names.iter().any(|h| h == "clicks") || !names.iter().any(|h| h == "impressions") {
        bail!("CSV header must contain 'clicks' and 'impressions' columns");
    }
    let clicks_idx = names.iter().position(|h| h == "clicks").unwrap();
    let impressions_idx = names.iter().position(|h| h == "impressions").unwrap();
    let ctr_idx = names.iter().position(|h| h == "ctr");
    let position_idx = names.iter().position(|h| h == "position");
    let kind = dimension_kind_for(&headers[0]).to_string();

    let mut rows = Vec::new();
    // Title-line skip shifts diagnostics by one; keep error lines accurate.
    let line_offset = if body.len() != text.len() { 1 } else { 0 };
    for (i, record) in reader.records().enumerate() {
        let line_no = i + 2 + line_offset;
        let record = record.with_context(|| format!("Line {}: malformed CSV record", line_no))?;
        let get = |idx: usize| record.get(idx).unwrap_or("").trim();
        let value = get(0);
        if value.is_empty() {
            continue; // skip blank lines, never error
        }
        let mut raw_map = serde_json::Map::new();
        for (h, v) in headers.iter().zip(record.iter()) {
            raw_map.insert(h.to_lowercase(), serde_json::Value::String(v.to_string()));
        }
        rows.push(GscRow {
            dimension_kind: kind.clone(),
            dimension_value: value.to_string(),
            clicks: parse_int_cell(get(clicks_idx), line_no, "clicks")?,
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

/// Import one authorized export file for `date` (YYYY-MM-DD, the day the
/// export covers). Idempotent: an already-imported file digest is skipped
/// whole; already-present rows are skipped individually.
pub fn import_gsc_csv(
    storage: &AuditStorage,
    project_id: &str,
    path: &std::path::Path,
    date: &str,
) -> Result<GscImportOutcome> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("Cannot read import file {}", path.display()))?;
    let digest = sha256_hex(&bytes);
    let source_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());

    if !storage.record_import_batch(project_id, GSC_SOURCE_KIND, &digest, &source_name, 0)? {
        return Ok(GscImportOutcome {
            imported: 0,
            skipped_duplicates: 0,
            skipped_file: true,
            source_digest: digest,
        });
    }

    let rows = parse_gsc_csv(&bytes)?;
    let collected_at = format!("{}T00:00:00Z", date);
    let mut imported = 0usize;
    let mut skipped = 0usize;
    for row in &rows {
        let payload = serde_json::json!({
            "dimension_kind": row.dimension_kind,
            "dimension_value": row.dimension_value,
            "clicks": row.clicks,
            "impressions": row.impressions,
            "ctr": row.ctr,
            "position": row.position,
            "raw": row.raw,
        });
        let region = if row.dimension_kind == "country" {
            Some(row.dimension_value.clone())
        } else {
            None
        };
        let url_digest = if row.dimension_kind == "page" {
            Some(sha256_hex(row.dimension_value.as_bytes()))
        } else {
            None
        };
        let dedupe_key = format!("{}|{}|{}", date, row.dimension_kind, row.dimension_value);
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
            raw_bytes: format!(
                "{}|{}|{}|{}",
                row.dimension_kind, row.dimension_value, row.clicks, row.impressions
            )
            .as_bytes(),
            payload: &payload,
        })?;
        if stored {
            imported += 1;
        } else {
            skipped += 1;
        }
    }
    Ok(GscImportOutcome {
        imported,
        skipped_duplicates: skipped,
        skipped_file: false,
        source_digest: digest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUERIES_FIXTURE: &str = include_str!("../tests/fixtures/gsc_queries.csv");
    const PAGES_FIXTURE: &str = include_str!("../tests/fixtures/gsc_pages.csv");

    #[test]
    fn test_parse_queries_fixture() {
        let rows = parse_gsc_csv(QUERIES_FIXTURE.as_bytes()).unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].dimension_kind, "query");
        assert_eq!(rows[0].dimension_value, "best rust cli tool");
        assert_eq!(rows[0].clicks, 120);
        assert_eq!(rows[0].impressions, 3000);
        assert!((rows[0].ctr.unwrap() - 0.04).abs() < 1e-9);
        assert!((rows[0].position.unwrap() - 2.1).abs() < 1e-9);
        // Unavailable CTR/position stay None, not zero.
        assert_eq!(rows[3].ctr, None);
        assert_eq!(rows[3].position, None);
    }

    #[test]
    fn test_parse_pages_fixture_preserves_dimensions() {
        let rows = parse_gsc_csv(PAGES_FIXTURE.as_bytes()).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.dimension_kind == "page"));
        assert!(rows[0].dimension_value.starts_with("https://"));
    }

    #[test]
    fn test_malformed_files_are_explicit_errors() {
        // No header at all.
        assert!(parse_gsc_csv(b"just some text\nno columns here\n").is_err());
        // Missing required columns.
        assert!(parse_gsc_csv(b"Query,Clicks\nfoo,3\n").is_err());
        // Bad numbers name the line.
        let err =
            parse_gsc_csv(b"Query,Clicks,Impressions,CTR,Position\nfoo,abc,10,1%,2\n").unwrap_err();
        assert!(err.to_string().contains("Line 2"));
        // No data rows.
        assert!(parse_gsc_csv(b"Query,Clicks,Impressions\n").is_err());
        // Invalid UTF-8.
        assert!(parse_gsc_csv(b"\xff\xfe bad").is_err());
    }

    #[test]
    fn test_import_is_idempotent_across_repeated_files() {
        use crate::audit_storage::AuditStorage;
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let csv_path = dir.path().join("Queries.csv");
        std::fs::write(&csv_path, QUERIES_FIXTURE).unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();

        let first = import_gsc_csv(&storage, "example.com", &csv_path, "2026-09-01").unwrap();
        assert_eq!(first.imported, 4);
        assert_eq!(first.skipped_duplicates, 0);
        assert!(!first.skipped_file);

        // Same file again: skipped whole, zero new rows.
        let second = import_gsc_csv(&storage, "example.com", &csv_path, "2026-09-01").unwrap();
        assert!(second.skipped_file);
        assert_eq!(second.imported, 0);
        assert_eq!(
            storage
                .count_observations(
                    "example.com",
                    Some(crate::observations::ObservationType::SearchConsoleAggregate)
                )
                .unwrap(),
            4
        );

        // Same rows under a different date: distinct natural keys, imported.
        let third = import_gsc_csv(&storage, "example.com", &csv_path, "2026-09-02");
        // Same file bytes => same digest => skipped as duplicate file.
        assert!(third.unwrap().skipped_file);
    }
}
