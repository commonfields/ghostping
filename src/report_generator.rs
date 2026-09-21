use anyhow::Result;
use chrono::Utc;
use std::path::PathBuf;

use crate::{
    audit_storage::{AuditResult, AuditRun, AuditStorage, AuditSummary},
    project_config::ProjectConfig,
};

/// Generate markdown reports from audit data
pub struct ReportGenerator {
    project: ProjectConfig,
    storage: AuditStorage,
}

impl ReportGenerator {
    pub fn new(project: ProjectConfig, storage: AuditStorage) -> Self {
        Self { project, storage }
    }

    /// Generate a markdown report for an audit run
    pub fn generate_markdown_report(
        &self,
        run_id: i64,
        include_full_responses: bool,
    ) -> Result<String> {
        let run = self
            .storage
            .get_audit_run(run_id)?
            .ok_or_else(|| anyhow::anyhow!("Audit run {} not found", run_id))?;

        let results = self.storage.get_audit_results(run_id)?;
        let summary = self.storage.get_audit_summary(run_id)?;

        let mut report = String::new();

        // Header
        report.push_str(&self.generate_header(&run, &summary));

        // Executive Summary
        report.push_str(&self.generate_executive_summary(&summary));

        // Metrics
        report.push_str(&self.generate_metrics(&summary));

        // Model Results
        report.push_str(&self.generate_model_breakdown(&results));

        // Prompt Results
        report.push_str(&self.generate_prompt_results(&results));

        // Competitor Analysis
        report.push_str(&self.generate_competitor_analysis(&results));

        // Citations
        report.push_str(&self.generate_citations(&results));

        // Content Gaps
        report.push_str(&self.generate_content_gaps(&results));

        // Raw Evidence Appendix
        if include_full_responses {
            report.push_str(&self.generate_raw_appendix(&results));
        }

        // Footer
        report.push_str(&self.generate_footer(&run));

        Ok(report)
    }

    fn generate_header(&self, run: &AuditRun, _summary: &AuditSummary) -> String {
        format!(
            r#"# Ghostping Evidence Report

## {project_name}

**Audit Run**: {run_id}  
**Generated**: {timestamp}  
**Period**: {started}  
**Status**: {status}

---

"#,
            project_name = self.project.project.name,
            run_id = run.id,
            timestamp = Utc::now().format("%Y-%m-%d %H:%M UTC"),
            started = run.started_at.split('T').next().unwrap_or("unknown"),
            status = run.status,
        )
    }

    fn generate_executive_summary(&self, summary: &AuditSummary) -> String {
        let visibility_score = summary.visibility_score();

        format!(
            r#"## Executive Summary

This report measures how often AI models mention, cite, and recommend **{name}** across a configured set of prompts and model samples.

| Metric | Value | Assessment |
|--------|-------|------------|
| Visibility Score | {score:.1}/100 | {assessment} |
| Mention Rate | {mention:.1}% | {mention_assess} |
| Citation Rate | {citation:.1}% | {citation_assess} |
| Recommendation Rate | {recommend:.1}% | {recommend_assess} |
| Total Queries | {total} | — |

**Models Tested**: {models}

"#,
            name = self.project.project.name,
            score = visibility_score,
            assessment = self.assess_visibility(visibility_score),
            mention = summary.mention_rate * 100.0,
            mention_assess = self.assess_rate(summary.mention_rate),
            citation = summary.citation_rate * 100.0,
            citation_assess = self.assess_rate(summary.citation_rate),
            recommend = summary.recommendation_rate * 100.0,
            recommend_assess = self.assess_rate(summary.recommendation_rate),
            total = summary.total_queries,
            models = summary.models_used.join(", "),
        )
    }

    fn generate_metrics(&self, summary: &AuditSummary) -> String {
        format!(
            r#"## Detailed Metrics

### Mention Rate
Percentage of responses where **{name}** was explicitly mentioned.

- **Current**: {rate:.1}%
- **Count**: {count}/{total} queries

### Citation Rate
Percentage of responses containing a URL citation related to the project.

- **Current**: {rate:.1}%
- **Count**: {count}/{total} queries

### Recommendation Rate
Percentage of responses where the project was actively recommended (not merely mentioned).

- **Current**: {rate:.1}%
- **Count**: {count}/{total} queries

"#,
            name = self.project.project.name,
            rate = summary.mention_rate * 100.0,
            count = summary.mention_count,
            total = summary.total_queries,
        )
    }

