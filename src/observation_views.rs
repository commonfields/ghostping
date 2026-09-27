//! Read-time views over kernel observations.
//!
//! Invariant: derived numbers are computed here from immutable observations,
//! never stored. First-party aggregates and sampled impressions keep
//! separate denominators and are never pooled into one rate.

use crate::observations::{ObservationEnvelope, ObservationType};

/// Aggregate view over `search_console_aggregate` observations.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GscSummary {
    pub row_count: usize,
    pub total_clicks: i64,
    pub total_impressions: i64,
    /// Overall CTR = clicks / impressions; `None` with zero impressions.
    pub overall_ctr: Option<f64>,
    /// Rows lacking a position value (unavailable stays unavailable).
    pub rows_without_position: usize,
}

/// Aggregate view over sampled evidence (evidence-engine audit summaries).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SampledSummary {
    pub runs: usize,
    pub planned: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub mentions: usize,
    pub recommendations: usize,
    pub cited_responses: usize,
    pub total_citations: usize,
    pub project_citations: usize,
    /// Mention rate over succeeded responses; `None` with zero successes.
    pub mention_rate: Option<f64>,
    /// Project-citation response rate; `None` with zero successes.
    pub citation_response_rate: Option<f64>,
}

fn payload_i64(env: &ObservationEnvelope, key: &str) -> i64 {
    env.payload.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn payload_f64(env: &ObservationEnvelope, key: &str) -> Option<f64> {
    env.payload.get(key).and_then(|v| v.as_f64())
}

/// Build the first-party view. Rows with missing CTR/position contribute
/// their clicks/impressions but never invent the missing values.
pub fn summarize_gsc(observations: &[ObservationEnvelope]) -> GscSummary {
    let mut out = GscSummary::default();
    for env in observations {
        if env.observation_type != ObservationType::SearchConsoleAggregate {
            continue;
        }
        out.row_count += 1;
        out.total_clicks += payload_i64(env, "clicks");
        out.total_impressions += payload_i64(env, "impressions");
        if payload_f64(env, "position").is_none() {
            out.rows_without_position += 1;
        }
    }
    if out.total_impressions > 0 {
        out.overall_ctr = Some(out.total_clicks as f64 / out.total_impressions as f64);
    }
    out
}

/// Build the sampled view from evidence-engine audit summaries.
/// Each summary already carries planned/succeeded/failed; the view sums
/// them without reinterpreting.
pub fn summarize_sampled(summaries: &[crate::audit_storage::AuditSummary]) -> SampledSummary {
    let mut out = SampledSummary::default();
    for s in summaries {
        out.runs += 1;
        out.planned += s.planned_queries;
        out.succeeded += s.successful_queries;
        out.failed += s.failed_queries;
        out.mentions += s.mention_count;
        out.recommendations += s.recommendation_count;
        out.cited_responses += s.citation_response_count;
        out.total_citations += s.citation_count;
        out.project_citations += s.project_citation_count;
    }
    if out.succeeded > 0 {
        out.mention_rate = Some(out.mentions as f64 / out.succeeded as f64);
        out.citation_response_rate = Some(out.cited_responses as f64 / out.succeeded as f64);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observations::{FailureClass, ObservationType, RetrievalMode};

    fn gsc_env(clicks: i64, impressions: i64, position: Option<f64>) -> ObservationEnvelope {
        ObservationEnvelope {
            observation_id: "o".to_string(),
            project_id: "p".to_string(),
            observation_type: ObservationType::SearchConsoleAggregate,
            surface: "search-console".to_string(),
            collected_at: "2026-09-01T00:00:00Z".to_string(),
            collector_version: "t".to_string(),
            schema_version: 1,
            provider: None,
            model: None,
            retrieval_mode: RetrievalMode::Unknown,
            region: None,
            language: None,
            prompt_group: None,
            prompt_variant: None,
            url_digest: None,
            planned: 1,
            succeeded: 1,
            failed: 0,
            failure_class: FailureClass::None,
            latency_ms: None,
            cost_usd: None,
            raw_digest: "d".to_string(),
            raw_ref: "d".to_string(),
            payload: serde_json::json!({
                "clicks": clicks, "impressions": impressions, "position": position,
            }),
        }
    }

    #[test]
    fn test_denominators_stay_separate() {
        // First-party rows and sampled summaries aggregate independently;
        // no pooled rate is ever produced.
        let gsc = summarize_gsc(&[gsc_env(10, 100, Some(2.0)), gsc_env(0, 50, None)]);
        assert_eq!(gsc.row_count, 2);
        assert_eq!(gsc.total_clicks, 10);
        assert_eq!(gsc.total_impressions, 150);
        assert!((gsc.overall_ctr.unwrap() - 10.0 / 150.0).abs() < 1e-9);
        assert_eq!(gsc.rows_without_position, 1);

        let sampled = summarize_sampled(&[crate::audit_storage::AuditSummary {
            total_queries: 4,
            mention_count: 2,
            recommendation_count: 1,
            citation_count: 6,
            mention_rate: 0.5,
            recommendation_rate: 0.25,
            citation_rate: 0.5,
            models_used: vec![],
            planned_queries: 5,
            successful_queries: 4,
            failed_queries: 1,
            citation_response_count: 2,
            project_citation_count: 3,
        }]);
        assert_eq!(sampled.runs, 1);
        assert_eq!(sampled.planned, 5);
        assert_eq!(sampled.succeeded, 4);
        assert!((sampled.mention_rate.unwrap() - 0.5).abs() < 1e-9);
        assert!((sampled.citation_response_rate.unwrap() - 0.5).abs() < 1e-9);
    }

    #[test]
    fn test_zero_observations_yield_empty_views_not_errors() {
        let gsc = summarize_gsc(&[]);
        assert_eq!(gsc, GscSummary::default());
        assert_eq!(gsc.overall_ctr, None);
        let sampled = summarize_sampled(&[]);
        assert_eq!(sampled, SampledSummary::default());
        assert_eq!(sampled.mention_rate, None);
    }

    #[test]
    fn test_non_gsc_rows_ignored_by_gsc_view() {
        let mut env = gsc_env(99, 99, Some(1.0));
        env.observation_type = ObservationType::ParametricAnswer;
        let gsc = summarize_gsc(&[env]);
        assert_eq!(gsc.row_count, 0);
        assert_eq!(gsc.total_impressions, 0);
    }
}
