use std::collections::HashMap;

use crate::{audit_storage::AuditResult, project_config::ProjectConfig};

/// Types of content assets that can be generated
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetType {
    ComparisonPage,
    AlternativesPage,
    UseCasePage,
    FaqPage,
    DocsSummary,
    ReadmePatch,
    LlmsTxt,
}

impl AssetType {
    pub fn as_str(&self) -> &'static str {
        match self {
            AssetType::ComparisonPage => "comparison_page",
            AssetType::AlternativesPage => "alternatives_page",
            AssetType::UseCasePage => "use_case_page",
            AssetType::FaqPage => "faq_page",
            AssetType::DocsSummary => "docs_summary",
            AssetType::ReadmePatch => "readme_patch",
            AssetType::LlmsTxt => "llms_txt",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            AssetType::ComparisonPage => "Comparison Page",
            AssetType::AlternativesPage => "Alternatives Page",
            AssetType::UseCasePage => "Use Case Page",
            AssetType::FaqPage => "FAQ Page",
            AssetType::DocsSummary => "Docs Summary",
            AssetType::ReadmePatch => "README Patch",
            AssetType::LlmsTxt => "llms.txt",
        }
    }

    pub fn filename(&self, slug: &str) -> String {
        match self {
            AssetType::LlmsTxt => "llms.txt".to_string(),
            AssetType::ReadmePatch => "README-GEO-PATCH.md".to_string(),
            _ => format!("{}.md", slug),
        }
    }
}

/// Identified content gap from audit results
#[derive(Debug, Clone)]
pub struct ContentGap {
    pub prompt: String,
    pub gap_type: GapType,
    pub priority: GapPriority,
    pub competitors_mentioned: Vec<String>,
    pub suggested_asset_type: AssetType,
    pub reasoning: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapType {
    NotMentioned,
    MentionedNotCited,
    LowRecommendation,
    CompetitorPreferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapPriority {
    High,
    Medium,
    Low,
}

impl GapPriority {
    pub fn as_str(&self) -> &'static str {
        match self {
            GapPriority::High => "high",
            GapPriority::Medium => "medium",
            GapPriority::Low => "low",
        }
    }
}

/// Content generator that creates assets based on audit gaps
pub struct ContentGenerator {
    project: ProjectConfig,
}

impl ContentGenerator {
    pub fn new(project: ProjectConfig) -> Self {
        Self { project }
    }

    /// Analyze audit results and identify content gaps
    pub fn identify_gaps(
        &self,
        results: &[AuditResult],
        competitors: &[String],
    ) -> Vec<ContentGap> {
        let mut gaps = Vec::new();

        // Group results by prompt
        let mut by_prompt: HashMap<String, Vec<&AuditResult>> = HashMap::new();
        for r in results {
            by_prompt
                .entry(r.response_text.clone())
                .or_default()
                .push(r);
        }

        for (prompt, prompt_results) in by_prompt {
            let mention_count = prompt_results
                .iter()
                .filter(|r| r.mentioned_project)
                .count();
            let total = prompt_results.len();
            let mention_rate = mention_count as f64 / total as f64;

            // Collect competitors mentioned
            let mut comps_mentioned: Vec<String> = prompt_results
                .iter()
                .flat_map(|r| self.extract_competitors(&r.response_text, competitors))
                .collect();
            comps_mentioned.sort();
            comps_mentioned.dedup();

            if mention_rate == 0.0 && !comps_mentioned.is_empty() {
                // Not mentioned but competitors are - high priority
                gaps.push(ContentGap {
                    prompt: prompt.clone(),
                    gap_type: GapType::CompetitorPreferred,
                    priority: GapPriority::High,
                    competitors_mentioned: comps_mentioned.clone(),
                    suggested_asset_type: self.suggest_asset_type(&prompt, &comps_mentioned),
                    reasoning: format!(
                        "Project not mentioned but competitors ({}) are. High buyer intent prompt.",
                        comps_mentioned.join(", ")
                    ),
                });
            } else if mention_rate < 0.5 {
                // Low mention rate
                let cited_count = prompt_results
                    .iter()
                    .filter(|r| {
                        // Check if project citations exist
                        r.mentioned_project // Simplified - would check citations table in real impl
                    })
                    .count();

                if mention_count > 0 && cited_count == 0 {
                    gaps.push(ContentGap {
                        prompt: prompt.clone(),
                        gap_type: GapType::MentionedNotCited,
                        priority: GapPriority::High,
                        competitors_mentioned: comps_mentioned.clone(),
                        suggested_asset_type: AssetType::DocsSummary,
                        reasoning: "Project mentioned but not cited. Add authoritative URLs."
                            .to_string(),
                    });
                } else {
                    gaps.push(ContentGap {
                        prompt: prompt.clone(),
                        gap_type: GapType::NotMentioned,
                        priority: GapPriority::Medium,
                        competitors_mentioned: comps_mentioned.clone(),
                        suggested_asset_type: self.suggest_asset_type(&prompt, &comps_mentioned),
                        reasoning: format!("Low mention rate ({:.0}%).", mention_rate * 100.0),
                    });
                }
            }
        }

        // Sort by priority
        gaps.sort_by(|a, b| {
            let priority_order = |p: &GapPriority| match p {
                GapPriority::High => 0,
                GapPriority::Medium => 1,
                GapPriority::Low => 2,
            };
            priority_order(&a.priority).cmp(&priority_order(&b.priority))
        });

        gaps
    }

