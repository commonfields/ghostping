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
use serde::{Deserialize, Serialize};

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

/// Explicit source dimension tuple: every dimension actually present in
/// the imported row, preserved with no invented hierarchy ("page is
/// primary" is NOT assumed). Two rows with different tuples are different
/// observations even when they share a page.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DimensionTuple {
    pub page: Option<String>,
    pub country: Option<String>,
    pub device: Option<String>,
    pub date: Option<String>,
    /// Any other dimension column, kept verbatim (sorted by name).
    pub other: std::collections::BTreeMap<String, String>,
}

impl DimensionTuple {
    /// Present dimensions in canonical order: page, country, device, date,
    /// then others alphabetically. Used for keys and grouping.
    pub fn present(&self) -> Vec<(String, &str)> {
        let mut out = Vec::new();
        if let Some(v) = &self.page {
            out.push(("page".to_string(), v.as_str()));
        }
        if let Some(v) = &self.country {
            out.push(("country".to_string(), v.as_str()));
        }
        if let Some(v) = &self.device {
            out.push(("device".to_string(), v.as_str()));
        }
        if let Some(v) = &self.date {
            out.push(("date".to_string(), v.as_str()));
        }
        for (k, v) in &self.other {
            out.push((k.clone(), v.as_str()));
        }
        out
    }

    /// Breakdown signature: names of present dimensions, canonical order.
    /// Rows share a slice only when signatures match exactly.
    pub fn signature(&self) -> Vec<String> {
        self.present().into_iter().map(|(k, _)| k).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.page.is_none()
            && self.country.is_none()
            && self.device.is_none()
            && self.date.is_none()
            && self.other.is_empty()
    }
}

/// What a reported number actually guarantees.
///
/// The export format cannot tell us whether a printed `0` was independently
/// observed or rendered from an unavailable value, so `Reported` is ALL we
/// claim for any carried number — including zero. Missing/empty is
/// `Unavailable`, never zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueSemantics {
    Reported,
    Unavailable,
}

/// An integer cell with its two layers: the raw token and the parsed value.
#[derive(Debug, Clone, PartialEq)]
pub struct SourcedInt {
    pub raw: String,
    pub value: Option<i64>,
    pub semantics: ValueSemantics,
}

/// A float cell with its two layers.
#[derive(Debug, Clone, PartialEq)]
pub struct SourcedFloat {
    pub raw: String,
    pub value: Option<f64>,
    pub semantics: ValueSemantics,
}

fn sourced_int_cell(raw: &str, line_no: usize, col: &str) -> Result<SourcedInt> {
    let token = raw.trim().to_string();
    if token.is_empty() {
        return Ok(SourcedInt {
            raw: token,
            value: None,
            semantics: ValueSemantics::Unavailable,
        });
    }
    let cleaned: String = token.chars().filter(|c| *c != ',').collect();
    let value = cleaned
        .parse::<i64>()
        .with_context(|| format!("Line {}: bad integer in '{}': '{}'", line_no, col, raw))?;
    Ok(SourcedInt {
        raw: token,
        value: Some(value),
        semantics: ValueSemantics::Reported,
    })
}

fn sourced_float_cell(raw: &str, line_no: usize, col: &str) -> Result<SourcedFloat> {
    let token = raw.trim().to_string();
    if token.is_empty() {
        return Ok(SourcedFloat {
            raw: token,
            value: None,
            semantics: ValueSemantics::Unavailable,
        });
    }
    let value = token
        .parse::<f64>()
        .with_context(|| format!("Line {}: bad number in '{}': '{}'", line_no, col, raw))?;
    Ok(SourcedFloat {
        raw: token,
        value: Some(value),
        semantics: ValueSemantics::Reported,
    })
}

