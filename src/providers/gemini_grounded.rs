use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};

use super::LlmProvider;
use crate::config::ProviderConfig;
use crate::observations::{FailureClass, RetrievalMode};

/// One grounding source as emitted natively by the Gemini API.
/// `uri` is `None` when the provider emitted a chunk without a URI: the
/// position is preserved (never dropped) so `groundingSupports` indices
/// keep referring to the right source.
#[derive(Debug, Clone, PartialEq)]
pub struct GroundingSource {
    /// Always `Some` URI text: the slot itself is `None` when the provider
    /// emitted no URI, preserving the position without inventing a link.
    pub uri: String,
    pub title: String,
}

/// One citation span binding answer text to grounding sources, using the
/// provider's ORIGINAL chunk indices.
#[derive(Debug, Clone, PartialEq)]
pub struct CitationSpan {
    pub text: String,
    pub start_index: Option<i64>,
    pub end_index: Option<i64>,
    pub chunk_indices: Vec<i64>,
}

/// A span resolved against the position-preserved source array.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedCitation {
    pub text: String,
    /// URIs of validly referenced sources, in span order.
    pub uris: Vec<String>,
    /// True when every referenced index was valid AND carried a URI.
    /// False means unknown attribution — never a link to another source.
    pub fully_attributed: bool,
    pub problems: Vec<String>,
}

/// Parsed Gemini answer: text plus native grounding metadata.
///
/// Retrieval classification:
/// - `Grounded`: at least one source with a URI.
/// - `Parametric`: no `groundingMetadata` key at all (search grounding did
///   not happen for this answer).
/// - `Unknown`: metadata present but yielding zero usable sources. Missing
///   URI chunks do NOT prove a parameters-only answer, so this is unknown,
///   not parametric. Unknown/parametic/grounded responses are never pooled.
#[derive(Debug, Clone)]
pub struct GroundedContent {
    /// All answer parts concatenated in order (multi-part answers preserved).
    pub text: String,
    pub retrieval_mode: RetrievalMode,
    pub web_search_queries: Vec<String>,
    /// Position-preserved sources: `sources[i]` is chunk `i`.
    pub sources: Vec<Option<GroundingSource>>,
    pub spans: Vec<CitationSpan>,
    /// Integrity warnings: invalid references, failed span validation.
    pub integrity_flags: Vec<String>,
    /// The original provider response object, preserved verbatim.
    pub raw_response: Value,
    /// Model identity reported by the provider response, when present.
    pub response_model: Option<String>,
}

/// Parse a `generateContent` response object into [`GroundedContent`].
/// Malformed payloads are explicit errors, never empty observations.
///
/// Source positions are preserved 1:1 (`sources[i]` is chunk `i`), so
/// `groundingSupports` indices resolve exactly as the provider emitted
/// them. Invalid references yield integrity flags + unknown attribution,
/// never a link to another source.
pub fn parse_grounded_response(json: &Value) -> Result<GroundedContent> {
    let candidate = json
        .get("candidates")
        .and_then(|c| c.get(0))
        .context("Gemini response missing candidates[0]")?;
    // Multi-part answers: concatenate every text part in order.
    let parts = candidate
        .get("content")
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .context("Gemini response missing candidates[0].content.parts[]")?;
    let mut text = String::new();
    for part in parts {
        if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
            text.push_str(t);
        }
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
                    // Position preserved as None: the index still exists,
                    // it just carries no citable URI. Never invent one.
                    integrity_flags.push(format!(
                        "grounding chunk {} has no URI; spans referencing it are unattributed",
                        i
                    ));
                }
                sources.push(uri.map(|uri| GroundingSource { uri, title }));
            }
        }
        if let Some(ss) = g.get("groundingSupports").and_then(|s| s.as_array()) {
            for (si, s) in ss.iter().enumerate() {
                let segment = s.get("segment");
                let span = CitationSpan {
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
                };
                validate_span(&span, &text, si, &mut integrity_flags);
                spans.push(span);
            }
        }
    }

    let usable = sources.iter().filter(|s| s.is_some()).count();
    let retrieval_mode = if usable > 0 {
        RetrievalMode::Grounded
    } else if grounding.is_some() {
        // Metadata present but nothing usable: unverified, NOT parametric.
        RetrievalMode::Unknown
    } else {
        RetrievalMode::Parametric
    };
    if grounding.is_some() && usable == 0 {
        integrity_flags.push(
            "grounding metadata present but no usable sources; retrieval is unknown".to_string(),
        );
    }

    let response_model = json
        .get("modelVersion")
        .and_then(|v| v.as_str())
        .map(|m| m.to_string());
    Ok(GroundedContent {
        text,
        retrieval_mode,
        web_search_queries: queries,
        sources,
        spans,
        integrity_flags,
        raw_response: json.clone(),
        response_model,
    })
}

