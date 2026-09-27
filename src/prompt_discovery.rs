use crate::project_config::{ProjectConfig, ProjectInfo};

/// Categories of prompts for different intent stages
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PromptCategory {
    /// Category-level queries (e.g., "best tools for X")
    Category,
    /// Competitor alternative queries
    CompetitorAlternative,
    /// Problem-aware queries (user knows the problem but not the solution)
    ProblemAware,
    /// Solution-aware queries (user knows solutions exist)
    SolutionAware,
    /// Comparison queries
    Comparison,
    /// Buyer-intent queries
    BuyerIntent,
}

impl PromptCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            PromptCategory::Category => "category",
            PromptCategory::CompetitorAlternative => "competitor_alternative",
            PromptCategory::ProblemAware => "problem_aware",
            PromptCategory::SolutionAware => "solution_aware",
            PromptCategory::Comparison => "comparison",
            PromptCategory::BuyerIntent => "buyer_intent",
        }
    }

    pub fn funnel_stage(&self) -> &'static str {
        match self {
            PromptCategory::Category => "awareness",
            PromptCategory::ProblemAware => "problem_aware",
            PromptCategory::SolutionAware => "solution_aware",
            PromptCategory::Comparison => "consideration",
            PromptCategory::CompetitorAlternative => "consideration",
            PromptCategory::BuyerIntent => "decision",
        }
    }

    pub fn priority(&self) -> i64 {
        match self {
            PromptCategory::BuyerIntent => 1,
            PromptCategory::Comparison => 2,
            PromptCategory::CompetitorAlternative => 3,
            PromptCategory::SolutionAware => 4,
            PromptCategory::ProblemAware => 5,
            PromptCategory::Category => 6,
        }
    }
}

/// A discovered prompt with metadata
#[derive(Debug, Clone)]
pub struct DiscoveredPrompt {
    pub text: String,
    pub category: PromptCategory,
    pub intent: String,
    pub funnel_stage: String,
    pub priority: i64,
    pub expected_entity: String,
}

impl DiscoveredPrompt {
    pub fn new(text: impl Into<String>, category: PromptCategory, project: &ProjectInfo) -> Self {
        let text = text.into();
        Self {
            expected_entity: project.name.clone(),
            intent: format!("Find {} tools/solutions", category.as_str()),
            funnel_stage: category.funnel_stage().to_string(),
            priority: category.priority(),
            category,
            text,
        }
    }
}

/// Prompt discovery engine
pub struct PromptDiscovery;

impl PromptDiscovery {
    /// Discover prompts based on project configuration
    pub fn discover(project: &ProjectConfig) -> Vec<DiscoveredPrompt> {
        let mut prompts = Vec::new();
        let info = &project.project;

        // Generate prompts for each category
        prompts.extend(Self::category_prompts(info));
        prompts.extend(Self::competitor_alternative_prompts(
            info,
            &project.competitors.names,
        ));
        prompts.extend(Self::problem_aware_prompts(info));
        prompts.extend(Self::solution_aware_prompts(info));
        prompts.extend(Self::comparison_prompts(info, &project.competitors.names));
        prompts.extend(Self::buyer_intent_prompts(info));

        // Deduplicate
        Self::deduplicate(prompts)
    }

    fn category_prompts(info: &ProjectInfo) -> Vec<DiscoveredPrompt> {
        let mut prompts = Vec::new();

        if !info.category.is_empty() {
            prompts.push(DiscoveredPrompt::new(
                format!("What are the best {}?", info.category),
                PromptCategory::Category,
                info,
            ));

            prompts.push(DiscoveredPrompt::new(
                format!("Best {} 2026", info.category),
                PromptCategory::Category,
                info,
            ));

            for audience in &info.audience {
                prompts.push(DiscoveredPrompt::new(
                    format!("Best {} for {}", info.category, audience),
                    PromptCategory::Category,
                    info,
                ));
            }
        }

        // Use keywords/topics if available
        if info.category.contains("GEO") || info.category.contains("visibility") {
            prompts.push(DiscoveredPrompt::new(
                "What are the best GEO tools?".to_string(),
                PromptCategory::Category,
                info,
            ));
            prompts.push(DiscoveredPrompt::new(
                "What are the best AI visibility tools?".to_string(),
                PromptCategory::Category,
                info,
            ));
        }

        prompts
    }

