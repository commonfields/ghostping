use anyhow::Result;
use async_trait::async_trait;

/// Core abstraction for every LLM backend.
/// Implement `query_with_system`; `query` delegates to it with no system prompt.
// clippy >= 1.99 flags `#[must_use]` that `async_trait` emits on default
// method bodies (double_must_use). The attribute is macro-generated, so the
// lint is allowed here; `unknown_lints` keeps older toolchains warning-free.
#[allow(unknown_lints, clippy::double_must_use)]
#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn name(&self) -> &str;

    async fn query(&self, prompt: &str) -> Result<String> {
        self.query_with_system(None, prompt).await
    }

    async fn query_with_system(&self, system: Option<&str>, prompt: &str) -> Result<String>;
}
