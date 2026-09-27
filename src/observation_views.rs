//! Read-time views over kernel observations.
//!
//! Invariants (see `docs/engineering/observation-kernel.md`):
//! - Derived numbers are computed here from immutable observations, never stored.
//! - Query/page/country/device/date breakdowns are different cuts of the same
//!   exposure: reported per-breakdown, never summed across breakdowns.
//! - First-party aggregates, sampled experiments, grounded, parametric and
//!   unknown results each keep their own denominator and are never pooled.
//! - No visibility score exists anywhere in these views.

use std::collections::BTreeMap;

use crate::observations::{
    effective_identity, ObservationEnvelope, ObservationType, ReportIdentity, RetrievalMode,
};

/// One breakdown slice: rows sharing a report identity + dimension kind.
/// Clicks/impressions sum WITHIN this slice only (the source aggregated them
/// compatibly); slices are never added together.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct KindBreakdown {
    pub kind: String,
    pub rows: usize,
    /// `None` for AI identities (their exports carry no clicks, never zero).
    pub clicks: Option<i64>,
    pub impressions: i64,
    pub rows_without_position: usize,
}

/// First-party section for one effective report identity.
#[derive(Debug, Clone, PartialEq)]
pub struct FirstPartySection {
    pub identity: ReportIdentity,
    /// False for AI identities until validated against a genuine sample.
    pub format_verified: bool,
    pub breakdowns: Vec<KindBreakdown>,
    pub row_count: usize,
}

/// Counts per retrieval mode. Unknown is a real denominator, not a residual.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RetrievalSplit {
    pub grounded: usize,
    pub parametric: usize,
    pub unknown: usize,
}

/// Provenance slice: who produced the evidence (surface × provider × model).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ProvenanceSlice {
    pub surface: String,
    pub provider: String,
    pub model: String,
    pub count: usize,
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
    /// True when any contributing run used the mock provider (test data).
    pub includes_mock: bool,
}