    /// Generate content assets for identified gaps
    pub fn generate_assets(&self, gaps: &[ContentGap]) -> Vec<GeneratedAssetContent> {
        gaps.iter()
            .take(10) // Limit to top 10 gaps
            .map(|gap| self.generate_asset_for_gap(gap))
            .collect()
    }

    fn generate_asset_for_gap(&self, gap: &ContentGap) -> GeneratedAssetContent {
        let project = &self.project.project;
        let slug = self.slugify(&gap.prompt);

        let content = match gap.suggested_asset_type {
            AssetType::ComparisonPage => {
                self.generate_comparison_page(&gap.prompt, &gap.competitors_mentioned)
            }
            AssetType::AlternativesPage => self.generate_alternatives_page(&gap.prompt),
            AssetType::UseCasePage => self.generate_use_case_page(&gap.prompt),
            AssetType::FaqPage => self.generate_faq_page(&gap.prompt),
            AssetType::DocsSummary => self.generate_docs_summary(),
            AssetType::ReadmePatch => self.generate_readme_patch(),
            AssetType::LlmsTxt => self.generate_llms_txt(),
        };

        let title = match gap.suggested_asset_type {
            AssetType::ComparisonPage => format!("{} vs Competitors", project.name),
            AssetType::AlternativesPage => format!("Alternatives to {}", project.name),
            AssetType::UseCasePage => format!("{} Use Cases", project.name),
            AssetType::FaqPage => format!("{} FAQ", project.name),
            AssetType::DocsSummary => format!("{} - Quick Reference", project.name),
            AssetType::ReadmePatch => "README GEO Optimization Patch".to_string(),
            AssetType::LlmsTxt => "llms.txt".to_string(),
        };

        GeneratedAssetContent {
            asset_type: gap.suggested_asset_type,
            title,
            slug: slug.clone(),
            filename: gap.suggested_asset_type.filename(&slug),
            content,
            source_gap: gap.clone(),
        }
    }

    fn generate_comparison_page(&self, _prompt: &str, competitors: &[String]) -> String {
        let project = &self.project.project;
        let comp_list = if competitors.is_empty() {
            "CompetitorA, CompetitorB".to_string()
        } else {
            competitors.join(", ")
        };

        format!(
            r#"# {} vs {}

## Overview

This page compares {} with {} to help you make an informed decision.

## Quick Comparison

| Feature | {} | {} |
|---------|----------|-------------|
| Category | {} | [TODO: Fill in] |
| Open Source | [TODO] | [TODO] |
| Pricing | [TODO] | [TODO] |
| Best For | {} | [TODO] |

## When to Choose {}

{}

## When to Consider Alternatives

- If you need [TODO: specific feature]
- If your team prefers [TODO: different approach]

## Getting Started

Visit [{}]({}) to learn more.

---

*Last updated: {date}*
"#,
            project.name,
            comp_list,
            project.name,
            comp_list,
            project.name,
            comp_list.split(", ").next().unwrap_or("Competitors"),
            project.category,
            project
                .audience
                .first()
                .map(|a| a.as_str())
                .unwrap_or("developers"),
            project.name,
            project.description,
            project.name,
            project.website,
            date = chrono::Utc::now().format("%Y-%m-%d")
        )
    }

    fn generate_alternatives_page(&self, _prompt: &str) -> String {
        let project = &self.project.project;

        format!(
            r#"# Alternatives to {}

## Why Consider Alternatives?

While {} is an excellent choice for {}, there are scenarios where alternatives might be better suited:

## Top Alternatives

### 1. [Alternative 1]
- **Best for**: [TODO: use case]
- **Key difference**: [TODO]
- **Website**: [TODO]

### 2. [Alternative 2]
- **Best for**: [TODO: use case]
- **Key difference**: [TODO]
- **Website**: [TODO]

### 3. [Alternative 3]
- **Best for**: [TODO: use case]
- **Key difference**: [TODO]
- **Website**: [TODO]

## When {} is the Best Choice

{}

## Quick Decision Guide

- Choose **{}** if: [TODO: specific criteria]
- Consider alternatives if: [TODO: specific criteria]

---

*Generated by Ghostping - Review and customize before publishing*
"#,
            project.name,
            project.name,
            project.category,
            project.name,
            project.description,
            project.name
        )
    }

