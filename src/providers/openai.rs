use anyhow::{bail, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};

use super::LlmProvider;
use crate::config::ProviderConfig;

pub struct OpenAiProvider {
    client: Client,
    config: ProviderConfig,
}

impl OpenAiProvider {
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
impl LlmProvider for OpenAiProvider {
    fn name(&self) -> &str {
        "openai"
    }

    async fn query_with_system(&self, system: Option<&str>, prompt: &str) -> Result<String> {
        let mut messages = vec![];
        if let Some(sys) = system {
            messages.push(json!({"role": "system", "content": sys}));
        }
        messages.push(json!({"role": "user", "content": prompt}));

        let body = json!({
            "model": self.config.model,
            "temperature": self.config.temperature,
            "messages": messages
        });

        let resp = self
            .client
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(&self.config.api_key)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp
                .text()
                .await
                .unwrap_or_else(|e| format!("<unreadable error body: {}>", e));
            bail!("OpenAI error {}: {}", status, text);
        }

        let json: Value = resp.json().await?;
        extract_content(&json)
    }
}

/// Extract the assistant message from a chat-completions payload.
/// Malformed payloads are explicit errors — they must never become
/// successful empty-string observations.
fn extract_content(json: &Value) -> Result<String> {
    json["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow::anyhow!("OpenAI response missing choices[0].message.content"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_extract_content_valid() {
        let v = json!({"choices": [{"message": {"content": "hello"}}]});
        assert_eq!(extract_content(&v).unwrap(), "hello");
    }

    #[test]
    fn test_extract_content_malformed_is_error() {
        // Empty object, wrong shapes, and non-string content must fail —
        // never collapse to an empty "successful" observation.
        for v in [
            json!({}),
            json!({"choices": []}),
            json!({"choices": [{"message": {}}]}),
            json!({"choices": [{"message": {"content": 42}}]}),
            json!({"error": {"message": "bad key"}}),
        ] {
            assert!(extract_content(&v).is_err(), "payload: {}", v);
        }
    }
}
