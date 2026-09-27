use anyhow::Result;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

use crate::providers::LlmProvider;

/// A mock provider for testing that returns pre-configured responses
pub struct MockProvider {
    name: String,
    responses: Mutex<HashMap<String, Vec<String>>>,
    default_response: String,
}

impl MockProvider {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            responses: Mutex::new(HashMap::new()),
            default_response: "MOCK TEST DATA — This is a synthetic mock response for workflow validation only. It is not a real AI model output.".to_string(),
        }
    }

    /// Configure a response for a specific prompt pattern
    pub fn with_response(self, pattern: impl Into<String>, response: impl Into<String>) -> Self {
        let pattern = pattern.into();
        let response = response.into();
        let mut responses = self.responses.lock().unwrap();
        responses.entry(pattern).or_default().push(response);
        drop(responses);
        self
    }

    /// Configure multiple responses for a pattern (for sampling)
    pub fn with_responses(self, pattern: impl Into<String>, responses: Vec<String>) -> Self {
        let pattern = pattern.into();
        let mut map = self.responses.lock().unwrap();
        map.insert(pattern, responses);
        drop(map);
        self
    }

    /// Set the default response for unmatched prompts
    pub fn with_default_response(mut self, response: impl Into<String>) -> Self {
        self.default_response = response.into();
        self
    }

    fn find_response(&self, prompt: &str) -> String {
        let responses = self.responses.lock().unwrap();

        // Try exact match first
        if let Some(resp) = responses.get(prompt) {
            return resp
                .first()
                .cloned()
                .unwrap_or_else(|| self.default_response.clone());
        }

        // Try substring match
        for (pattern, resp) in responses.iter() {
            if prompt.to_lowercase().contains(&pattern.to_lowercase()) {
                return resp
                    .first()
                    .cloned()
                    .unwrap_or_else(|| self.default_response.clone());
            }
        }

        self.default_response.clone()
    }
}

#[async_trait]
impl LlmProvider for MockProvider {
    fn name(&self) -> &str {
        &self.name
    }

    async fn query_with_system(&self, _system: Option<&str>, prompt: &str) -> Result<String> {
        Ok(self.find_response(prompt))
    }
}

/// Builder for creating mock providers with complex response patterns
pub struct MockProviderBuilder {
    provider: MockProvider,
}

impl MockProviderBuilder {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            provider: MockProvider::new(name),
        }
    }

    /// Add a response that mentions a specific project
    pub fn mentions_project(mut self, project: &str) -> Self {
        let response = format!(
            "{} is a great tool that many developers recommend. \
             It has excellent features and is widely used in the industry. \
             You can learn more at https://{}. \
             I would definitely recommend using {} for your project.",
            project, project, project
        );
        self.provider = self
            .provider
            .with_response(project.to_lowercase(), response);
        self
    }

    /// Add a response that doesn't mention the project
    pub fn does_not_mention(self, project: &str) -> Self {
        let response = "For that use case, you might want to consider OtherTool or AnotherOption. \
             They are well-established solutions with good community support."
            .to_string();
        self.with_response(project, response)
    }

    /// Add a response with varied responses for sampling
    pub fn with_varied_responses(
        mut self,
        pattern: &str,
        mention_count: usize,
        total_samples: usize,
    ) -> Self {
        let mut responses = Vec::new();

        for i in 0..total_samples {
            let response = if i < mention_count {
                format!(
                    "Sample {} mentions the project: ProjectName is excellent \
                     and highly recommended for this use case.",
                    i + 1
                )
            } else {
                format!(
                    "Sample {} does not mention the project. \
                     Consider using OtherTool instead.",
                    i + 1
                )
            };
            responses.push(response);
        }

        self.provider = self.provider.with_responses(pattern.to_string(), responses);
        self
    }

    pub fn with_response(
        mut self,
        pattern: impl Into<String>,
        response: impl Into<String>,
    ) -> Self {
        self.provider = self.provider.with_response(pattern, response);
        self
    }

    pub fn with_default_response(mut self, response: impl Into<String>) -> Self {
        self.provider = self.provider.with_default_response(response);
        self
    }

    pub fn build(self) -> MockProvider {
        self.provider
    }
}

/// Pre-configured mock providers for common test scenarios
pub mod presets {
    use super::*;

    /// Creates a mock that always mentions the project
    pub fn always_mentions(project: &str) -> MockProvider {
        MockProviderBuilder::new("mock:always-mentions")
            .mentions_project(project)
            .build()
    }

    /// Creates a mock that never mentions the project
    pub fn never_mentions(project: &str) -> MockProvider {
        MockProviderBuilder::new("mock:never-mentions")
            .does_not_mention(project)
            .build()
    }

    /// Creates a mock with 50% mention rate
    pub fn mixed_mentions(project: &str) -> MockProvider {
        MockProviderBuilder::new("mock:mixed")
            .with_varied_responses(project, 3, 6)
            .build()
    }

    /// Creates a mock that simulates competitor mentions
    pub fn competitor_focus(project: &str, competitors: &[&str]) -> MockProvider {
        let competitor_list = competitors.join(", ");
        let response = format!(
            "For this use case, the most popular options are: {}. \
             {} is not commonly mentioned in this context.",
            competitor_list, project
        );
        MockProviderBuilder::new("mock:competitor-focus")
            .with_response(project, response)
            .build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_mock_provider_basic() {
        let provider = MockProviderBuilder::new("test")
            .with_response("hello", "world")
            .build();

        let response = provider.query("hello").await.unwrap();
        assert_eq!(response, "world");
    }

    #[tokio::test]
    async fn test_mock_provider_default() {
        let provider = MockProviderBuilder::new("test")
            .with_default_response("default response")
            .build();

        let response = provider.query("unknown prompt").await.unwrap();
        assert_eq!(response, "default response");
    }

    #[tokio::test]
    async fn test_mock_provider_mentions() {
        let provider = MockProviderBuilder::new("test")
            .mentions_project("myproject")
            .build();

        let response = provider.query("what is myproject").await.unwrap();
        assert!(response.contains("myproject"));
        assert!(response.contains("recommend"));
    }
}
