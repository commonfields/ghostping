use anyhow::{bail, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};

use super::LlmProvider;
use crate::config::ProviderConfig;

pub struct GeminiProvider {
    client: Client,
    config: ProviderConfig,
}

impl GeminiProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(config.timeout_secs))
                .build()
                .unwrap_or_default(),
            config,
        }
    }
}

#[async_trait]
impl LlmProvider for GeminiProvider {
    fn name(&self) -> &str {
        "gemini"
    }

    async fn query_with_system(&self, system: Option<&str>, prompt: &str) -> Result<String> {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.config.model, self.config.api_key
        );

        // Gemini uses systemInstruction + contents rather than a messages array.
        let mut body = json!({
            "contents": [
                { "role": "user", "parts": [{ "text": prompt }] }
            ],
            "generationConfig": {
                "temperature": self.config.temperature
            }
        });

        if let Some(sys) = system {
            body["systemInstruction"] = json!({
                "parts": [{ "text": sys }]
            });
        }

        let resp = self.client.post(&url).json(&body).send().await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp
                .text()
                .await
                .unwrap_or_else(|e| format!("<unreadable error body: {}>", e));
            bail!("Gemini error {}: {}", status, text);
        }

        let json: Value = resp.json().await?;
        extract_content(&json)
    }
}

/// Extract the reply text from a generateContent payload.
/// Malformed payloads are explicit errors — they must never become
/// successful empty-string observations.
fn extract_content(json: &Value) -> Result<String> {
    json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| {
            anyhow::anyhow!("Gemini response missing candidates[0].content.parts[0].text")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_extract_content_valid() {
        let v = json!({"candidates": [{"content": {"parts": [{"text": "hello"}]}}]});
        assert_eq!(extract_content(&v).unwrap(), "hello");
    }

    #[test]
    fn test_extract_content_malformed_is_error() {
        for v in [
            json!({}),
            json!({"candidates": []}),
            json!({"candidates": [{"content": {"parts": []}}]}),
            json!({"candidates": [{"content": {"parts": [{"text": 1}]}}]}),
            json!({"error": {"message": "bad key"}}),
        ] {
            assert!(extract_content(&v).is_err(), "payload: {}", v);
        }
    }
}
