use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};

use super::LlmProvider;
use crate::config::ProviderConfig;
use crate::observations::{FailureClass, RetrievalMode};

/// One grounding source as emitted natively by the Gemini API.
/// The slot itself is `None` when the provider emitted no URI: the position
/// is preserved (never dropped) so `groundingSupports` indices keep
/// referring to the right source. No link is ever invented.
#[derive(Debug, Clone, PartialEq)]
pub struct GroundingSource {
    pub uri: String,
    pub title: String,
}

/// One citation span binding answer text to grounding sources, using the
/// provider's ORIGINAL chunk indices. `part_index` selects the content part
/// (`None` means the provider omitted it: part 0); `start_index`/`end_index`
/// are BYTE offsets into that part.
#[derive(Debug, Clone, PartialEq)]
pub struct CitationSpan {
    pub part_index: Option<i64>,
    pub text: String,
    pub start_index: Option<i64>,
    pub end_index: Option<i64>,
    pub chunk_indices: Vec<i64>,
}

/// One original response part, boundaries preserved.
///
/// The provider's `startIndex`/`endIndex` are BYTE offsets into the part
/// selected by `partIndex` — not character offsets into concatenated text.
/// Part boundaries are never destroyed before citation validation.
#[derive(Debug, Clone, PartialEq)]
pub struct ResponsePart {
    pub part_index: usize,
    pub text: String,
}

/// Status of one referenced grounding source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceStatus {
    Valid,
    MissingUri,
    InvalidIndex,
}

/// Status of one citation span against its referenced part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanStatus {
    /// Offsets resolve under byte semantics and the slice matches the
    /// provider segment text (when the provider supplied segment text).
    Valid,
    /// Slice does not match the provider segment text.
    InvalidText,
    /// Negative, reversed, out-of-range, or non-UTF-8-boundary offsets;
    /// or the referenced part does not exist.
    InvalidOffsets,
    /// Empty span claiming nothing (no text, no indices).
    NoClaim,
}

/// Coherent citation state. `Verified` requires EVERYTHING below to hold;
/// anything else is partial or unknown. Uncertainty is never upgraded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attribution {
    Verified,
    Partial,
    Unknown,
}

/// One referenced source with its resolution outcome.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedSource {
    pub index: i64,
    pub status: SourceStatus,
    pub uri: Option<String>,
}

/// One span resolved against position-preserved sources and byte-exact parts.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedCitation {
    pub text: String,
    pub sources: Vec<ResolvedSource>,
    pub span_status: SpanStatus,
    pub attribution: Attribution,
    pub problems: Vec<String>,
}

impl ResolvedCitation {
    pub fn fully_attributed(&self) -> bool {
        self.attribution == Attribution::Verified
    }

    /// URIs of validly resolved sources, in span order.
    pub fn uris(&self) -> Vec<String> {
        self.sources
            .iter()
            .filter(|s| s.status == SourceStatus::Valid)
            .filter_map(|s| s.uri.clone())
            .collect()
    }
}

/// Parsed Gemini answer: parts plus native grounding metadata.
///
/// Retrieval classification:
/// - `Grounded`: at least one source with a URI.
/// - `Parametric`: no `groundingMetadata` key at all.
/// - `Unknown`: metadata present but yielding zero usable sources.
#[derive(Debug, Clone)]
pub struct GroundedContent {
    /// Original parts in order; boundaries preserved for validation.
    pub parts: Vec<ResponsePart>,
    /// Joined part text, display only — never used for offset validation.
    pub text: String,
    pub retrieval_mode: RetrievalMode,
    pub web_search_queries: Vec<String>,
    /// Position-preserved sources: `sources[i]` is chunk `i`.
    pub sources: Vec<Option<GroundingSource>>,
    pub spans: Vec<CitationSpan>,
    /// Integrity warnings from parsing and span pre-validation.
    pub integrity_flags: Vec<String>,
    /// Parser/interpretation version: future reprocessing can distinguish
    /// judgments made under byte-offset semantics (v2) from older ones.
    /// Raw provider evidence is never mutated; this only labels the read.
    pub interpretation_version: u32,
    /// Model identity reported by the provider response, when present.
    pub response_model: Option<String>,
    /// The original provider response object, preserved verbatim.
    pub raw_response: Value,
}