fn sourced_ctr_cell(raw: &str, line_no: usize) -> Result<SourcedFloat> {
    let token = raw.trim().to_string();
    let t = token.trim_end_matches('%').trim();
    if t.is_empty() {
        return Ok(SourcedFloat {
            raw: token,
            value: None,
            semantics: ValueSemantics::Unavailable,
        });
    }
    let value = t
        .parse::<f64>()
        .with_context(|| format!("Line {}: bad CTR value: '{}'", line_no, raw))?;
    Ok(SourcedFloat {
        raw: token,
        value: Some(value / 100.0),
        semantics: ValueSemantics::Reported,
    })
}

/// One parsed export row: identity + full dimension tuple + two-layer values.
#[derive(Debug, Clone, PartialEq)]
pub struct GscRow {
    pub identity: ReportIdentity,
    pub dimensions: DimensionTuple,
    pub clicks: Option<SourcedInt>,
    pub impressions: SourcedInt,
    pub ctr: Option<SourcedFloat>,
    pub position: Option<SourcedFloat>,
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

fn sourced_int_json(v: &SourcedInt) -> serde_json::Value {
    serde_json::json!({
        "raw": v.raw,
        "value": v.value,
        "semantics": match v.semantics {
            ValueSemantics::Reported => "reported",
            ValueSemantics::Unavailable => "unavailable",
        },
    })
}

fn sourced_float_json(v: &SourcedFloat) -> serde_json::Value {
    serde_json::json!({
        "raw": v.raw,
        "value": v.value,
        "semantics": match v.semantics {
            ValueSemantics::Reported => "reported",
            ValueSemantics::Unavailable => "unavailable",
        },
    })
}

fn opt_sourced_int_json(v: Option<&SourcedInt>) -> serde_json::Value {
    v.map(sourced_int_json).unwrap_or(serde_json::Value::Null)
}

fn opt_sourced_float_json(v: Option<&SourcedFloat>) -> serde_json::Value {
    v.map(sourced_float_json).unwrap_or(serde_json::Value::Null)
}

fn dimensions_json(d: &DimensionTuple) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (k, v) in d.present() {
        map.insert(k, serde_json::Value::String(v.to_string()));
    }
    serde_json::Value::Object(map)
}

/// Read a two-layer number from a payload, tolerating pre-semantics rows
/// that stored a plain number. Returns (value, semantics); missing or null
/// is (None, Unavailable) — never zero.
pub fn payload_sourced_int(
    payload: &serde_json::Value,
    key: &str,
) -> (Option<i64>, ValueSemantics) {
    match payload.get(key) {
        Some(serde_json::Value::Object(o)) => {
            let value = o.get("value").and_then(|v| v.as_i64());
            let sem = match o.get("semantics").and_then(|v| v.as_str()) {
                Some("reported") => ValueSemantics::Reported,
                _ => ValueSemantics::Unavailable,
            };
            (value, sem)
        }
        Some(serde_json::Value::Number(n)) => (n.as_i64(), ValueSemantics::Reported),
        _ => (None, ValueSemantics::Unavailable),
    }
}