    fn generate_model_breakdown(&self, results: &[AuditResult]) -> String {
        let mut output = String::from("## Results by Model/Provider\n\n");
        output.push_str("| Model | Queries | Mentions | Rate | Recommendations |\n");
        output.push_str("|-------|---------|----------|------|-------------------|\n");

        // Group by provider
        let mut by_provider: std::collections::HashMap<String, Vec<&AuditResult>> =
            std::collections::HashMap::new();
        for r in results {
            by_provider.entry(r.provider.clone()).or_default().push(r);
        }

        for (provider, provider_results) in by_provider {
            let total = provider_results.len();
            let mentions = provider_results
                .iter()
                .filter(|r| r.mentioned_project)
                .count();
            let recommendations = provider_results
                .iter()
                .filter(|r| r.recommended_project)
                .count();
            let rate = if total > 0 {
                mentions as f64 / total as f64 * 100.0
            } else {
                0.0
            };

            output.push_str(&format!(
                "| {} | {} | {} | {:.1}% | {} |\n",
                provider, total, mentions, rate, recommendations
            ));
        }

        output.push('\n');
        output
    }

    fn generate_prompt_results(&self, results: &[AuditResult]) -> String {
        let mut output = String::from("## Prompt-Level Results\n\n");
        output.push_str("| Prompt | Provider | Mentioned | Recommended | Sentiment |\n");
        output.push_str("|--------|----------|-----------|-------------|-----------|\n");

        for r in results.iter().take(50) {
            output.push_str(&format!(
                "| {} | {} | {} | {} | {} |\n",
                self.truncate(&r.response_text, 40),
                r.provider,
                if r.mentioned_project { "✓" } else { "✗" },
                if r.recommended_project { "✓" } else { "✗" },
                r.sentiment
            ));
        }

        if results.len() > 50 {
            output.push_str(&format!(
                "\n*... and {} more results*\n",
                results.len() - 50
            ));
        }

        output.push('\n');
        output
    }

    fn generate_competitor_analysis(&self, results: &[AuditResult]) -> String {
        let mut output = String::from("## Competitor Mentions\n\n");

        // Extract competitor mentions from results
        let competitors = &self.project.competitors.names;
        if competitors.is_empty() {
            output.push_str("No competitors configured for tracking.\n\n");
            return output;
        }

        output.push_str("| Competitor | Times Mentioned | In Responses |\n");
        output.push_str("|------------|-----------------|---------------|\n");

        for competitor in competitors {
            let count = results
                .iter()
                .filter(|r| {
                    r.response_text
                        .to_lowercase()
                        .contains(&competitor.to_lowercase())
                })
                .count();

            let rate = if !results.is_empty() {
                count as f64 / results.len() as f64 * 100.0
            } else {
                0.0
            };

            output.push_str(&format!("| {} | {} | {:.1}% |\n", competitor, count, rate));
        }

        output.push('\n');
        output
    }

    fn generate_citations(&self, results: &[AuditResult]) -> String {
        let mut output = String::from("## Citations Found\n\n");

        let mut all_citations: Vec<(String, bool)> = Vec::new();
        for r in results {
            if let Ok(citations) = self.storage.get_citations_for_result(r.id) {
                for c in citations {
                    all_citations.push((c.url, c.is_project_domain));
                }
            }
        }

        if all_citations.is_empty() {
            output.push_str("No citations extracted from responses.\n\n");
        } else {
            output.push_str("| URL | Is Project Domain |\n");
            output.push_str("|-----|-------------------|\n");

            for (url, is_project) in all_citations.iter().take(20) {
                output.push_str(&format!(
                    "| {} | {} |\n",
                    url,
                    if *is_project { "✓" } else { "✗" }
                ));
            }

            if all_citations.len() > 20 {
                output.push_str(&format!(
                    "\n*... and {} more citations*\n",
                    all_citations.len() - 20
                ));
            }
        }

        output.push('\n');
        output
    }

    fn generate_content_gaps(&self, results: &[AuditResult]) -> String {
        let mut output = String::from("## Content Gaps & Recommendations\n\n");

        // Identify gaps
        let not_mentioned: Vec<&AuditResult> =
            results.iter().filter(|r| !r.mentioned_project).collect();

        if !not_mentioned.is_empty() {
            output.push_str(&format!(
                "### High Priority: Not Mentioned ({} responses)\n\n",
                not_mentioned.len()
            ));
            output.push_str("The project was not mentioned in these responses. Consider:\n");
            output.push_str("- Creating comparison pages with competitors\n");
            output.push_str("- Publishing use case documentation\n");
            output.push_str("- Adding an FAQ section to your website\n\n");
        }

        let not_recommended: Vec<&AuditResult> = results
            .iter()
            .filter(|r| r.mentioned_project && !r.recommended_project)
            .collect();

        if !not_recommended.is_empty() {
            output.push_str(&format!(
                "### Medium Priority: Mentioned but Not Recommended ({} responses)\n\n",
                not_recommended.len()
            ));
            output.push_str("The project was mentioned but not actively recommended. Consider:\n");
            output.push_str("- Improving documentation quality\n");
            output.push_str("- Adding clear value propositions\n");
            output.push_str("- Publishing case studies\n\n");
        }

        output.push_str("### Suggested Content Assets\n\n");
        output.push_str("Based on this audit, consider creating:\n\n");
        output.push_str("1. **Comparison Page** — Compare your project with top alternatives\n");
        output.push_str(
            "2. **Use Case Documentation** — Clear examples of when to use the project\n",
        );
        output.push_str(
            "3. **FAQ Page** — Answer common questions about features and alternatives\n",
        );
        output.push_str("4. **Getting Started Guide** — Step-by-step setup instructions\n");
        output.push_str("5. **llms.txt** — Help AI models understand your project\n\n");

        output
    }