/// Current interpretation version: byte offsets into indexed parts.
pub const GROUNDING_INTERP_VERSION: u32 = 2;

/// Parse a `generateContent` response object into [`GroundedContent`].
/// Malformed payloads are explicit errors, never empty observations.
pub fn parse_grounded_response(json: &Value) -> Result<GroundedContent> {
    let candidate = json
        .get("candidates")
        .and_then(|c| c.get(0))
        .context("Gemini response missing candidates[0]")?;
    let parts_json = candidate
        .get("content")
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .context("Gemini response missing candidates[0].content.parts[]")?;
    let mut parts = Vec::new();
    let mut text = String::new();
    for (i, part) in parts_json.iter().enumerate() {
        let t = part
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        text.push_str(&t);
        parts.push(ResponsePart {
            part_index: i,
            text: t,
        });
    }
    if text.is_empty() {
        bail!("Gemini response has no text parts");
    }

    let grounding = candidate.get("groundingMetadata");
    let mut queries = Vec::new();
    let mut sources: Vec<Option<GroundingSource>> = Vec::new();
    let mut spans = Vec::new();
    let mut integrity_flags = Vec::new();
    if let Some(g) = grounding {
        if let Some(qs) = g.get("webSearchQueries").and_then(|q| q.as_array()) {
            for q in qs {
                if let Some(s) = q.as_str() {
                    queries.push(s.to_string());
                }
            }
        }
        if let Some(cs) = g.get("groundingChunks").and_then(|c| c.as_array()) {
            for (i, c) in cs.iter().enumerate() {
                let uri = c
                    .get("web")
                    .and_then(|w| w.get("uri"))
                    .and_then(|u| u.as_str())
                    .filter(|u| !u.is_empty())
                    .map(|u| u.to_string());
                let title = c
                    .get("web")
                    .and_then(|w| w.get("title"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                if uri.is_none() {
                    integrity_flags.push(format!(
                        "grounding chunk {} has no URI; spans referencing it are unattributed",
                        i
                    ));
                }
                sources.push(uri.map(|uri| GroundingSource { uri, title }));
            }
        }
        if let Some(ss) = g.get("groundingSupports").and_then(|s| s.as_array()) {
            for s in ss {
                let segment = s.get("segment");
                spans.push(CitationSpan {
                    part_index: segment
                        .and_then(|g| g.get("partIndex"))
                        .and_then(|v| v.as_i64()),
                    text: segment
                        .and_then(|g| g.get("text"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string(),
                    start_index: segment
                        .and_then(|g| g.get("startIndex"))
                        .and_then(|v| v.as_i64()),
                    end_index: segment
                        .and_then(|g| g.get("endIndex"))
                        .and_then(|v| v.as_i64()),
                    chunk_indices: s
                        .get("groundingChunkIndices")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect())
                        .unwrap_or_default(),
                });
            }
        }
    }

    let usable = sources.iter().filter(|s| s.is_some()).count();
    let retrieval_mode = if usable > 0 {
        RetrievalMode::Grounded
    } else if grounding.is_some() {
        RetrievalMode::Unknown
    } else {
        RetrievalMode::Parametric
    };
    if grounding.is_some() && usable == 0 {
        integrity_flags.push(
            "grounding metadata present but no usable sources; retrieval is unknown".to_string(),
        );
    }

    let content = GroundedContent {
        parts,
        text,
        retrieval_mode,
        web_search_queries: queries,
        sources,
        spans,
        integrity_flags,
        interpretation_version: GROUNDING_INTERP_VERSION,
        response_model: json
            .get("modelVersion")
            .and_then(|v| v.as_str())
            .map(|m| m.to_string()),
        raw_response: json.clone(),
    };
    // Pre-validate spans so parse-time flags exist even before resolution.
    let pre: Vec<String> = content
        .resolved_citations()
        .iter()
        .flat_map(|r| r.problems.clone())
        .collect();
    let mut content = content;
    content.integrity_flags.extend(pre);
    Ok(content)
}

impl GroundedContent {
    /// Resolve every span: byte offsets into the indexed part, source
    /// indices against the position-preserved array. Anything short of
    /// fully valid yields partial/unknown attribution — never verified.
    pub fn resolved_citations(&self) -> Vec<ResolvedCitation> {
        self.spans
            .iter()
            .map(|span| self.resolve_span(span))
            .collect()
    }

    fn resolve_span(&self, span: &CitationSpan) -> ResolvedCitation {
        let mut problems = Vec::new();

        // 1. Part selection. Missing partIndex defaults to part 0 (the
        //    single-part shape); anything else must exist.
        let part_idx = span.part_index.unwrap_or(0);
        let part = if part_idx < 0 {
            problems.push(format!("negative partIndex {}", part_idx));
            None
        } else {
            match self.parts.get(part_idx as usize) {
                Some(p) => Some(p),
                None => {
                    problems.push(format!(
                        "partIndex {} out of range ({} parts)",
                        part_idx,
                        self.parts.len()
                    ));
                    None
                }
            }
        };

        // 2. Byte offsets into the referenced part.
        let mut span_status = SpanStatus::Valid;
        if span.text.is_empty() && span.chunk_indices.is_empty() {
            span_status = SpanStatus::NoClaim;
        } else if let Some(part) = part {
            let bytes_len = part.text.len() as i64;
            let (start, end) = (span.start_index, span.end_index);
            let offsets_present = start.is_some() || end.is_some();
            if offsets_present {
                match (start, end) {
                    (Some(s), Some(e)) => {
                        if s < 0 || e < 0 {
                            problems.push(format!(
                                "negative offsets [{}, {}] in part {}",
                                s, e, part.part_index
                            ));
                            span_status = SpanStatus::InvalidOffsets;
                        } else if s > e {
                            problems.push(format!(
                                "reversed offsets [{}, {}] in part {}",
                                s, e, part.part_index
                            ));
                            span_status = SpanStatus::InvalidOffsets;
                        } else if e > bytes_len {
                            problems.push(format!(
                                "offsets [{}, {}] outside part {} ({} bytes)",
                                s, e, part.part_index, bytes_len
                            ));
                            span_status = SpanStatus::InvalidOffsets;
                        } else {
                            match part.text.get(s as usize..e as usize) {
                                Some(slice) if !span.text.is_empty() && slice != span.text => {
                                    problems.push(format!(
                                        "part {} bytes [{}, {}] are {:?}, provider segment is {:?}",
                                        part.part_index, s, e, slice, span.text
                                    ));
                                    span_status = SpanStatus::InvalidText;
                                }
                                Some(_) => {}
                                None => {
                                    problems.push(format!(
                                        "offsets [{}, {}] split a UTF-8 boundary in part {}",
                                        s, e, part.part_index
                                    ));
                                    span_status = SpanStatus::InvalidOffsets;
                                }
                            }
                        }
                    }
                    _ => {
                        problems.push(format!(
                            "partial offsets in part {} (need both startIndex and endIndex)",
                            part.part_index
                        ));
                        span_status = SpanStatus::InvalidOffsets;
                    }
                }
            } else if !span.text.is_empty() && !part.text.contains(&span.text) {
                problems.push(format!(
                    "span text not found verbatim in part {}",
                    part.part_index
                ));
                span_status = SpanStatus::InvalidText;
            }
        } else if span_status == SpanStatus::Valid {
            span_status = SpanStatus::InvalidOffsets;
        }

        // 3. Source resolution against original indices.
        let mut sources = Vec::new();
        let mut any_valid = false;
        let mut any_invalid = false;
        if span.chunk_indices.is_empty() {
            any_invalid = true;
            problems.push("span references no chunks".to_string());
        }
        for idx in &span.chunk_indices {
            if *idx < 0 {
                any_invalid = true;
                problems.push(format!("negative chunk index {}", idx));
                sources.push(ResolvedSource {
                    index: *idx,
                    status: SourceStatus::InvalidIndex,
                    uri: None,
                });
                continue;
            }
            match self.sources.get(*idx as usize) {
                Some(Some(src)) => {
                    any_valid = true;
                    sources.push(ResolvedSource {
                        index: *idx,
                        status: SourceStatus::Valid,
                        uri: Some(src.uri.clone()),
                    });
                }
                Some(None) => {
                    any_invalid = true;
                    problems.push(format!("chunk {} has no URI; attribution unknown", idx));
                    sources.push(ResolvedSource {
                        index: *idx,
                        status: SourceStatus::MissingUri,
                        uri: None,
                    });
                }
                None => {
                    any_invalid = true;
                    problems.push(format!(
                        "chunk index {} out of range ({} sources); attribution unknown",
                        idx,
                        self.sources.len()
                    ));
                    sources.push(ResolvedSource {
                        index: *idx,
                        status: SourceStatus::InvalidIndex,
                        uri: None,
                    });
                }
            }
        }

        // 4. Coherent state: verified only when EVERYTHING holds.
        let attribution = match (span_status, any_valid, any_invalid) {
            (SpanStatus::Valid, true, false) => Attribution::Verified,
            (SpanStatus::Valid, true, true) => Attribution::Partial,
            (SpanStatus::NoClaim, _, _) => Attribution::Unknown,
            _ => Attribution::Unknown,
        };

        ResolvedCitation {
            text: span.text.clone(),
            sources,
            span_status,
            attribution,
            problems,
        }
    }

    /// Number of sources carrying a usable URI.
    pub fn usable_source_count(&self) -> usize {
        self.sources.iter().filter(|s| s.is_some()).count()
    }
}

pub fn classify_request_error(err: &anyhow::Error) -> FailureClass {
    let msg = err.to_string().to_lowercase();
    if msg.contains("401") || msg.contains("403") || msg.contains("api key") {
        FailureClass::Auth
    } else if msg.contains("429") || msg.contains("rate") {
        FailureClass::RateLimit
    } else if msg.contains("timeout") || msg.contains("timed out") {
        FailureClass::Timeout
    } else if msg.contains("malformed") || msg.contains("missing candidates") {
        FailureClass::MalformedResponse
    } else {
        FailureClass::Transport
    }
}

pub struct GeminiGroundedAdapter {
    client: Client,
    config: ProviderConfig,
}

impl GeminiGroundedAdapter {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(config.timeout_secs))
                .build()
                .unwrap_or_else(|_| Client::new()),
            config,
        }
    }

    fn api_key(&self) -> Result<String> {
        let key = self.config.api_key.trim();
        if key.is_empty() {
            bail!("Missing Gemini API key for grounded search");
        }
        if let Ok(env) = std::env::var("GEMINI_API_KEY") {
            if !env.trim().is_empty() {
                return Ok(env);
            }
        }
        Ok(key.to_string())
    }

    fn endpoint(&self) -> String {
        format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
            self.config.model
        )
    }

    /// Live grounded query. Requires `GEMINI_API_KEY` (config or env) and
    /// explicit opt-in `GHOSTPING_LIVE_GEMINI=1` — live calls spend budget.
    /// CI and default paths use fixtures via [`parse_grounded_response`].
    pub async fn query_live(&self, prompt: &str) -> Result<GroundedContent> {
        if std::env::var("GHOSTPING_LIVE_GEMINI").unwrap_or_default() != "1" {
            bail!(
                "Live Gemini grounded search requires GHOSTPING_LIVE_GEMINI=1 (spends API budget)"
            );
        }
        let key = self.api_key()?;
        let body = json!({
            "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
            "tools": [{ "google_search": {} }],
            "generationConfig": { "temperature": self.config.temperature },
        });
        let resp = self
            .client
            .post(self.endpoint())
            .header("x-goog-api-key", key)
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp
                .text()
                .await
                .unwrap_or_else(|e| format!("<unreadable error body: {}>", e));
            bail!("Gemini grounded error {}: {}", status, text);
        }
        let json: Value = resp.json().await?;
        parse_grounded_response(&json)
    }
}

