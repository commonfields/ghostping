use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};

use super::LlmProvider;
use crate::config::ProviderConfig;
use crate::observations::{FailureClass, RetrievalMode};

/// One grounding chunk as emitted natively by the Gemini API.
#[derive(Debug, Clone, PartialEq)]
pub struct GroundingChunk {
    pub uri: String,
    pub title: String,
}

/// One citation span binding answer text to grounding chunks.
#[derive(Debug, Clone, PartialEq)]
pub struct CitationSpan {
    pub text: String,
    pub start_index: Option<i64>,
    pub end_index: Option<i64>,
    pub chunk_indices: Vec<i64>,
}

/// Parsed Gemini answer: text plus native grounding metadata.
/// `retrieval_mode` is `Grounded` only when at least one grounding chunk
/// with a URI is present; otherwise the answer is `Parametric` even if a
/// (possibly empty) `groundingMetadata` object exists.
#[derive(Debug, Clone)]
pub struct GroundedContent {
    pub text: String,
    pub retrieval_mode: RetrievalMode,
    pub web_search_queries: Vec<String>,
    pub chunks: Vec<GroundingChunk>,
    pub spans: Vec<CitationSpan>,
    /// The original provider response object, preserved verbatim.
    pub raw_response: Value,
}

/// Parse a `generateContent` response object into [`GroundedContent`].
/// Malformed payloads are explicit errors, never empty observations.
pub fn parse_grounded_response(json: &Value) -> Result<GroundedContent> {
    let candidate = json
        .get("candidates")
        .and_then(|c| c.get(0))
        .context("Gemini response missing candidates[0]")?;
    let text = candidate
        .get("content")
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .context("Gemini response missing candidates[0].content.parts[0].text")?
        .to_string();

    let grounding = candidate.get("groundingMetadata");
    let mut queries = Vec::new();
    let mut chunks = Vec::new();
    let mut spans = Vec::new();
    if let Some(g) = grounding {
        if let Some(qs) = g.get("webSearchQueries").and_then(|q| q.as_array()) {
            for q in qs {
                if let Some(s) = q.as_str() {
                    queries.push(s.to_string());
                }
            }
        }
        if let Some(cs) = g.get("groundingChunks").and_then(|c| c.as_array()) {
            for c in cs {
                let uri = c
                    .get("web")
                    .and_then(|w| w.get("uri"))
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string();
                let title = c
                    .get("web")
                    .and_then(|w| w.get("title"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                // Chunks without a URI carry no citation; drop them rather
                // than inventing one.
                if !uri.is_empty() {
                    chunks.push(GroundingChunk { uri, title });
                }
            }
        }
        if let Some(ss) = g.get("groundingSupports").and_then(|s| s.as_array()) {
            for s in ss {
                let segment = s.get("segment");
                spans.push(CitationSpan {
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

    let retrieval_mode = if chunks.is_empty() {
        RetrievalMode::Parametric
    } else {
        RetrievalMode::Grounded
    };
    Ok(GroundedContent {
        text,
        retrieval_mode,
        web_search_queries: queries,
        chunks,
        spans,
        raw_response: json.clone(),
    })
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
        assert_eq!(content.chunks.len(), 2);
        assert_eq!(content.chunks[0].uri, "https://example.com/docs");
        assert_eq!(content.chunks[0].title, "Example Docs");
        assert_eq!(content.spans.len(), 1);
        assert_eq!(content.spans[0].chunk_indices, vec![0]);
        // Original response preserved verbatim.
        assert_eq!(content.raw_response, json);
    }

    #[test]
    fn test_unguarded_response_is_parametric() {
        let json: Value = serde_json::from_str(UNGROUNDED_FIXTURE).unwrap();
        let content = parse_grounded_response(&json).unwrap();
        assert_eq!(content.retrieval_mode, RetrievalMode::Parametric);
        assert!(content.chunks.is_empty());
        assert!(!content.text.is_empty());
    }

    #[test]
    fn test_empty_grounding_metadata_is_parametric_not_grounded() {
        // Present-but-empty metadata must not upgrade the mode, and
        // URI-less chunks must not invent citations.
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
        assert_eq!(content.retrieval_mode, RetrievalMode::Parametric);
        assert!(content.chunks.is_empty());
    }

    #[test]
    fn test_malformed_payloads_are_errors() {
        for raw in [
            serde_json::json!({}),
            serde_json::json!({"candidates": []}),
            serde_json::json!({"candidates": [{"content": {}}]}),
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