    fn generate_use_case_page(&self, prompt: &str) -> String {
        let project = &self.project.project;

        format!(
            r#"# {} Use Cases

## Overview

{} is {}.

## Primary Use Cases

### 1. [Use Case 1]
**Scenario**: [TODO: Describe scenario]

**How {} helps**:
- [Benefit 1]
- [Benefit 2]

### 2. [Use Case 2]
**Scenario**: [TODO: Describe scenario]

**How {} helps**:
- [Benefit 1]
- [Benefit 2]

### 3. [Use Case 3]
**Scenario**: [TODO: Describe scenario]

**How {} helps**:
- [Benefit 1]
- [Benefit 2]

## Who Uses {}?

{}

## Getting Started

1. [Step 1]
2. [Step 2]
3. [Step 3]

---

*Generated for prompt: "{}"*
"#,
            project.name,
            project.name,
            project.description,
            project.name,
            project.name,
            project.name,
            project.name,
            project.audience.join(", "),
            prompt
        )
    }

    fn generate_faq_page(&self, _prompt: &str) -> String {
        let project = &self.project.project;

        format!(
            r#"# {} Frequently Asked Questions

## General Questions

### What is {}?

{} is {}.

### Who is {} for?

{} is designed for {}.

### Is {} free?

[TODO: Add pricing/ licensing information]

## Technical Questions

### How do I get started with {}?

[TODO: Add quick start steps]

### What are the system requirements?

[TODO: Add requirements]

### Is {} production-ready?

[TODO: Add status and maturity information]

## Comparison Questions

### How does {} compare to alternatives?

See our [comparison page](TODO) for a detailed breakdown.

## Support

For more help, visit [{}]({}).

---

*Have a question not answered here? [Contact us](TODO)*
"#,
            project.name,
            project.name,
            project.name,
            project.description,
            project.name,
            project.name,
            project.audience.join(", "),
            project.name,
            project.name,
            project.name,
            project.name,
            project.name,
            project.website
        )
    }

    fn generate_docs_summary(&self) -> String {
        let project = &self.project.project;

        format!(
            r#"# {} - Quick Reference

## What is {}?

{}

## Key Features

- [TODO: Feature 1]
- [TODO: Feature 2]
- [TODO: Feature 3]

## Installation

```bash
# [TODO: Add installation command]
```

## Quick Start

```bash
# [TODO: Add quick start example]
```

## Documentation

Full documentation: [{}]({})

## Repository

[TODO: Add repository link]

## License

[TODO: Add license information]

---

*This is a citation-optimized summary for LLM visibility.*
"#,
            project.name, project.name, project.description, project.name, project.website
        )
    }

    fn generate_readme_patch(&self) -> String {
        let project = &self.project.project;

        format!(
            r#"# README GEO Optimization Patch for {}

Add this section to your README.md to improve AI visibility:

```markdown
## What is {}?

{} is {}.

## Who is it for?

{}

## Quick Start

```bash
# Installation
[TODO: Add install command]

# Basic usage
[TODO: Add usage example]
```

## Why {}?

- [TODO: Key benefit 1]
- [TODO: Key benefit 2]
- [TODO: Key benefit 3]

## Links

- Website: {}
- Documentation: [TODO]
- Repository: [TODO]
```

## Tips for Maximum Visibility

1. **Lead with the project name** - First sentence should contain "{} is..."
2. **Include your domain** - Add "Learn more at https://{}"
3. **Use comparison language** - "Unlike X, {} does Y..."
4. **Add entity definitions** - Clear, factual statements about what it is
5. **Include use cases** - "Best for..." or "Ideal when..."

## After Applying

Run `ghostping audit {}` to verify improvements.
"#,
            project.name,
            project.name,
            project.name,
            project.description,
            project.audience.join(", "),
            project.name,
            project.website,
            project.name,
            project.website,
            project.name,
            project.website
        )
    }