#[async_trait]
impl LlmProvider for GeminiGroundedAdapter {
    fn name(&self) -> &str {
        "gemini-grounded"
    }

    async fn query_with_system(&self, system: Option<&str>, prompt: &str) -> Result<String> {
        let full = match system {
            Some(s) => format!("{}\n\n{}", s, prompt),
            None => prompt.to_string(),
        };
        Ok(self.query_live(&full).await?.text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GROUNDED_FIXTURE: &str = include_str!("../../tests/fixtures/gemini_grounded.json");
    const UNGROUNDED_FIXTURE: &str = include_str!("../../tests/fixtures/gemini_ungrounded.json");

    fn multipart_fixture() -> Value {
        // part[0] = "first" (5 bytes); part[1] = "The product costs $49."
        // Byte offsets into part 1: "product" == bytes [4..11].
        serde_json::json!({
            "candidates": [{
                "content": {"parts": [{"text": "first"}, {"text": "The product costs $49."}]},
                "groundingMetadata": {
                    "webSearchQueries": ["product price"],
                    "groundingChunks": [
                        {"web": {"uri": "https://shop.example/p", "title": "Shop"}}
                    ],
                    "groundingSupports": [{
                        "segment": {"partIndex": 1, "startIndex": 4, "endIndex": 11, "text": "product"},
                        "groundingChunkIndices": [0]
                    }]
                }
            }]
        })
    }

    #[test]
    fn test_parse_grounded_fixture() {
        let json: Value = serde_json::from_str(GROUNDED_FIXTURE).unwrap();
        let content = parse_grounded_response(&json).unwrap();
        assert_eq!(content.retrieval_mode, RetrievalMode::Grounded);
        assert_eq!(content.interpretation_version, GROUNDING_INTERP_VERSION);
        assert!(content.text.contains("Ghostping"));
        assert_eq!(
            content.web_search_queries,
            vec!["best rust cli visibility tool"]
        );
        assert_eq!(content.sources.len(), 2);
        assert_eq!(
            content.sources[0].as_ref().unwrap().uri,
            "https://example.com/docs"
        );
        assert_eq!(content.spans.len(), 1);
        assert!(content.integrity_flags.is_empty());
        let resolved = content.resolved_citations();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].attribution, Attribution::Verified);
        assert!(resolved[0].fully_attributed());
        assert_eq!(resolved[0].uris(), vec!["https://example.com/docs"]);
        assert_eq!(content.raw_response, json);
    }