    fn competitor_alternative_prompts(
        info: &ProjectInfo,
        competitors: &[String],
    ) -> Vec<DiscoveredPrompt> {
        let mut prompts = Vec::new();
        let project_name = &info.name;

        for competitor in competitors {
            prompts.push(DiscoveredPrompt::new(
                format!("What are alternatives to {}?", competitor),
                PromptCategory::CompetitorAlternative,
                info,
            ));

            prompts.push(DiscoveredPrompt::new(
                format!("{} vs {}", competitor, project_name),
                PromptCategory::CompetitorAlternative,
                info,
            ));

            prompts.push(DiscoveredPrompt::new(
                format!("Open source alternatives to {}", competitor),
                PromptCategory::CompetitorAlternative,
                info,
            ));
        }

        if competitors.is_empty() {
            // Generic alternatives if no competitors specified
            prompts.push(DiscoveredPrompt::new(
                format!("Alternatives to {}", project_name),
                PromptCategory::CompetitorAlternative,
                info,
            ));
        }

        prompts
    }

    fn problem_aware_prompts(info: &ProjectInfo) -> Vec<DiscoveredPrompt> {
        let mut prompts = Vec::new();
        let project_name = &info.name;

        prompts.push(DiscoveredPrompt::new(
            format!(
                "How can I track whether AI models mention {}?",
                project_name
            ),
            PromptCategory::ProblemAware,
            info,
        ));

        prompts.push(DiscoveredPrompt::new(
            format!("How do I know if ChatGPT recommends {}?", project_name),
            PromptCategory::ProblemAware,
            info,
        ));

        prompts.push(DiscoveredPrompt::new(
            "How to check if my startup is mentioned by AI".to_string(),
            PromptCategory::ProblemAware,
            info,
        ));

        prompts.push(DiscoveredPrompt::new(
            "Why isn't my product showing up in AI recommendations?".to_string(),
            PromptCategory::ProblemAware,
            info,
        ));

        prompts
    }

    fn solution_aware_prompts(info: &ProjectInfo) -> Vec<DiscoveredPrompt> {
        let mut prompts = Vec::new();
        let project_name = &info.name;

        prompts.push(DiscoveredPrompt::new(
            format!("What is {}?", project_name),
            PromptCategory::SolutionAware,
            info,
        ));

        prompts.push(DiscoveredPrompt::new(
            format!("How does {} work?", project_name),
            PromptCategory::SolutionAware,
            info,
        ));

        prompts.push(DiscoveredPrompt::new(
            project_name.to_string(),
            PromptCategory::SolutionAware,
            info,
        ));

        prompts.push(DiscoveredPrompt::new(
            format!("Getting started with {}", project_name),
            PromptCategory::SolutionAware,
            info,
        ));

        if !info.category.is_empty() {
            prompts.push(DiscoveredPrompt::new(
                format!("Tools that help with {}", info.category),
                PromptCategory::SolutionAware,
                info,
            ));
        }

        prompts
    }

    fn comparison_prompts(info: &ProjectInfo, competitors: &[String]) -> Vec<DiscoveredPrompt> {
        let mut prompts = Vec::new();
        let project_name = &info.name;

        if !info.category.is_empty() {
            prompts.push(DiscoveredPrompt::new(
                format!("Compare {} tools", info.category),
                PromptCategory::Comparison,
                info,
            ));

            for audience in &info.audience {
                prompts.push(DiscoveredPrompt::new(
                    format!("Compare {} tools for {}", info.category, audience),
                    PromptCategory::Comparison,
                    info,
                ));
            }
        }

        // Compare with competitors
        for competitor in competitors.iter().take(3) {
            prompts.push(DiscoveredPrompt::new(
                format!("{} vs {}", project_name, competitor),
                PromptCategory::Comparison,
                info,
            ));
        }

        prompts
    }