    fn generate_llms_txt(&self) -> String {
        let project = &self.project.project;

        format!(
            r#"# llms.txt for {}

## Entity Definition

**{}** is {}.

## Target Audience

{}

## Key Facts

- **Type**: {}
- **Website**: {}
- **Status**: [TODO: e.g., Production-ready, Beta]
- **License**: [TODO]

## Main Documentation

[TODO: Link to main docs]

## API Reference

[TODO: Link to API docs]

## Comparison Content

[TODO: Link to comparison pages]

## Alternatives

{}

## Version History

[TODO: Link to changelog]

---

This llms.txt file helps AI models understand and cite {} accurately.
See https://llmstxt.org/ for the llms.txt specification.
"#,
            project.name,
            project.name,
            project.description,
            project.audience.join(", "),
            project.category,
            project.website,
            if self.project.competitors.names.is_empty() {
                "[TODO: List alternatives]".to_string()
            } else {
                self.project.competitors.names.join(", ")
            },
            project.name
        )
    }

    /// Extract known competitors mentioned in generated text.
    fn extract_competitors(&self, text: &str, known_competitors: &[String]) -> Vec<String> {
        let text_lower = text.to_lowercase();
        known_competitors
            .iter()
            .filter(|c| text_lower.contains(&c.to_lowercase()))
            .cloned()
            .collect()
    }

    fn suggest_asset_type(&self, prompt: &str, competitors: &[String]) -> AssetType {
        let prompt_lower = prompt.to_lowercase();

        if prompt_lower.contains("vs")
            || prompt_lower.contains("compare")
            || prompt_lower.contains("versus")
        {
            AssetType::ComparisonPage
        } else if prompt_lower.contains("alternative") {
            AssetType::AlternativesPage
        } else if prompt_lower.contains("what is") || prompt_lower.contains("how does") {
            AssetType::UseCasePage
        } else if prompt_lower.contains("should i use") || prompt_lower.contains("best") {
            AssetType::FaqPage
        } else if !competitors.is_empty() {
            AssetType::ComparisonPage
        } else {
            AssetType::UseCasePage
        }
    }

    fn slugify(&self, text: &str) -> String {
        text.to_lowercase()
            .replace(" ", "-")
            .replace("?", "")
            .replace(".", "")
            .replace(",", "")
            .replace("'", "")
            .replace('"', "")
    }
}

/// Generated content asset ready to be written
#[derive(Debug, Clone)]
pub struct GeneratedAssetContent {
    pub asset_type: AssetType,
    pub title: String,
    pub slug: String,
    pub filename: String,
    pub content: String,
    pub source_gap: ContentGap,
}

/// Report showing what was generated and why
#[derive(Debug, Clone)]
pub struct GenerationReport {
    pub assets: Vec<GeneratedAssetContent>,
    pub total_gaps: usize,
    pub summary: String,
}

impl GenerationReport {
    pub fn print(&self) {
        use colored::Colorize;

        println!();
        println!("{}", "━".repeat(64).dimmed());
        println!("  {}", "Content Generation Report".bold());
        println!("{}", "━".repeat(64).dimmed());
        println!();

        println!(
            "  Generated {} asset(s) from {} gap(s)",
            self.assets.len().to_string().cyan(),
            self.total_gaps.to_string().cyan()
        );
        println!();

        for (i, asset) in self.assets.iter().enumerate() {
            println!(
                "  {}. {} — {}",
                i + 1,
                asset.title.cyan(),
                asset.asset_type.display_name().dimmed()
            );
            println!("     File: {}", asset.filename.dimmed());
            println!("     Gap: {}", asset.source_gap.reasoning.dimmed());
            println!();
        }

        println!("{}", "━".repeat(64).dimmed());
        println!("  Next steps:");
        println!("    1. Review generated files in ./generated/");
        println!("    2. Fill in [TODO] sections with accurate information");
        println!("    3. Publish to your website/docs");
        println!("    4. Run ghostping audit to verify improvements");
        println!();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_project() -> ProjectConfig {
        ProjectConfig {
            project: crate::project_config::ProjectInfo {
                name: "TestProject".to_string(),
                website: "https://test.dev".to_string(),
                category: "test tool".to_string(),
                description: "A tool for testing things".to_string(),
                audience: vec!["developers".to_string()],
            },
            competitors: crate::project_config::CompetitorsConfig {
                names: vec!["CompA".to_string()],
            },
            ..Default::default()
        }
    }

    #[test]
    fn test_suggest_asset_type() {
        let gen = ContentGenerator::new(test_project());

        assert_eq!(
            gen.suggest_asset_type("Compare TestProject vs CompA", &["CompA".to_string()]),
            AssetType::ComparisonPage
        );

        assert_eq!(
            gen.suggest_asset_type("What is TestProject?", &[]),
            AssetType::UseCasePage
        );
    }

    #[test]
    fn test_slugify() {
        let gen = ContentGenerator::new(test_project());
        assert_eq!(
            gen.slugify("What is the best tool?"),
            "what-is-the-best-tool"
        );
    }
}