    fn generate_raw_appendix(&self, results: &[AuditResult]) -> String {
        let mut output = String::from("## Raw Evidence Appendix\n\n");
        output.push_str("*Full responses from the audit run:*\n\n");

        for (i, r) in results.iter().enumerate() {
            output.push_str(&format!(
                "### Response {} — {} — Sample {}\n\n",
                i + 1,
                r.provider,
                r.sample_index + 1
            ));
            output.push_str("```\n");
            output.push_str(&r.response_text);
            output.push_str("\n```\n\n");
            output.push_str(&format!(
                "- **Mentioned**: {}\n",
                if r.mentioned_project { "Yes" } else { "No" }
            ));
            output.push_str(&format!(
                "- **Recommended**: {}\n",
                if r.recommended_project { "Yes" } else { "No" }
            ));
            output.push_str(&format!("- **Position**: {}\n", r.mention_position));
            output.push_str(&format!("- **Sentiment**: {}\n\n", r.sentiment));
        }

        output
    }

    fn generate_footer(&self, run: &AuditRun) -> String {
        format!(
            r#"---

## Methodology

This report was generated by Ghostping, a local-first GEO (Generative Engine Optimization) workbench.

**Important Caveats**:
- Results are based on {samples} sample(s) per prompt across configured models.
- AI model behavior is probabilistic and may vary between runs.
- These metrics measure visibility across the tested prompt set, not universal AI ranking.
- Model training data and behavior change over time.
- Publishing content is necessary but does not guarantee citations.

**Audit Configuration**:
- Samples per prompt: {samples}
- Temperature: {temp}
- Raw responses stored: {stored}

**Report Generated**: {timestamp}

---

_Generated by [Ghostping](https://github.com/commonfields/ghostping) — local-first AI visibility tooling_
"#,
            samples = run.samples_per_prompt,
            temp = run.temperature,
            stored = if run.summary_json.is_some() {
                "Yes"
            } else {
                "No"
            },
            timestamp = Utc::now().format("%Y-%m-%d %H:%M UTC"),
        )
    }

    fn assess_visibility(&self, score: f64) -> &'static str {
        match score as i64 {
            0..=20 => "⚠️ Critical — No visibility detected",
            21..=40 => "⚠️ Low — Limited visibility",
            41..=60 => "→ Moderate — Room for improvement",
            61..=80 => "✓ Good — Solid visibility",
            _ => "✓ Excellent — Strong visibility",
        }
    }

    fn assess_rate(&self, rate: f64) -> &'static str {
        match (rate * 100.0) as i64 {
            0..=20 => "⚠️ Low",
            21..=50 => "→ Moderate",
            51..=75 => "✓ Good",
            _ => "✓ Excellent",
        }
    }

    fn truncate(&self, s: &str, max: usize) -> String {
        if s.len() <= max {
            s.to_string()
        } else {
            format!("{}…", &s[..max.saturating_sub(1)])
        }
    }
}

/// Write a report to a file
pub fn write_report(content: &str, output_dir: &PathBuf, filename: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(output_dir)?;
    let path = output_dir.join(filename);
    std::fs::write(&path, content)?;
    Ok(path)
}

/// Generate filename with timestamp
pub fn generate_report_filename(project_name: &str, run_id: i64) -> String {
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    let safe_name = project_name.to_lowercase().replace(' ', "-");
    format!("{}_audit_{}_{}.md", safe_name, run_id, timestamp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_assess_visibility() {
        // Test with a simple project config
        let project = ProjectConfig::default();
        let storage = AuditStorage::open(&std::path::PathBuf::from(":memory:")).unwrap();
        let generator = ReportGenerator::new(project, storage);

        assert_eq!(
            generator.assess_visibility(10.0),
            "⚠️ Critical — No visibility detected"
        );
        assert_eq!(
            generator.assess_visibility(50.0),
            "→ Moderate — Room for improvement"
        );
        assert_eq!(
            generator.assess_visibility(90.0),
            "✓ Excellent — Strong visibility"
        );
    }

    #[test]
    fn test_generate_filename() {
        let filename = generate_report_filename("My Project", 42);
        assert!(filename.contains("my-project"));
        assert!(filename.contains("audit_42"));
        assert!(filename.ends_with(".md"));
    }
}
