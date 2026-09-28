//! Read-time views over kernel observations.
//!
//! Invariants (see `docs/engineering/observation-kernel.md`):
//! - Derived numbers are computed here from immutable observations, never stored.
//! - Breakdown slices group only rows with the exact same dimension
//!   signature. Slices are reported side by side and NEVER added together:
//!   no cross-breakdown totals exist anywhere in these views.
//! - First-party aggregates, sampled experiments, grounded, parametric and
//!   unknown results each keep their own denominator and are never pooled.
//! - No visibility score exists anywhere in these views.

use std::collections::BTreeMap;

use crate::gsc::{payload_sourced_float, payload_sourced_int, ValueSemantics};
use crate::observations::{
    effective_identity, ObservationEnvelope, ObservationType, ReportIdentity, RetrievalMode,
};

/// One rendered number: parsed value plus what the source guarantees.
#[derive(Debug, Clone, PartialEq)]
pub struct NumView {
    pub value: Option<i64>,
    pub semantics: ValueSemantics,
    pub raw: String,
}

/// One rendered float: parsed value plus what the source guarantees.
#[derive(Debug, Clone, PartialEq)]
pub struct FloatView {
    pub value: Option<f64>,
    pub semantics: ValueSemantics,
    pub raw: String,
}

/// One observation row inside a slice, with its full dimension tuple.
#[derive(Debug, Clone, PartialEq)]
pub struct SliceRow {
    pub dims: Vec<(String, String)>,
    pub clicks: Option<NumView>,
    pub impressions: NumView,
    pub ctr: Option<FloatView>,
    pub position: Option<FloatView>,
}

/// One breakdown slice: rows sharing an identity AND an exact dimension
/// signature (e.g. `page × country` is a different slice from
/// `page × device`). Row counts only — slices are never summed.
#[derive(Debug, Clone, PartialEq)]
pub struct DimensionSlice {
    /// Present dimension names, canonical order.
    pub dims: Vec<String>,
    pub rows: Vec<SliceRow>,
}