/// Same tolerance for floats (CTR is stored as a fraction).
pub fn payload_sourced_float(
    payload: &serde_json::Value,
    key: &str,
) -> (Option<f64>, ValueSemantics) {
    match payload.get(key) {
        Some(serde_json::Value::Object(o)) => {
            let value = o.get("value").and_then(|v| v.as_f64());
            let sem = match o.get("semantics").and_then(|v| v.as_str()) {
                Some("reported") => ValueSemantics::Reported,
                _ => ValueSemantics::Unavailable,
            };
            (value, sem)
        }
        Some(serde_json::Value::Number(n)) => (n.as_f64(), ValueSemantics::Reported),
        _ => (None, ValueSemantics::Unavailable),
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

/// Parse an ordinary Search export. Clicks column required; every other
/// dimension column present in the row joins the dimension tuple.
/// Identity: generic.
pub fn parse_generic_csv(bytes: &[u8]) -> Result<Vec<GscRow>> {
    parse_csv(bytes, ReportIdentity::GenericSearch, true)
}

/// Build one row's dimension tuple from named columns plus the first
/// column's kind. Metric columns never become dimensions.
fn build_tuple(
    headers: &[String],
    record: &[String],
    first_kind: &str,
    first_value: &str,
) -> DimensionTuple {
    let mut tuple = DimensionTuple::default();
    let mut assign = |kind: &str, value: &str| {
        if value.is_empty() {
            return;
        }
        match kind {
            "page" => tuple.page = Some(value.to_string()),
            "country" => tuple.country = Some(value.to_string()),
            "device" => tuple.device = Some(value.to_string()),
            "date" => tuple.date = Some(value.to_string()),
            other => {
                tuple.other.insert(other.to_string(), value.to_string());
            }
        }
    };
    if !first_value.is_empty() {
        assign(first_kind, first_value);
    }
    for (h, v) in headers.iter().zip(record.iter()) {
        let name = h.to_lowercase();
        let v = v.trim();
        match name.as_str() {
            "page" | "pages" | "url" | "urls" => assign("page", v),
            "country" | "countries" => assign("country", v),
            "device" | "devices" => assign("device", v),
            "date" | "dates" => assign("date", v),
            "query" | "queries" => assign("query", v),
            "clicks" | "impressions" | "ctr" | "position" => {}
            _ => assign(&name, v),
        }
    }
    tuple
}

fn cell(record: &[String], idx: Option<usize>) -> &str {
    idx.and_then(|i| record.get(i))
        .map(|s| s.trim())
        .unwrap_or("")
}

fn parse_csv(bytes: &[u8], identity: ReportIdentity, generic: bool) -> Result<Vec<GscRow>> {
    let table = read_table(bytes)?;
    let names: Vec<String> = table.headers.iter().map(|h| h.to_lowercase()).collect();
    let line_base = usize::from(table.title_skipped);

    if generic {
        for required in ["clicks", "impressions"] {
            if !names.iter().any(|h| h == required) {
                bail!(
                    "CSV header must contain '{}' for generic Search exports",
                    required
                );
            }
        }
    } else {
        if names.iter().any(|h| h == "clicks" || h == "ctr") {
            bail!(
                "AI report export must not contain clicks/CTR columns: ordinary Search data \
                 MUST NOT enter generative-AI metrics. Import this file as generic_search instead."
            );
        }
        if !names.iter().any(|h| h == "impressions") {
            bail!("AI report header must contain an 'impressions' column");
        }
        if table
            .headers
            .first()
            .is_some_and(|h| dimension_kind_for(h) == "query")
        {
            bail!("'query' is not a documented generative-AI report dimension; refusing AI import");
        }
        if identity == ReportIdentity::GenerativeAiDiscover && names.iter().any(|h| h == "device") {
            bail!(
                "'device' is documented as Search-only; refusing Discover AI import with device data"
            );
        }
    }

    let col = |name: &str| names.iter().position(|h| h == name);
    let first_kind = table
        .headers
        .first()
        .map(|h| dimension_kind_for(h))
        .unwrap_or("dimension");

    let mut rows = Vec::new();
    for (i, record) in table.records.iter().enumerate() {
        let line_no = i + 2 + line_base;
        let get = |idx: usize| record.get(idx).map(|s| s.trim()).unwrap_or("");
        let tuple = build_tuple(&table.headers, record, first_kind, get(0));
        if tuple.is_empty() {
            continue; // blank line: skip, never error
        }
        // AI imports must establish dimensional meaning: at least one
        // recognized dimension (page/country/device/date) is required.
        // Anything else is preserved as an unknown/unverified breakdown only
        // when meaning exists; otherwise the file is refused, not guessed.
        if !generic
            && tuple.page.is_none()
            && tuple.country.is_none()
            && tuple.device.is_none()
            && tuple.date.is_none()
        {
            bail!(
                "Line {}: cannot establish dimensional meaning (need page/country/device/date); refusing AI import rather than guessing",
                line_no
            );
        }
        let mut raw_map = serde_json::Map::new();
        for (h, v) in table.headers.iter().zip(record.iter()) {
            raw_map.insert(h.to_lowercase(), serde_json::Value::String(v.clone()));
        }
        rows.push(GscRow {
            identity,
            dimensions: tuple,
            clicks: match col("clicks") {
                Some(idx) => Some(sourced_int_cell(
                    cell(record, Some(idx)),
                    line_no,
                    "clicks",
                )?),
                None => None,
            },
            impressions: sourced_int_cell(
                cell(record, col("impressions")),
                line_no,
                "impressions",
            )?,
            ctr: match col("ctr") {
                Some(idx) => Some(sourced_ctr_cell(cell(record, Some(idx)), line_no)?),
                None => None,
            },
            position: match col("position") {
                Some(idx) => Some(sourced_float_cell(
                    cell(record, Some(idx)),
                    line_no,
                    "position",
                )?),
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

/// Parse a declared generative-AI report export.
///
/// UNVERIFIED against a genuine authorized sample: accepts the documented
/// dimension set and rejects everything that would mix ordinary Search data
/// into AI metrics (see `parse_csv` guards).
pub fn parse_ai_csv(bytes: &[u8], identity: ReportIdentity) -> Result<Vec<GscRow>> {
    if !identity.is_confirmed_ai() {
        bail!("AI parsing requires a generative_ai_search or generative_ai_discover identity");
    }
    parse_csv(bytes, identity, false)
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
                "dimensions": dimensions_json(&row.dimensions),
                "period": period_key,
                "period_start": period.start,
                "period_end": period.end,
                "clicks": opt_sourced_int_json(row.clicks.as_ref()),
                "impressions": sourced_int_json(&row.impressions),
                "ctr": opt_sourced_float_json(row.ctr.as_ref()),
                "position": opt_sourced_float_json(row.position.as_ref()),
                "raw": row.raw,
            });
            let region = row.dimensions.country.clone();
            // url_digest whenever a page URL exists, regardless of which
            // other dimensions the export carries.
            let url_digest = row
                .dimensions
                .page
                .as_ref()
                .map(|p| sha256_hex(p.as_bytes()));
            // Natural key: project, report identity, surface, reporting
            // period, and EVERY present source dimension. Measurement values
            // never participate in identity.
            let mut key_parts = vec![
                row.identity.as_str().to_string(),
                GSC_SURFACE.to_string(),
                period_key.clone(),
            ];
            for (k, v) in row.dimensions.present() {
                key_parts.push(format!("{}={}", k, v));
            }
            let dedupe_key = key_parts.join("|");
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
            // Same key exists: identical measurements are a quiet duplicate,
            // differing measurements are a surfaced conflict (first wins).
            // Comparison is on parsed values AND two-layer semantics.
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
                        && existing.payload.get("position") == payload.get("position")
                        && existing.payload.get("dimensions") == payload.get("dimensions") =>
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
        assert_eq!(rows[0].dimensions.page, None);
        assert_eq!(
            rows[0].dimensions.other.get("query").map(|s| s.as_str()),
            Some("best rust cli tool")
        );
        assert_eq!(
            rows[0].clicks.as_ref().unwrap(),
            &SourcedInt {
                raw: "120".to_string(),
                value: Some(120),
                semantics: ValueSemantics::Reported,
            }
        );
        assert_eq!(rows[0].impressions.value, Some(3000));
        assert!((rows[0].ctr.as_ref().unwrap().value.unwrap() - 0.04).abs() < 1e-9);
        assert_eq!(rows[0].position.as_ref().unwrap().value, Some(2.1));
        // Unavailable CTR/position stay unavailable, not zero.
        assert_eq!(
            rows[3].ctr.as_ref().unwrap().semantics,
            ValueSemantics::Unavailable
        );
        assert_eq!(rows[3].ctr.as_ref().unwrap().value, None);
        assert_eq!(rows[3].position.as_ref().unwrap().value, None);
        // Explicit zero is Reported, not a stronger claim.
        assert_eq!(rows[3].clicks.as_ref().unwrap().value, Some(0));
        assert_eq!(
            rows[3].clicks.as_ref().unwrap().semantics,
            ValueSemantics::Reported
        );
    }

    #[test]
    fn test_parse_pages_fixture_preserves_page_dimension() {
        let rows = parse_generic_csv(PAGES_FIXTURE.as_bytes()).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r
            .dimensions
            .page
            .as_deref()
            .unwrap()
            .starts_with("https://")));
    }

    #[test]
    fn test_multidimensional_rows_keep_full_tuples() {
        let csv = "Page,Country,Device,Clicks,Impressions,CTR,Position\n\
            https://a.example/,United States,desktop,10,100,10%,1.0\n\
            https://a.example/,United Kingdom,desktop,5,80,6.25%,2.0\n\
            https://a.example/,United States,mobile,3,60,5%,3.0\n";
        let rows = parse_generic_csv(csv.as_bytes()).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0].dimensions,
            DimensionTuple {
                page: Some("https://a.example/".to_string()),
                country: Some("United States".to_string()),
                device: Some("desktop".to_string()),
                ..Default::default()
            }
        );
        // Tuples differ across rows: no silent collision of identity.
        assert_ne!(rows[0].dimensions, rows[1].dimensions);
        assert_ne!(rows[0].dimensions, rows[2].dimensions);
        assert_eq!(
            rows[0].dimensions.signature(),
            vec![
                "page".to_string(),
                "country".to_string(),
                "device".to_string()
            ]
        );
    }

    #[test]
    fn test_source_value_layers_missing_empty_zero_positive_malformed() {
        // Missing column entirely (no CTR column): None-equivalent is
        // represented as absent SourcedFloat.
        let rows = parse_generic_csv(b"Query,Clicks,Impressions\nfoo,1,2\n").unwrap();
        assert_eq!(rows[0].ctr, None);
        // Empty cell: unavailable, never zero.
        let rows =
            parse_generic_csv(b"Query,Clicks,Impressions,CTR,Position\nfoo,1,2,,\n").unwrap();
        assert_eq!(rows[0].ctr.as_ref().unwrap().value, None);
        assert_eq!(
            rows[0].position.as_ref().unwrap().semantics,
            ValueSemantics::Unavailable
        );
        // Zero: reported with raw token preserved.
        let rows =
            parse_generic_csv(b"Query,Clicks,Impressions,CTR,Position\nfoo,0,0,0%,0\n").unwrap();
        assert_eq!(rows[0].clicks.as_ref().unwrap().value, Some(0));
        assert_eq!(rows[0].clicks.as_ref().unwrap().raw, "0");
        assert_eq!(rows[0].ctr.as_ref().unwrap().value, Some(0.0));
        // Malformed number: explicit error naming the line.
        let err = parse_generic_csv(b"Query,Clicks,Impressions\nfoo,abc,10\n").unwrap_err();
        assert!(err.to_string().contains("Line 2"), "got: {}", err);
        // Invalid UTF-8.
        assert!(parse_generic_csv(b"\xff\xfe bad").is_err());
        // No header / no rows.
        assert!(parse_generic_csv(b"just some text\nno columns here\n").is_err());
        assert!(parse_generic_csv(b"Query,Clicks\nfoo,3\n").is_err());
        assert!(parse_generic_csv(b"Query,Clicks,Impressions\n").is_err());
    }

    #[test]
    fn test_ai_parser_rejects_ordinary_search_data() {
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
        let q = b"Top queries\nQuery,Impressions\nfoo,10\n";
        assert!(parse_ai_csv(q, ReportIdentity::GenerativeAiSearch).is_err());
        let d = b"Top devices\nPage,Device,Impressions\nhttps://x.example/,mobile,10\n";
        assert!(parse_ai_csv(d, ReportIdentity::GenerativeAiDiscover).is_err());
        assert!(parse_ai_csv(d, ReportIdentity::GenerativeAiSearch).is_ok());
        // Unknown layout (no recognizable dimension): refused, not guessed.
        let u = b"Foo,Bar,Impressions\n1,2,3\n";
        assert!(parse_ai_csv(u, ReportIdentity::GenerativeAiSearch).is_err());
    }

    #[test]
    fn test_ai_parser_accepts_documented_shape_unverified() {
        let rows = parse_ai_csv(
            AI_SEARCH_FIXTURE.as_bytes(),
            ReportIdentity::GenerativeAiSearch,
        )
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows
            .iter()
            .all(|r| r.identity == ReportIdentity::GenerativeAiSearch));
        assert!(rows.iter().all(|r| r.clicks.is_none()));
        assert_eq!(
            rows[0].dimensions.page.as_deref(),
            Some("https://example.com/docs")
        );
        assert_eq!(rows[0].dimensions.country.as_deref(), Some("United States"));
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
        assert_eq!(
            storage
                .count_observations(
                    "example.com",
                    Some(crate::observations::ObservationType::SearchConsoleAggregate)
                )
                .unwrap(),
            8
        );
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
    fn test_same_dimensions_two_periods_do_not_collide() {
        use crate::audit_storage::AuditStorage;
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let csv_path = dir.path().join("C.csv");
        std::fs::write(
            &csv_path,
            "Page,Country,Clicks,Impressions\nhttps://a.example/,US,10,100\n",
        )
        .unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
        for date in ["2026-09-01", "2026-09-02"] {
            let out = import_gsc_csv(
                &storage,
                "example.com",
                &csv_path,
                ReportIdentity::GenericSearch,
                &ImportPeriod::single(date).unwrap(),
            )
            .unwrap();
            assert_eq!(out.imported, 1);
        }
        assert_eq!(
            storage
                .count_observations(
                    "example.com",
                    Some(crate::observations::ObservationType::SearchConsoleAggregate)
                )
                .unwrap(),
            2
        );
    }

    #[test]
    fn test_conflicting_measurements_are_surfaced_not_overwritten() {
        use crate::audit_storage::AuditStorage;
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let storage = AuditStorage::open(&dir.path().join("test.db")).unwrap();
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
        let rows = storage
            .list_observations(
                "example.com",
                Some(crate::observations::ObservationType::SearchConsoleAggregate),
            )
            .unwrap();
        assert_eq!(rows.len(), 1);
        // Structured comparison: first measurement kept.
        let (v, _) = payload_sourced_int(&rows[0].payload, "clicks");
        assert_eq!(v, Some(10));
        let integrity = storage
            .list_observations(
                "example.com",
                Some(crate::observations::ObservationType::Integrity),
            )
            .unwrap();
        assert_eq!(integrity.len(), 1);
        assert_eq!(integrity[0].payload["kind"], "measurement_conflict");
    }

    #[test]
    fn test_country_or_device_only_shapes_import() {
        // GSC supports country-only and device-only breakdowns; they carry
        // no page and must still import as distinct observations.
        let rows = parse_generic_csv(
            b"Country,Clicks,Impressions\nUnited States,50,500\nGermany,10,200\n",
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].dimensions.country.as_deref(), Some("United States"));
        assert_eq!(rows[0].dimensions.page, None);
        assert_ne!(rows[0].dimensions, rows[1].dimensions);
        let rows = parse_generic_csv(b"Device,Clicks,Impressions\nmobile,7,70\n").unwrap();
        assert_eq!(rows[0].dimensions.device.as_deref(), Some("mobile"));
    }
}