    #[test]
    fn test_unguarded_response_is_parametric() {
        let json: Value = serde_json::from_str(UNGROUNDED_FIXTURE).unwrap();
        let content = parse_grounded_response(&json).unwrap();
        assert_eq!(content.retrieval_mode, RetrievalMode::Parametric);
        assert!(content.sources.is_empty());
        assert!(!content.text.is_empty());
    }

    #[test]
    fn test_empty_grounding_metadata_is_unknown_not_parametric() {
        let json = serde_json::json!({
            "candidates": [{
                "content": {"parts": [{"text": "plain answer"}]},
                "groundingMetadata": {
                    "webSearchQueries": [],
                    "groundingChunks": [{"web": {"title": "no uri here"}}],
                    "groundingSupports": []
                }
            }]
        });
        let content = parse_grounded_response(&json).unwrap();
        assert_eq!(content.retrieval_mode, RetrievalMode::Unknown);
        assert_eq!(content.sources.len(), 1);
        assert!(content.sources[0].is_none());
        assert!(!content.integrity_flags.is_empty());
    }

    #[test]
    fn test_part_index_one_resolves_against_part_one() {
        // Required multipart case: support points into partIndex 1 and must
        // resolve there — never against concatenated text.
        let content = parse_grounded_response(&multipart_fixture()).unwrap();
        assert_eq!(content.parts.len(), 2);
        assert_eq!(content.parts[0].text, "first");
        assert_eq!(content.parts[1].text, "The product costs $49.");
        let resolved = content.resolved_citations();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].span_status, SpanStatus::Valid);
        assert_eq!(resolved[0].attribution, Attribution::Verified);
        assert_eq!(resolved[0].uris(), vec!["https://shop.example/p"]);
    }

    #[test]
    fn test_part_index_zero_and_missing() {
        // partIndex 0 selects the first part; omitted partIndex defaults to 0.
        for part_index in [Some(0i64), None] {
            let mut fx = multipart_fixture();
            fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]
                .as_object_mut()
                .unwrap()
                .remove("partIndex");
            if let Some(i) = part_index {
                fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]
                    ["partIndex"] = serde_json::json!(i);
            }
            // Rewrite the span to match part 0 ("first", bytes [0..5]).
            fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]
                ["startIndex"] = serde_json::json!(0);
            fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]
                ["endIndex"] = serde_json::json!(5);
            fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]["text"] =
                serde_json::json!("first");
            let content = parse_grounded_response(&fx).unwrap();
            let resolved = content.resolved_citations();
            assert_eq!(
                resolved[0].span_status,
                SpanStatus::Valid,
                "part_index {:?}",
                part_index
            );
            assert_eq!(resolved[0].attribution, Attribution::Verified);
        }
    }

    #[test]
    fn test_out_of_range_part_index_is_invalid() {
        let mut fx = multipart_fixture();
        fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]["partIndex"] =
            serde_json::json!(7);
        let content = parse_grounded_response(&fx).unwrap();
        let resolved = content.resolved_citations();
        assert_eq!(resolved[0].span_status, SpanStatus::InvalidOffsets);
        assert_eq!(resolved[0].attribution, Attribution::Unknown);
        assert!(!resolved[0].fully_attributed());
    }

    #[test]
    fn test_uri_less_middle_chunk_keeps_index_alignment() {
        let json = serde_json::json!({
            "candidates": [{
                "content": {"parts": [{"text": "Alpha beta gamma."}]},
                "groundingMetadata": {
                    "webSearchQueries": ["q"],
                    "groundingChunks": [
                        {"web": {"uri": "https://a.example/", "title": "A"}},
                        {"web": {"title": "no uri"}},
                        {"web": {"uri": "https://c.example/", "title": "C"}}
                    ],
                    "groundingSupports": [{
                        "segment": {"partIndex": 0, "startIndex": 6, "endIndex": 10, "text": "beta"},
                        "groundingChunkIndices": [0]
                    }, {
                        "segment": {"partIndex": 0, "startIndex": 11, "endIndex": 17, "text": "gamma."},
                        "groundingChunkIndices": [2]
                    }, {
                        "segment": {"partIndex": 0, "startIndex": 0, "endIndex": 5, "text": "Alpha"},
                        "groundingChunkIndices": [1]
                    }]
                }
            }]
        });
        let content = parse_grounded_response(&json).unwrap();
        assert_eq!(content.retrieval_mode, RetrievalMode::Grounded);
        assert_eq!(content.sources.len(), 3);
        assert!(content.sources[1].is_none());
        let resolved = content.resolved_citations();
        assert_eq!(resolved[0].uris(), vec!["https://a.example/"]);
        assert_eq!(resolved[0].attribution, Attribution::Verified);
        assert_eq!(resolved[1].uris(), vec!["https://c.example/"]);
        assert_eq!(resolved[1].attribution, Attribution::Verified);
        assert!(resolved[2].uris().is_empty());
        assert_eq!(resolved[2].attribution, Attribution::Unknown);
        assert_eq!(resolved[2].sources[0].status, SourceStatus::MissingUri);
    }

    #[test]
    fn test_broken_references_are_unknown() {
        let json = serde_json::json!({
            "candidates": [{
                "content": {"parts": [{"text": "Short answer."}]},
                "groundingMetadata": {
                    "groundingChunks": [
                        {"web": {"uri": "https://a.example/", "title": "A"}}
                    ],
                    "groundingSupports": [{
                        "segment": {"partIndex": 0, "startIndex": 0, "endIndex": 5, "text": "Short"},
                        "groundingChunkIndices": [7]
                    }, {
                        "segment": {"partIndex": 0, "startIndex": 0, "endIndex": 5, "text": "Short"},
                        "groundingChunkIndices": [-1]
                    }]
                }
            }]
        });
        let content = parse_grounded_response(&json).unwrap();
        let resolved = content.resolved_citations();
        assert_eq!(resolved[0].attribution, Attribution::Unknown);
        assert_eq!(resolved[0].sources[0].status, SourceStatus::InvalidIndex);
        assert_eq!(resolved[1].attribution, Attribution::Unknown);
    }

    #[test]
    fn test_start_greater_than_end_is_invalid() {
        let mut fx = multipart_fixture();
        fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]["startIndex"] =
            serde_json::json!(11);
        fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]["endIndex"] =
            serde_json::json!(4);
        let content = parse_grounded_response(&fx).unwrap();
        let resolved = content.resolved_citations();
        assert_eq!(resolved[0].span_status, SpanStatus::InvalidOffsets);
        assert_eq!(resolved[0].attribution, Attribution::Unknown);
    }

    #[test]
    fn test_offsets_outside_part_are_invalid() {
        let mut fx = multipart_fixture();
        fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]["endIndex"] =
            serde_json::json!(5000);
        let content = parse_grounded_response(&fx).unwrap();
        let resolved = content.resolved_citations();
        assert_eq!(resolved[0].span_status, SpanStatus::InvalidOffsets);
        assert_eq!(resolved[0].attribution, Attribution::Unknown);
    }

    #[test]
    fn test_unicode_byte_offsets() {
        // "café": c(1) a(1) f(1) é(2) = 5 bytes, 4 chars.
        // "日本語": 3×3 = 9 bytes, 3 chars. "🦀": 4 bytes, 1 char.
        let text = "café 日本語 🦀!";
        let bytes_len = text.len();
        assert_eq!(text.chars().count(), 11);
        let json = serde_json::json!({
            "candidates": [{
                "content": {"parts": [{"text": text}]},
                "groundingMetadata": {
                    "groundingChunks": [
                        {"web": {"uri": "https://u.example/", "title": "U"}}
                    ],
                    "groundingSupports": [
                        {
                            "segment": {"partIndex": 0, "startIndex": 3, "endIndex": 5, "text": "é"},
                            "groundingChunkIndices": [0]
                        },
                        {
                            "segment": {"partIndex": 0, "startIndex": 6, "endIndex": 15, "text": "日本語"},
                            "groundingChunkIndices": [0]
                        },
                        {
                            // Splits the crab emoji mid-code-point: invalid, no panic.
                            "segment": {"partIndex": 0, "startIndex": 16, "endIndex": 17, "text": "?"},
                            "groundingChunkIndices": [0]
                        },
                        {
                            "segment": {"partIndex": 0, "startIndex": 0, "endIndex": 3, "text": "WRONG"},
                            "groundingChunkIndices": [0]
                        }
                    ]
                }
            }]
        });
        assert_eq!(
            bytes_len,
            "café".len() + 1 + "日本語".len() + 1 + "🦀".len() + 1
        );
        let content = parse_grounded_response(&json).unwrap();
        let resolved = content.resolved_citations();
        assert_eq!(resolved[0].span_status, SpanStatus::Valid);
        assert_eq!(resolved[0].attribution, Attribution::Verified);
        assert_eq!(resolved[1].span_status, SpanStatus::Valid);
        assert_eq!(resolved[1].attribution, Attribution::Verified);
        assert_eq!(resolved[2].span_status, SpanStatus::InvalidOffsets);
        assert_eq!(resolved[2].attribution, Attribution::Unknown);
        assert_eq!(resolved[3].span_status, SpanStatus::InvalidText);
        assert_eq!(resolved[3].attribution, Attribution::Unknown);
    }

    #[test]
    fn test_partial_attribution_when_some_sources_invalid() {
        // Valid span citing one good + one out-of-range chunk: Partial,
        // never silently fully verified.
        let mut fx = multipart_fixture();
        fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["groundingChunkIndices"] =
            serde_json::json!([0, 9]);
        let content = parse_grounded_response(&fx).unwrap();
        let resolved = content.resolved_citations();
        assert_eq!(resolved[0].span_status, SpanStatus::Valid);
        assert_eq!(resolved[0].attribution, Attribution::Partial);
        assert!(!resolved[0].fully_attributed());
        assert_eq!(resolved[0].uris(), vec!["https://shop.example/p"]);
    }

    #[test]
    fn test_attribution_truth_table() {
        // valid URI + invalid span != verified
        let mut fx = multipart_fixture();
        fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["segment"]["text"] =
            serde_json::json!("WRONG");
        let content = parse_grounded_response(&fx).unwrap();
        let r = &content.resolved_citations()[0];
        assert_eq!(r.span_status, SpanStatus::InvalidText);
        assert_ne!(r.attribution, Attribution::Verified);

        // valid span + invalid source != verified
        let mut fx = multipart_fixture();
        fx["candidates"][0]["groundingMetadata"]["groundingSupports"][0]["groundingChunkIndices"] =
            serde_json::json!([5]);
        let content = parse_grounded_response(&fx).unwrap();
        let r = &content.resolved_citations()[0];
        assert_eq!(r.span_status, SpanStatus::Valid);
        assert_ne!(r.attribution, Attribution::Verified);

        // valid span + valid source = verified
        let content = parse_grounded_response(&multipart_fixture()).unwrap();
        let r = &content.resolved_citations()[0];
        assert_eq!(r.span_status, SpanStatus::Valid);
        assert_eq!(r.attribution, Attribution::Verified);
        assert!(r.fully_attributed());
    }

    #[test]
    fn test_malformed_payloads_are_errors() {
        for raw in [
            serde_json::json!({}),
            serde_json::json!({"candidates": []}),
            serde_json::json!({"candidates": [{"content": {}}]}),
            serde_json::json!({"candidates": [{"content": {"parts": []}}]}),
            serde_json::json!({"candidates": [{"content": {"parts": [{"text": ""}]}}]}),
            serde_json::json!({"error": {"message": "bad key"}}),
        ] {
            assert!(parse_grounded_response(&raw).is_err());
        }
    }

    #[test]
    fn test_failure_classification() {
        let auth = anyhow::anyhow!("Gemini grounded error 401: bad key");
        assert_eq!(classify_request_error(&auth), FailureClass::Auth);
        let timeout = anyhow::anyhow!("request timed out");
        assert_eq!(classify_request_error(&timeout), FailureClass::Timeout);
        let malformed = anyhow::anyhow!("Gemini response missing candidates[0]");
        assert_eq!(
            classify_request_error(&malformed),
            FailureClass::MalformedResponse
        );
        let other = anyhow::anyhow!("connection reset");
        assert_eq!(classify_request_error(&other), FailureClass::Transport);
    }
}
