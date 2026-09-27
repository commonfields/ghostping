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
        report.push_str(&self.generate_footer(&run, &summary));

        Ok(report)
    }

    fn generate_header(&self, run: &AuditRun, summary: &AuditSummary) -> String {
        let mock_notice = if summary.uses_mock_provider() {
            "\n> ⚠ TEST DATA — this audit used the mock provider. \
             Results are synthetic and must not be presented as real-world AI visibility.\n"
        } else {
            ""
        };
        let partial = if summary.failed_queries > 0 {
            format!(
                " (partial: {}/{} planned queries failed — see failure diagnostics)",
                summary.failed_queries, summary.planned_queries
            )
        } else {
            String::new()
        };
        format!(
            r#"# Ghostping Evidence Report

## {project_name}
{mock_notice}
**Audit Run**: {run_id}  
**Generated**: {timestamp}  
**Period**: {started}  
**Status**: {status}{partial}

**Coverage**: {successful}/{planned} planned queries succeeded{failed_note}

---

"#,
            project_name = self.project.project.name,
            mock_notice = mock_notice,
            run_id = run.id,
            timestamp = Utc::now().format("%Y-%m-%d %H:%M UTC"),
            started = run.started_at.split('T').next().unwrap_or("unknown"),
            status = run.status,
            partial = partial,
            successful = summary.successful_queries,
            planned = summary.planned_queries,
            failed_note = if summary.failed_queries > 0 {
                format!(" ({} failed)", summary.failed_queries)
            } else {
                String::new()
            },
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

Planned queries: {planned} — succeeded: {successful}, failed: {failed}.

### Mention Rate
Percentage of successful responses where **{name}** was explicitly mentioned.

- **Current**: {mention_rate:.1}%
- **Count**: {mention_count}/{total} successful responses

### Citation Rate
Percentage of successful responses containing at least one URL citation
for the project domain. Multiple citations in a single response count once
for the rate; every extracted URL is counted in the totals below.

- **Current**: {citation_rate:.1}%
- **Count**: {cited_responses}/{total} successful responses with a project citation
- **Total citations extracted**: {citations_total} ({citations_project} project-domain)

### Recommendation Rate
Percentage of successful responses where the project was actively recommended (not merely mentioned).

- **Current**: {recommendation_rate:.1}%
- **Count**: {recommendation_count}/{total} successful responses

"#,
            planned = summary.planned_queries,
            successful = summary.successful_queries,
            failed = summary.failed_queries,
            name = self.project.project.name,
            mention_rate = summary.mention_rate * 100.0,
            mention_count = summary.mention_count,
            total = summary.total_queries,
            citation_rate = summary.citation_rate * 100.0,
            cited_responses = summary.citation_response_count,
            citations_total = summary.citation_count,
            citations_project = summary.project_citation_count,
            recommendation_rate = summary.recommendation_rate * 100.0,
            recommendation_count = summary.recommendation_count,
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

    fn generate_footer(&self, run: &AuditRun, summary: &AuditSummary) -> String {
        let mock_caveat = if summary.uses_mock_provider() {
            "- THIS REPORT IS TEST DATA: the mock provider returns synthetic responses. \
             Do not present these metrics as real-world AI visibility.\n"
        } else {
            ""
        };
        let partial_caveat = if summary.failed_queries > 0 {
            format!(
                "- PARTIAL RESULTS: {}/{} planned queries failed. \
                 Metrics cover successful responses only.\n",
                summary.failed_queries, summary.planned_queries
            )
        } else {
            String::new()
        };
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
{mock_caveat}{partial_caveat}

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
            mock_caveat = mock_caveat,
            partial_caveat = partial_caveat,
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
        crate::types::truncate_chars(s, max)
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

    fn metric_summary() -> AuditSummary {
        AuditSummary {
            total_queries: 10,
            mention_count: 6,
            recommendation_count: 2,
            citation_count: 9,
            mention_rate: 0.6,
            recommendation_rate: 0.2,
            citation_rate: 0.4,
            models_used: vec!["openai:gpt-4o-mini".to_string()],
            planned_queries: 10,
            successful_queries: 10,
            failed_queries: 0,
            citation_response_count: 4,
            project_citation_count: 7,
        }
    }

    fn metric_generator() -> ReportGenerator {
        let project = ProjectConfig::default();
        let storage = AuditStorage::open(&std::path::PathBuf::from(":memory:")).unwrap();
        ReportGenerator::new(project, storage)
    }

    #[test]
    fn test_detailed_metrics_use_each_metric_own_values() {
        // Regression test: citation and recommendation sections previously
        // reused the mention-rate variables.
        let generator = metric_generator();
        let metrics = generator.generate_metrics(&metric_summary());

        assert!(metrics.contains("- **Current**: 60.0%"), "mention rate");
        assert!(
            metrics.contains("- **Count**: 6/10 successful responses"),
            "mention count"
        );
        assert!(metrics.contains("- **Current**: 40.0%"), "citation rate");
        assert!(
            metrics.contains("- **Count**: 4/10 successful responses with a project citation"),
            "citation count, got:\n{metrics}"
        );
        assert!(metrics.contains("- **Total citations extracted**: 9 (7 project-domain)"));
        assert!(
            metrics.contains("- **Current**: 20.0%"),
            "recommendation rate"
        );
        assert!(
            metrics.contains("- **Count**: 2/10 successful responses"),
            "recommendation count"
        );
    }

    #[test]
    fn test_mock_runs_are_labeled_test_data() {
        let generator = metric_generator();
        let mut summary = metric_summary();
        summary.models_used = vec!["mock:mock".to_string()];

        let run = AuditRun {
            id: 1,
            project_id: "example.com".to_string(),
            started_at: "2026-01-01T00:00:00+00:00".to_string(),
            completed_at: None,
            status: "completed".to_string(),
            provider_models_json: "[\"mock\"]".to_string(),
            samples_per_prompt: 1,
            temperature: 0.2,
            summary_json: None,
        };

        let header = generator.generate_header(&run, &summary);
        assert!(
            header.contains("TEST DATA"),
            "header must flag mock, got:\n{header}"
        );
        let footer = generator.generate_footer(&run, &summary);
        assert!(footer.contains("TEST DATA"), "footer must flag mock");

        // Non-mock runs must not carry the banner.
        let real_header = generator.generate_header(&run, &metric_summary());
        assert!(!real_header.contains("TEST DATA"));
    }

    #[test]
    fn test_partial_runs_show_failure_coverage() {
        let generator = metric_generator();
        let mut summary = metric_summary();
        summary.failed_queries = 3;
        summary.planned_queries = 13;
        summary.successful_queries = 10;

        let run = AuditRun {
            id: 2,
            project_id: "example.com".to_string(),
            started_at: "2026-01-01T00:00:00+00:00".to_string(),
            completed_at: None,
            status: "completed_with_errors".to_string(),
            provider_models_json: "[\"openai\"]".to_string(),
            samples_per_prompt: 1,
            temperature: 0.2,
            summary_json: None,
        };

        let header = generator.generate_header(&run, &summary);
        assert!(
            header.contains("10/13 planned queries succeeded"),
            "got:\n{header}"
        );
        let footer = generator.generate_footer(&run, &summary);
        assert!(footer.contains("PARTIAL RESULTS"));
    }
}