/// First-party section for one effective report identity.
#[derive(Debug, Clone, PartialEq)]
pub struct FirstPartySection {
    pub identity: ReportIdentity,
    /// False for AI identities until validated against a genuine sample.
    pub format_verified: bool,
    pub slices: Vec<DimensionSlice>,
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

fn dims_of(env: &ObservationEnvelope) -> Vec<(String, String)> {
    if let Some(map) = env.payload.get("dimensions").and_then(|v| v.as_object()) {
        return map
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
            .collect();
    }
    // Pre-tuple rows stored dimension_kind/dimension_value (+country/device):
    // map them onto the same shape so history stays readable and grouped.
    let mut out = Vec::new();
    if let (Some(kind), Some(value)) = (
        env.payload.get("dimension_kind").and_then(|v| v.as_str()),
        env.payload.get("dimension_value").and_then(|v| v.as_str()),
    ) {
        let name = kind;
        // Canonical order: page, country, device, date, then the kind itself.
        for key in ["page", "country", "device", "date"] {
            if name == key {
                out.push((key.to_string(), value.to_string()));
            }
        }
        if let Some(v) = env.payload.get("country").and_then(|v| v.as_str()) {
            if name != "country" {
                out.push(("country".to_string(), v.to_string()));
            }
        }
        if let Some(v) = env.payload.get("device").and_then(|v| v.as_str()) {
            if name != "device" {
                out.push(("device".to_string(), v.to_string()));
            }
        }
        if !["page", "country", "device", "date"].contains(&name) {
            out.push((name.to_string(), value.to_string()));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn raw_of(payload: &serde_json::Value, key: &str) -> String {
    match payload.get(key) {
        Some(serde_json::Value::Object(o)) => o
            .get("raw")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Build first-party sections grouped by (identity, dimension signature).
/// Sections sort canonically: generic, AI search, AI discover, unknown.
pub fn summarize_first_party(observations: &[ObservationEnvelope]) -> Vec<FirstPartySection> {
    let mut slices: BTreeMap<(u8, String), DimensionSlice> = BTreeMap::new();
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
        let dims = dims_of(env);
        let sig: Vec<String> = dims.iter().map(|(k, _)| k.clone()).collect();
        let key = format!("{:?}", sig);
        let (clicks_value, clicks_sem) = payload_sourced_int(&env.payload, "clicks");
        let (impr_value, impr_sem) = payload_sourced_int(&env.payload, "impressions");
        let (ctr_value, ctr_sem) = payload_sourced_float(&env.payload, "ctr");
        let (pos_value, pos_sem) = payload_sourced_float(&env.payload, "position");
        let has_clicks_col = env.payload.get("clicks").is_some_and(|v| !v.is_null());
        // AI rows carry no clicks column at all: None, never zero-filled.
        // Generic rows always have the column (possibly unavailable).
        let clicks = if has_clicks_col || identity == ReportIdentity::GenericSearch {
            Some(NumView {
                value: clicks_value,
                semantics: clicks_sem,
                raw: raw_of(&env.payload, "clicks"),
            })
        } else {
            None
        };
        let slice = slices
            .entry((order, key))
            .or_insert_with(|| DimensionSlice {
                dims: sig.clone(),
                rows: Vec::new(),
            });
        slice.rows.push(SliceRow {
            dims,
            clicks,
            impressions: NumView {
                value: impr_value,
                semantics: impr_sem,
                raw: raw_of(&env.payload, "impressions"),
            },
            ctr: env.payload.get("ctr").map(|_| FloatView {
                value: ctr_value,
                semantics: ctr_sem,
                raw: raw_of(&env.payload, "ctr"),
            }),
            position: env.payload.get("position").map(|_| FloatView {
                value: pos_value,
                semantics: pos_sem,
                raw: raw_of(&env.payload, "position"),
            }),
        });
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
        let mut section_slices: Vec<DimensionSlice> = slices
            .iter()
            .filter(|((o, _), _)| *o == order)
            .map(|(_, b)| b.clone())
            .collect();
        if section_slices.is_empty() {
            continue;
        }
        section_slices.sort_by(|a, b| a.dims.cmp(&b.dims));
        let identity = identity_for(order);
        sections.push(FirstPartySection {
            identity,
            format_verified: !identity.is_confirmed_ai(),
            slices: section_slices,
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
        payload: serde_json::Value,
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
            payload,
            report_identity: crate::observations::ReportIdentity::GenericSearch,
        }
    }

    fn sourced_row(
        dims: &[(&str, &str)],
        clicks: Option<(Option<i64>, ValueSemantics, &str)>,
        impressions: (Option<i64>, ValueSemantics, &str),
    ) -> ObservationEnvelope {
        let mut dim_map = serde_json::Map::new();
        for (k, v) in dims {
            dim_map.insert(
                (*k).to_string(),
                serde_json::Value::String((*v).to_string()),
            );
        }
        let num = |(v, s, r): (Option<i64>, ValueSemantics, &str)| {
            serde_json::json!({"raw": r, "value": v, "semantics": match s {
                ValueSemantics::Reported => "reported",
                ValueSemantics::Unavailable => "unavailable",
            }})
        };
        env_with(
            ObservationType::SearchConsoleAggregate,
            serde_json::json!({
                "dimensions": dim_map,
                "clicks": clicks.map(num),
                "impressions": num(impressions),
            }),
            RetrievalMode::Unknown,
        )
    }

    #[test]
    fn test_slices_never_sum_across_breakdowns() {
        // page×country and page×device slices stay separate; no totals.
        let sections = summarize_first_party(&[
            sourced_row(
                &[("page", "A"), ("country", "US")],
                Some((Some(10), ValueSemantics::Reported, "10")),
                (Some(100), ValueSemantics::Reported, "100"),
            ),
            sourced_row(
                &[("page", "A"), ("country", "GB")],
                Some((Some(5), ValueSemantics::Reported, "5")),
                (Some(80), ValueSemantics::Reported, "80"),
            ),
            sourced_row(
                &[("page", "A"), ("device", "mobile")],
                Some((Some(3), ValueSemantics::Reported, "3")),
                (Some(60), ValueSemantics::Reported, "60"),
            ),
        ]);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].row_count, 3);
        let sigs: Vec<Vec<String>> = sections[0].slices.iter().map(|s| s.dims.clone()).collect();
        assert_eq!(
            sigs,
            vec![
                vec!["country".to_string(), "page".to_string()],
                vec!["device".to_string(), "page".to_string()],
            ]
        );
        assert_eq!(sections[0].slices[0].rows.len(), 2);
        assert_eq!(sections[0].slices[1].rows.len(), 1);
        // No summed field exists on slices or sections: row counts only.
    }

    #[test]
    fn test_ai_identities_stay_separate_and_unverified() {
        let mut ai = sourced_row(
            &[("page", "P")],
            None,
            (Some(200), ValueSemantics::Reported, "200"),
        );
        ai.report_identity = crate::observations::ReportIdentity::GenerativeAiSearch;
        let sections = summarize_first_party(&[
            sourced_row(
                &[("query", "q")],
                Some((Some(5), ValueSemantics::Reported, "5")),
                (Some(50), ValueSemantics::Reported, "50"),
            ),
            ai,
        ]);
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
        // AI rows carry no clicks column at all.
        assert!(sections[1].slices[0].rows[0].clicks.is_none());
    }

    #[test]
    fn test_unavailable_and_reported_zero_render_distinctly() {
        let sections = summarize_first_party(&[
            sourced_row(
                &[("page", "A")],
                Some((None, ValueSemantics::Unavailable, "")),
                (Some(0), ValueSemantics::Reported, "0"),
            ),
            sourced_row(
                &[("page", "B")],
                Some((Some(0), ValueSemantics::Reported, "0")),
                (Some(10), ValueSemantics::Reported, "10"),
            ),
        ]);
        let rows = &sections[0].slices[0].rows;
        assert_eq!(
            rows[0].clicks.as_ref().unwrap().semantics,
            ValueSemantics::Unavailable
        );
        assert_eq!(rows[0].clicks.as_ref().unwrap().value, None);
        assert_eq!(rows[0].impressions.value, Some(0));
        assert_eq!(rows[0].impressions.semantics, ValueSemantics::Reported);
        assert_eq!(rows[1].clicks.as_ref().unwrap().value, Some(0));
    }

    #[test]
    fn test_old_plain_number_payloads_still_read() {
        // Pre-semantics rows stored bare numbers: tolerated as reported.
        let env = env_with(
            ObservationType::SearchConsoleAggregate,
            serde_json::json!({
                "dimensions": {"page": "P"},
                "clicks": 7, "impressions": 70,
            }),
            RetrievalMode::Unknown,
        );
        let sections = summarize_first_party(&[env]);
        let row = &sections[0].slices[0].rows[0];
        assert_eq!(row.clicks.as_ref().unwrap().value, Some(7));
        assert_eq!(
            row.clicks.as_ref().unwrap().semantics,
            ValueSemantics::Reported
        );
        assert_eq!(row.impressions.value, Some(70));
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