/// Validate one span against the answer text (Unicode-safe).
/// Records integrity problems; never fails the parse itself.
fn validate_span(span: &CitationSpan, answer: &str, span_idx: usize, flags: &mut Vec<String>) {
    if !span.text.is_empty() && !answer.contains(&span.text) {
        flags.push(format!(
            "span {} text not found verbatim in answer; treating as unattributed",
            span_idx
        ));
    }
    let answer_chars = answer.chars().count() as i64;
    for (label, bound) in [("start", span.start_index), ("end", span.end_index)] {
        if let Some(b) = bound {
            if b < 0 || b > answer_chars {
                flags.push(format!(
                    "span {} {} offset {} out of range (answer is {} chars)",
                    span_idx, label, b, answer_chars
                ));
            }
        }
    }
}

impl GroundedContent {
    /// Resolve every span against the position-preserved sources.
    /// Out-of-range indices and URI-less sources yield unknown attribution
    /// with explicit problems — never a neighbouring source's link.
    pub fn resolved_citations(&self) -> Vec<ResolvedCitation> {
        self.spans
            .iter()
            .map(|span| {
                let mut uris = Vec::new();
                let mut problems = Vec::new();
                let mut fully = true;
                if span.chunk_indices.is_empty() {
                    fully = false;
                    problems.push("span references no chunks".to_string());
                }
                for idx in &span.chunk_indices {
                    if *idx < 0 {
                        fully = false;
                        problems.push(format!("negative chunk index {}", idx));
                        continue;
                    }
                    match self.sources.get(*idx as usize) {
                        Some(Some(src)) => uris.push(src.uri.clone()),
                        Some(None) => {
                            fully = false;
                            problems.push(format!("chunk {} has no URI; attribution unknown", idx));
                        }
                        None => {
                            fully = false;
                            problems.push(format!(
                                "chunk index {} out of range ({} sources); attribution unknown",
                                idx,
                                self.sources.len()
                            ));
                        }
                    }
                }
                let attributed = fully && !uris.is_empty();
                ResolvedCitation {
                    text: span.text.clone(),
                    uris,
                    fully_attributed: attributed,
                    problems,
                }
            })
            .collect()
    }

    /// Number of sources carrying a usable URI.
    pub fn usable_source_count(&self) -> usize {
        self.sources.iter().filter(|s| s.is_some()).count()
    }
}