    fn buyer_intent_prompts(info: &ProjectInfo) -> Vec<DiscoveredPrompt> {
        let mut prompts = Vec::new();
        let project_name = &info.name;

        if !info.category.is_empty() {
            prompts.push(DiscoveredPrompt::new(
                format!("Which {} should I use?", info.category),
                PromptCategory::BuyerIntent,
                info,
            ));

            prompts.push(DiscoveredPrompt::new(
                format!("Best {} for production", info.category),
                PromptCategory::BuyerIntent,
                info,
            ));

            for audience in &info.audience {
                prompts.push(DiscoveredPrompt::new(
                    format!("Best {} for {}", info.category, audience),
                    PromptCategory::BuyerIntent,
                    info,
                ));
            }
        }

        prompts.push(DiscoveredPrompt::new(
            format!("Should I use {}?", project_name),
            PromptCategory::BuyerIntent,
            info,
        ));

        prompts.push(DiscoveredPrompt::new(
            format!("Is {} worth it?", project_name),
            PromptCategory::BuyerIntent,
            info,
        ));

        prompts.push(DiscoveredPrompt::new(
            format!("{} review", project_name),
            PromptCategory::BuyerIntent,
            info,
        ));

        prompts
    }

    fn deduplicate(prompts: Vec<DiscoveredPrompt>) -> Vec<DiscoveredPrompt> {
        let mut seen = std::collections::HashSet::new();
        let mut result = Vec::new();

        for prompt in prompts {
            let normalized = Self::normalize(&prompt.text);
            if !seen.contains(&normalized) && !normalized.is_empty() {
                seen.insert(normalized);
                result.push(prompt);
            }
        }

        result
    }

    fn normalize(text: &str) -> String {
        text.to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Template-based prompt generation for common patterns
pub struct PromptTemplates;

impl PromptTemplates {
    /// Generate prompts for a specific niche
    pub fn for_niche(niche: &str, brand: &str, competitors: &[String]) -> Vec<String> {
        let mut prompts = vec![
            format!("What is {}?", brand),
            format!("Best {} tools", niche),
            brand.to_string(),
            format!("{} vs alternatives", brand),
            format!("How does {} work?", brand),
            format!("Getting started with {}", brand),
            format!("{} tutorial", brand),
            format!("Is {} production ready?", brand),
            format!("{} review 2026", brand),
            format!("Should I use {}?", brand),
            format!("{} features", brand),
            format!("Alternatives to {}", brand),
        ];

        // Add competitor comparison prompts
        for competitor in competitors.iter().take(3) {
            prompts.push(format!("{} vs {}", brand, competitor));
            prompts.push(format!("{} alternative to {}", brand, competitor));
        }

        prompts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_project() -> ProjectConfig {
        ProjectConfig {
            project: ProjectInfo {
                name: "TestProject".to_string(),
                website: "https://test.dev".to_string(),
                category: "developer tool".to_string(),
                description: "A test project".to_string(),
                audience: vec!["developers".to_string(), "startups".to_string()],
            },
            competitors: crate::project_config::CompetitorsConfig {
                names: vec!["CompetitorA".to_string(), "CompetitorB".to_string()],
            },
            ..Default::default()
        }
    }

    #[test]
    fn test_discover_generates_prompts() {
        let project = test_project();
        let prompts = PromptDiscovery::discover(&project);

        assert!(!prompts.is_empty());

        // Should have prompts from different categories
        let categories: std::collections::HashSet<_> = prompts.iter().map(|p| p.category).collect();

        assert!(
            categories.len() >= 3,
            "Should have prompts from multiple categories"
        );

        // Should deduplicate
        let texts: Vec<_> = prompts.iter().map(|p| &p.text).collect();
        let unique_texts: std::collections::HashSet<_> = texts.iter().collect();
        assert_eq!(texts.len(), unique_texts.len(), "Should have no duplicates");
    }

    #[test]
    fn test_prompt_metadata() {
        let project = test_project();
        let prompts = PromptDiscovery::discover(&project);

        for prompt in &prompts {
            assert!(!prompt.text.is_empty());
            assert!(!prompt.expected_entity.is_empty());
            assert!(!prompt.funnel_stage.is_empty());
            assert!(prompt.priority > 0);
        }
    }

    #[test]
    fn test_buyer_intent_highest_priority() {
        assert!(PromptCategory::BuyerIntent.priority() < PromptCategory::Category.priority());
    }
}