fn payload_i64(env: &ObservationEnvelope, key: &str) -> i64 {
    env.payload.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn payload_opt_i64(env: &ObservationEnvelope, key: &str) -> Option<i64> {
    env.payload.get(key).and_then(|v| v.as_i64())
}

fn payload_has_position(env: &ObservationEnvelope) -> bool {
    env.payload
        .get("position")
        .and_then(|v| v.as_f64())
        .is_some()
}

/// Build first-party sections grouped by effective report identity, each
/// with per-dimension-kind breakdowns. Sections sort canonically:
/// generic, AI search, AI discover, unknown.
pub fn summarize_first_party(observations: &[ObservationEnvelope]) -> Vec<FirstPartySection> {
    let mut grouped: BTreeMap<(u8, String), KindBreakdown> = BTreeMap::new();
    let mut counts: BTreeMap<u8, usize> = BTreeMap::new();
    for env in observations {
        if env.observation_type != ObservationType::SearchConsoleAggregate {
            continue;
        }
        let identity = effective_identity(env);
        let order = match identity {
            ReportIdentity::GenericSearch => 0,
            ReportIdentity::GenerativeAiSearch => 1,
            ReportIdentity::GenerativeAiDiscover => 2,
            ReportIdentity::Unknown => 3,
        };
        let kind = env
            .payload
            .get("dimension_kind")
            .and_then(|v| v.as_str())
            .unwrap_or("dimension")
            .to_string();
        let entry = grouped
            .entry((order, kind.clone()))
            .or_insert_with(|| KindBreakdown {
                kind: kind.clone(),
                ..Default::default()
            });
        entry.rows += 1;
        entry.impressions += payload_i64(env, "impressions");
        // Clicks only where the source reports them; AI rows keep None.
        if identity == ReportIdentity::GenericSearch
            || env.payload.get("clicks").and_then(|v| v.as_i64()).is_some()
        {
            let c = entry.clicks.unwrap_or(0) + payload_opt_i64(env, "clicks").unwrap_or(0);
            entry.clicks = Some(c);
        }
        if !payload_has_position(env) {
            entry.rows_without_position += 1;
        }
        *counts.entry(order).or_insert(0) += 1;
    }

    let identity_for = |order: u8| match order {
        0 => ReportIdentity::GenericSearch,
        1 => ReportIdentity::GenerativeAiSearch,
        2 => ReportIdentity::GenerativeAiDiscover,
        _ => ReportIdentity::Unknown,
    };
    let mut sections: Vec<FirstPartySection> = Vec::new();
    for order in [0u8, 1, 2, 3] {
        let breakdowns: Vec<KindBreakdown> = grouped
            .iter()
            .filter(|((o, _), _)| *o == order)
            .map(|(_, b)| b.clone())
            .collect();
        if breakdowns.is_empty() {
            continue;
        }
        let identity = identity_for(order);
        sections.push(FirstPartySection {
            identity,
            format_verified: !identity.is_confirmed_ai(),
            breakdowns,
            row_count: counts[&order],
        });
    }
    sections
}

/// Split grounded/parametric/unknown observations into distinct denominators.
pub fn summarize_retrieval(observations: &[ObservationEnvelope]) -> RetrievalSplit {
    let mut out = RetrievalSplit::default();
    for env in observations {
        match env.observation_type {
            ObservationType::GroundedAnswer => match env.retrieval_mode {
                RetrievalMode::Grounded => out.grounded += 1,
                RetrievalMode::Parametric => out.parametric += 1,
                RetrievalMode::Unknown => out.unknown += 1,
            },
            ObservationType::ParametricAnswer => out.parametric += 1,
            _ => {}
        }
    }
    out
}

/// Provenance split across all observations (surface × provider × model),
/// so mock/test origins never merge with real-provider evidence.
pub fn summarize_provenance(observations: &[ObservationEnvelope]) -> Vec<ProvenanceSlice> {
    let mut counts: BTreeMap<(String, String, String), usize> = BTreeMap::new();
    for env in observations {
        let key = (
            env.surface.clone(),
            env.provider
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            env.model.clone().unwrap_or_else(|| "unknown".to_string()),
        );
        *counts.entry(key).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .map(|((surface, provider, model), count)| ProvenanceSlice {
            surface,
            provider,
            model,
            count,
        })
        .collect()
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
        if s.uses_mock_provider() {
            out.includes_mock = true;
        }
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

    fn env_with(
        obs_type: ObservationType,
        identity_payload: serde_json::Value,
        mode: RetrievalMode,
    ) -> ObservationEnvelope {
        ObservationEnvelope {
            observation_id: "o".to_string(),
            project_id: "p".to_string(),
            observation_type: obs_type,
            surface: "search-console".to_string(),
            collected_at: "2026-09-01T00:00:00Z".to_string(),
            collector_version: "t".to_string(),
            schema_version: 1,
            provider: None,
            model: None,
            retrieval_mode: mode,
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
            payload: identity_payload,
            report_identity: crate::observations::ReportIdentity::Unknown,
        }
    }

    fn gsc_env(
        kind: &str,
        clicks: Option<i64>,
        impressions: i64,
        position: Option<f64>,
    ) -> ObservationEnvelope {
        let mut e = env_with(
            ObservationType::SearchConsoleAggregate,
            serde_json::json!({
                "dimension_kind": kind, "clicks": clicks,
                "impressions": impressions, "position": position,
            }),
            RetrievalMode::Unknown,
        );
        // Pre-identity history overlays as generic when clicks are present.
        if clicks.is_some() {
            e.report_identity = crate::observations::ReportIdentity::GenericSearch;
        }
        e
    }

    #[test]
    fn test_breakdowns_never_sum_across_kinds() {
        let sections = summarize_first_party(&[
            gsc_env("query", Some(10), 100, Some(2.0)),
            gsc_env("query", Some(0), 50, None),
            gsc_env("page", Some(10), 100, Some(3.0)),
        ]);
        assert_eq!(sections.len(), 1);
        assert_eq!(
            sections[0].identity,
            crate::observations::ReportIdentity::GenericSearch
        );
        assert!(sections[0].format_verified);
        let kinds: Vec<&str> = sections[0]
            .breakdowns
            .iter()
            .map(|b| b.kind.as_str())
            .collect();
        assert_eq!(kinds, vec!["page", "query"]); // BTreeMap order
        let query = &sections[0].breakdowns[1];
        assert_eq!(query.rows, 2);
        assert_eq!(query.clicks, Some(10));
        assert_eq!(query.impressions, 150);
        assert_eq!(query.rows_without_position, 1);
        // No cross-kind total exists anywhere in the view.
        assert_eq!(sections[0].row_count, 3);
    }

    #[test]
    fn test_ai_identities_stay_separate_and_unverified() {
        let mut ai = gsc_env("page", None, 200, Some(1.5));
        ai.report_identity = crate::observations::ReportIdentity::GenerativeAiSearch;
        ai.payload = serde_json::json!({
            "dimension_kind": "page", "impressions": 200, "position": 1.5,
        });
        let sections = summarize_first_party(&[gsc_env("query", Some(5), 50, None), ai]);
        assert_eq!(sections.len(), 2);
        assert_eq!(
            sections[0].identity,
            crate::observations::ReportIdentity::GenericSearch
        );
        assert_eq!(
            sections[1].identity,
            crate::observations::ReportIdentity::GenerativeAiSearch
        );
        assert!(!sections[1].format_verified);
        assert_eq!(sections[1].breakdowns[0].clicks, None); // never zero-filled
    }

    #[test]
    fn test_retrieval_split_has_three_denominators() {
        let split = summarize_retrieval(&[
            env_with(
                ObservationType::GroundedAnswer,
                serde_json::json!({}),
                RetrievalMode::Grounded,
            ),
            env_with(
                ObservationType::GroundedAnswer,
                serde_json::json!({}),
                RetrievalMode::Unknown,
            ),
            env_with(
                ObservationType::ParametricAnswer,
                serde_json::json!({}),
                RetrievalMode::Parametric,
            ),
            env_with(
                ObservationType::SearchConsoleAggregate,
                serde_json::json!({}),
                RetrievalMode::Unknown,
            ),
        ]);
        assert_eq!(
            split,
            RetrievalSplit {
                grounded: 1,
                parametric: 1,
                unknown: 1
            }
        );
    }

    #[test]
    fn test_provenance_splits_surfaces() {
        let mut a = env_with(
            ObservationType::ParametricAnswer,
            serde_json::json!({}),
            RetrievalMode::Parametric,
        );
        a.surface = "mock-harness".to_string();
        let b = env_with(
            ObservationType::ParametricAnswer,
            serde_json::json!({}),
            RetrievalMode::Parametric,
        );
        let prov = summarize_provenance(&[a, b]);
        assert_eq!(prov.len(), 2);
        assert!(prov
            .iter()
            .any(|p| p.surface == "mock-harness" && p.count == 1));
    }

    #[test]
    fn test_zero_observations_yield_empty_views() {
        assert!(summarize_first_party(&[]).is_empty());
        assert_eq!(summarize_retrieval(&[]), RetrievalSplit::default());
        assert!(summarize_provenance(&[]).is_empty());
        let sampled = summarize_sampled(&[]);
        assert_eq!(sampled, SampledSummary::default());
        assert_eq!(sampled.mention_rate, None);
    }
}
