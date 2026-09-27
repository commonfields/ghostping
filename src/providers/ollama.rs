use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};

use super::LlmProvider;
use crate::config::OllamaConfig;

pub struct OllamaProvider {
    client: Client,
    config: OllamaConfig,
}

impl OllamaProvider {
    pub fn new(config: OllamaConfig) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            config,
        }
    }
}

#[async_trait]
impl LlmProvider for OllamaProvider {
    fn name(&self) -> &str {
        "ollama"
    }

    async fn query_with_system(&self, system: Option<&str>, prompt: &str) -> Result<String> {
        let url = format!("{}/api/chat", self.config.base_url);
        let mut messages = vec![];
        if let Some(sys) = system {
            messages.push(json!({"role": "system", "content": sys}));
        }
        messages.push(json!({"role": "user", "content": prompt}));

        let body = json!({
            "model": self.config.model,
            "stream": false,
            "options": { "temperature": self.config.temperature },
            "messages": messages
        });

        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .with_context(|| {
                format!(
                    "Ollama not reachable at {} — is it running? Try: ollama serve",
                    self.config.base_url
                )
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp
                .text()
                .await
                .unwrap_or_else(|e| format!("<unreadable error body: {}>", e));
            bail!("Ollama error {}: {}", status, text);
        }

        let json: Value = resp.json().await?;
        extract_content(&json)
    }
}

/// Extract the reply text from a `/api/chat` payload.
/// Malformed payloads are explicit errors — they must never become
/// successful empty-string observations.
fn extract_content(json: &Value) -> Result<String> {
    json["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow::anyhow!("Ollama response missing message.content"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_extract_content_valid() {
        let v = json!({"message": {"content": "hello"}});
        assert_eq!(extract_content(&v).unwrap(), "hello");
    }

    #[test]
    fn test_extract_content_malformed_is_error() {
        for v in [
            json!({}),
            json!({"message": {}}),
            json!({"message": {"content": 3}}),
            json!({"error": "model not found"}),
        ] {
            assert!(extract_content(&v).is_err(), "payload: {}", v);
        }
    }
}