/// Classify a transport/API failure for the envelope's `failure_class`.
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

    #[test]
    fn test_parse_grounded_fixture() {
        let json: Value = serde_json::from_str(GROUNDED_FIXTURE).unwrap();
        let content = parse_grounded_response(&json).unwrap();
        assert_eq!(content.retrieval_mode, RetrievalMode::Grounded);
        assert!(content.text.contains("Ghostping"));
        assert_eq!(
            content.web_search_queries,
            vec!["best rust cli visibility tool"]
        );
        // Positions preserved 1:1 with the provider array.
        assert_eq!(content.sources.len(), 2);
        assert_eq!(
            content.sources[0].as_ref().unwrap().uri,
            "https://example.com/docs"
        );
        assert_eq!(content.sources[0].as_ref().unwrap().title, "Example Docs");
        assert_eq!(content.spans.len(), 1);
        assert_eq!(content.spans[0].chunk_indices, vec![0]);
        assert!(content.integrity_flags.is_empty());
        // Resolution binds the span to the original source URI.
        let resolved = content.resolved_citations();
        assert_eq!(resolved.len(), 1);
        assert!(resolved[0].fully_attributed);
        assert_eq!(resolved[0].uris, vec!["https://example.com/docs"]);
        // Original response preserved verbatim.
        assert_eq!(content.raw_response, json);
    }

    #[test]
    fn test_unguarded_response_is_parametric() {
        // No groundingMetadata key at all: search grounding did not happen.
        let json: Value = serde_json::from_str(UNGROUNDED_FIXTURE).unwrap();
        let content = parse_grounded_response(&json).unwrap();
        assert_eq!(content.retrieval_mode, RetrievalMode::Parametric);
        assert!(content.sources.is_empty());
        assert!(!content.text.is_empty());
    }

    #[test]
    fn test_empty_grounding_metadata_is_unknown_not_parametric() {
        // Present-but-empty metadata proves nothing about retrieval.
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
        // Position preserved as an unattributed slot.
        assert_eq!(content.sources.len(), 1);
        assert!(content.sources[0].is_none());
        assert!(!content.integrity_flags.is_empty());
    }

    #[test]
    fn test_uri_less_middle_chunk_keeps_index_alignment() {
        // Regression: dropping the middle chunk used to shift every later
        // index, linking spans to the wrong source.
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
                        "segment": {"startIndex": 6, "endIndex": 10, "text": "beta"},
                        "groundingChunkIndices": [0]
                    }, {
                        "segment": {"startIndex": 11, "endIndex": 16, "text": "gamma"},
                        "groundingChunkIndices": [2]
                    }, {
                        "segment": {"startIndex": 0, "endIndex": 5, "text": "Alpha"},
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
        assert_eq!(resolved[0].uris, vec!["https://a.example/"]);
        assert!(resolved[0].fully_attributed);
        // Index 2 still points at C, not shifted.
        assert_eq!(resolved[1].uris, vec!["https://c.example/"]);
        assert!(resolved[1].fully_attributed);
        // Index 1 is unattributed — unknown, not a neighbour's link.
        assert!(resolved[2].uris.is_empty());
        assert!(!resolved[2].fully_attributed);
        assert!(resolved[2].problems.iter().any(|p| p.contains("no URI")));
    }

    #[test]
    fn test_broken_and_out_of_range_references_are_unknown() {
        let json = serde_json::json!({
            "candidates": [{
                "content": {"parts": [{"text": "Short answer."}]},
                "groundingMetadata": {
                    "groundingChunks": [
                        {"web": {"uri": "https://a.example/", "title": "A"}}
                    ],
                    "groundingSupports": [{
                        "segment": {"startIndex": 0, "endIndex": 5, "text": "Short"},
                        "groundingChunkIndices": [7]
                    }, {
                        "segment": {"startIndex": 0, "endIndex": 5, "text": "Short"},
                        "groundingChunkIndices": [-1]
                    }, {
                        "segment": {"startIndex": 0, "endIndex": 5000, "text": "Short"},
                        "groundingChunkIndices": [0]
                    }]
                }
            }]
        });
        let content = parse_grounded_response(&json).unwrap();
        let resolved = content.resolved_citations();
        assert!(!resolved[0].fully_attributed);
        assert!(resolved[0]
            .problems
            .iter()
            .any(|p| p.contains("out of range")));
        assert!(!resolved[1].fully_attributed);
        assert!(resolved[1].problems.iter().any(|p| p.contains("negative")));
        // Offset out of range is flagged at parse time too.
        assert!(content
            .integrity_flags
            .iter()
            .any(|f| f.contains("out of range")));
    }

    #[test]
    fn test_unicode_and_multipart_answers_validate() {
        let json = serde_json::json!({
            "candidates": [{
                "content": {"parts": [
                    {"text": "Ghostping 🦀 rocks. "},
                    {"text": "詳細はこちらを参照してください。"}
                ]},
                "groundingMetadata": {
                    "groundingChunks": [
                        {"web": {"uri": "https://example.com/docs", "title": "Docs"}}
                    ],
                    "groundingSupports": [{
                        "segment": {"text": "🦀"},
                        "groundingChunkIndices": [0]
                    }, {
                        "segment": {"text": "not in the answer"},
                        "groundingChunkIndices": [0]
                    }]
                }
            }]
        });
        let content = parse_grounded_response(&json).unwrap();
        // Both parts preserved in order.
        assert!(content.text.contains("🦀 rocks."));
        assert!(content.text.contains("詳細"));
        assert_eq!(content.retrieval_mode, RetrievalMode::Grounded);
        // Present span validates; absent span is flagged, never fatal.
        assert_eq!(content.integrity_flags.len(), 1);
        assert!(content.integrity_flags[0].contains("not found verbatim"));
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
