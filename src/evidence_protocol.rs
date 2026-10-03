//! Portable Ghostping Evidence Protocol V1 (Rust reader).
//!
//! `packages/protocol` (TypeScript, Effect Schema) is the canonical schema
//! source and generates the golden fixtures in `fixtures/evidence-protocol-v1`.
//! This module independently implements the same canonical JSON, measurement
//! comparison, outcome derivation, packet assembly, and fail-closed
//! validation, so the two languages must agree on every fixture rather than
//! merely parse it. Any change here must change the TypeScript side too.
//!
//! The local CLI does not export hosted packets: hosted lineage lives in
//! PostgreSQL, which the local-first CLI deliberately does not access.

use std::collections::HashSet;
use std::fmt;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const PROTOCOL_VERSION: u64 = 1;
pub const PACKET_SCHEMA_V1: &str = "ghostping/evidence-packet-v1";
pub const SURFACE_SCHEMA_V1: &str = "ghostping/surface-v1";
pub const MEASUREMENT_SCHEMA_V1: &str = "ghostping/measurement-context-v1";
pub const FACT_SCHEMA_V1: &str = "ghostping/fact-v1";
pub const OBSERVATION_SCHEMA_V1: &str = "ghostping/observation-v1";
pub const CLAIM_SCHEMA_V1: &str = "ghostping/claim-v1";
pub const JUDGMENT_SCHEMA_V1: &str = "ghostping/judgment-v1";
pub const ISSUE_SCHEMA_V1: &str = "ghostping/issue-v1";
pub const INTERVENTION_SCHEMA_V1: &str = "ghostping/intervention-v1";
pub const REOBSERVATION_SCHEMA_V1: &str = "ghostping/reobservation-v1";

/// Fail-closed validation error. `reason` codes match the TypeScript
/// `EvidencePacketInvalid.reason` values exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketError {
    pub reason: &'static str,
    pub detail: String,
}

impl PacketError {
    fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for PacketError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EvidencePacketInvalid: {}: {}", self.reason, self.detail)
    }
}

impl std::error::Error for PacketError {}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// ECMAScript Number::toString for a finite, non-integer-or-safe f64.
fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // `{:e}` yields the shortest round-trip digits, like ECMAScript.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').expect("scientific format");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().expect("exponent") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e >= 0 {
            format!("+{e}")
        } else {
            e.to_string()
        };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

fn write_canonical(value: &Value, out: &mut String) -> Result<(), String> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                if u as f64 > MAX_SAFE_INTEGER {
                    return Err("CanonicalJsonError: unsafe integer".into());
                }
                out.push_str(&u.to_string());
            } else if let Some(i) = n.as_i64() {
                if (i as f64).abs() > MAX_SAFE_INTEGER {
                    return Err("CanonicalJsonError: unsafe integer".into());
                }
                out.push_str(&i.to_string());
            } else {
                let f = n.as_f64().ok_or("CanonicalJsonError: number")?;
                if !f.is_finite() {
                    return Err("CanonicalJsonError: non-finite number".into());
                }
                if f.fract() == 0.0 {
                    if f.abs() > MAX_SAFE_INTEGER {
                        return Err("CanonicalJsonError: unsafe integer".into());
                    }
                    out.push_str(&(f as i64).to_string());
                } else {
                    out.push_str(&js_number(f));
                }
            }
        }
        Value::String(s) => {
            out.push_str(&serde_json::to_string(s).map_err(|e| e.to_string())?);
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(object) => {
            // Rust string ordering is UTF-8 byte order == code-point order.
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).map_err(|e| e.to_string())?);
                out.push(':');
                write_canonical(&object[key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Canonical JSON text: code-point key order, preserved array order,
/// ECMAScript number formatting, unsafe integers rejected.
pub fn canonical_json(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// SHA-256 of canonical packet bytes without the top-level `packet_digest`.
pub fn packet_digest(value: &Value) -> Result<String, PacketError> {
    let mut unsealed = value.clone();
    unsealed
        .as_object_mut()
        .ok_or_else(|| PacketError::new("NotAnObject", "packet"))?
        .remove("packet_digest");
    let text = canonical_json(&unsealed).map_err(|e| PacketError::new("SchemaViolation", e))?;
    Ok(sha256_hex(text.as_bytes()))
}

// ---------------------------------------------------------------------------
// Knowledge states and protocol objects
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", content = "value", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KnowledgeString {
    Known(String),
    Unknown,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", content = "value", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KnowledgeJson {
    Known(Value),
    Unknown,
    NotApplicable,
}

trait Knowledge {
    fn is_unknown(&self) -> bool;
}
impl Knowledge for KnowledgeString {
    fn is_unknown(&self) -> bool {
        matches!(self, KnowledgeString::Unknown)
    }
}
impl Knowledge for KnowledgeJson {
    fn is_unknown(&self) -> bool {
        matches!(self, KnowledgeJson::Unknown)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SurfaceKind {
    ConsumerUi,
    DirectApi,
    RouterApi,
    SearchGroundedApi,
    LocalModel,
    Mock,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MetadataVisibility {
    Full,
    Partial,
    None,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SurfaceIdentityV1 {
    pub schema: String,
    pub schema_version: u64,
    pub kind: SurfaceKind,
    pub product: String,
    pub adapter: String,
    pub adapter_version: String,
    pub gateway: KnowledgeString,
    pub requested_provider: KnowledgeString,
    pub requested_model: KnowledgeString,
    pub observed_provider: KnowledgeString,
    pub observed_model: KnowledgeString,
    pub account_state: KnowledgeString,
    pub subscription_tier: KnowledgeString,
    pub locale: KnowledgeString,
    pub region: KnowledgeString,
    pub search_mode: KnowledgeString,
    pub personalization_state: KnowledgeString,
    pub metadata_visibility: MetadataVisibility,
}

impl SurfaceIdentityV1 {
    /// Mirror of TypeScript `surfaceForWorker`. Only established metadata is
    /// KNOWN; 9Router never claims an upstream provider or search state.
    pub fn from_worker(
        provider: &str,
        requested_model: Option<&str>,
        observed_model: Option<&str>,
    ) -> anyhow::Result<Self> {
        let known_or = |v: Option<&str>, absent: KnowledgeString| match v {
            Some(value) => KnowledgeString::Known(value.to_string()),
            None => absent,
        };
        let base = |kind, product: &str, adapter: &str| Self {
            schema: SURFACE_SCHEMA_V1.to_string(),
            schema_version: PROTOCOL_VERSION,
            kind,
            product: product.into(),
            adapter: adapter.into(),
            adapter_version: "1".into(),
            gateway: KnowledgeString::Unknown,
            requested_provider: KnowledgeString::Unknown,
            requested_model: KnowledgeString::Unknown,
            observed_provider: KnowledgeString::Unknown,
            observed_model: KnowledgeString::Unknown,
            account_state: KnowledgeString::Unknown,
            subscription_tier: KnowledgeString::Unknown,
            locale: KnowledgeString::Unknown,
            region: KnowledgeString::Unknown,
            search_mode: KnowledgeString::Unknown,
            personalization_state: KnowledgeString::Unknown,
            metadata_visibility: MetadataVisibility::Partial,
        };
        match provider {
            "9router" => Ok(Self {
                gateway: KnowledgeString::Known("9router".into()),
                requested_model: known_or(requested_model, KnowledgeString::Unknown),
                observed_model: known_or(observed_model, KnowledgeString::Unknown),
                ..base(SurfaceKind::RouterApi, "9Router", "ghostping-9router")
            }),
            "mock" => {
                let na = KnowledgeString::NotApplicable;
                Ok(Self {
                    gateway: na.clone(),
                    requested_provider: KnowledgeString::Known("mock".into()),
                    requested_model: known_or(requested_model, na.clone()),
                    observed_provider: KnowledgeString::Known("mock".into()),
                    observed_model: known_or(observed_model, na.clone()),
                    account_state: na.clone(),
                    subscription_tier: na.clone(),
                    locale: na.clone(),
                    region: na.clone(),
                    search_mode: na.clone(),
                    personalization_state: na,
                    metadata_visibility: MetadataVisibility::Full,
                    ..base(
                        SurfaceKind::Mock,
                        "Ghostping deterministic fixture",
                        "ghostping-mock",
                    )
                })
            }
            other => anyhow::bail!("UnsupportedSurfaceProvider: {other}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MeasurementContextV1 {
    pub schema: String,
    pub schema_version: u64,
    pub question: String,
    pub question_id: String,
    pub question_version: KnowledgeString,
    pub business_id: String,
    pub surface: SurfaceIdentityV1,
    pub observed_at: String,
    pub measurement_configuration: KnowledgeJson,
    pub sample_number: u64,
    pub repeat_id: KnowledgeString,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BusinessIdentity {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CitationV1 {
    pub uri: Option<String>,
    pub title: Option<String>,
    pub position: Option<f64>,
    pub attributed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RawEvidenceRefV1 {
    pub id: String,
    pub digest_sha256: String,
    pub content_type: String,
    pub received_at: String,
    pub reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedded_bytes_base64: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FactStatus {
    Active,
    Superseded,
    Retired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FactV1 {
    pub schema: String,
    pub schema_version: u64,
    pub id: String,
    pub business_id: String,
    pub subject: String,
    pub predicate: String,
    pub value_text: String,
    pub value_type: String,
    pub status: FactStatus,
    pub version: u64,
    pub supersedes_id: Option<String>,
    pub valid_from: String,
    pub valid_until: Option<String>,
    pub source_kind: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ObservationV1 {
    pub schema: String,
    pub schema_version: u64,
    pub id: String,
    pub business_id: String,
    pub measurement: MeasurementContextV1,
    pub raw_evidence: RawEvidenceRefV1,
    pub normalized_answer_text: String,
    pub citations: Vec<CitationV1>,
    pub provider_metadata: KnowledgeJson,
    pub synthetic: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClaimOrigin {
    ManualTranscription,
    ManualExactSpan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ClaimV1 {
    pub schema: String,
    pub schema_version: u64,
    pub id: String,
    pub business_id: String,
    pub observation_id: String,
    pub text: String,
    pub origin: ClaimOrigin,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verdict {
    Supported,
    Contradicted,
    Partial,
    InsufficientEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct JudgmentV1 {
    pub schema: String,
    pub schema_version: u64,
    pub id: String,
    pub business_id: String,
    pub claim_id: String,
    pub verdict: Verdict,
    pub notes: Option<String>,
    pub fact_ids: Vec<String>,
    pub supersedes_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IssueState {
    Wrong,
    Partial,
    NeedsReview,
    Unknown,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IssueV1 {
    pub schema: String,
    pub schema_version: u64,
    pub id: String,
    pub business_id: String,
    pub observation_id: String,
    pub claim_id: String,
    #[serde(rename = "type")]
    pub issue_type: KnowledgeString,
    pub state: IssueState,
    pub derived_from_judgment_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InterventionType {
    SourceUpdated,
    SourcePublished,
    ThirdPartyCorrectionRequested,
    KnowledgeBaseUpdated,
    StructuredDataUpdated,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InterventionActor {
    Human,
    Agent,
    System,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct InterventionV1 {
    pub schema: String,
    pub schema_version: u64,
    pub id: String,
    pub business_id: String,
    pub issue_ids: Vec<String>,
    #[serde(rename = "type")]
    pub intervention_type: InterventionType,
    pub target: String,
    pub performed_at: String,
    pub actor: InterventionActor,
    pub actor_id: KnowledgeString,
    pub notes: Option<String>,
    pub evidence_before_digest: KnowledgeString,
    pub evidence_after_digest: KnowledgeString,
    pub supersedes_id: Option<String>,
    pub correction_reason: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MatchClassification {
    ExactMatch,
    Comparable,
    NotComparable,
    Indeterminate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ObservedChange {
    NoChange,
    Changed,
    Indeterminate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ObservedOutcome {
    ObservedCorrection,
    ObservedRegression,
    ObservedDifference,
    NoObservedChange,
    Indeterminate,
    NotObserved,
}

/// V1 has no causal experiment protocol; attribution is always UNKNOWN.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CausalAttribution {
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MeasurementSignatureV1 {
    pub business_id: String,
    pub question_id: String,
    pub question_version: KnowledgeString,
    pub exact_question_digest: String,
    pub surface_kind: SurfaceKind,
    pub product: String,
    pub adapter: String,
    pub adapter_version: String,
    pub gateway: KnowledgeString,
    pub requested_provider: KnowledgeString,
    pub requested_model: KnowledgeString,
    pub observed_provider: KnowledgeString,
    pub observed_model: KnowledgeString,
    pub account_state: KnowledgeString,
    pub subscription_tier: KnowledgeString,
    pub search_mode: KnowledgeString,
    pub locale: KnowledgeString,
    pub region: KnowledgeString,
    pub personalization_state: KnowledgeString,
    pub generation_configuration: KnowledgeJson,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReobservationV1 {
    pub schema: String,
    pub schema_version: u64,
    pub id: String,
    pub business_id: String,
    pub original_observation_id: String,
    pub issue_id: String,
    pub intervention_id: Option<String>,
    pub observation_id: String,
    pub before_signature: MeasurementSignatureV1,
    pub after_signature: MeasurementSignatureV1,
    pub match_classification: MatchClassification,
    pub before_judgment_id: Option<String>,
    pub after_claim_id: Option<String>,
    pub after_judgment_id: Option<String>,
    pub before_verdict: Option<Verdict>,
    pub after_verdict: Option<Verdict>,
    pub observed_change: ObservedChange,
    pub outcome: ObservedOutcome,
    pub causal_attribution: CausalAttribution,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExplicitUnknownV1 {
    pub subject_id: String,
    pub field: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvidencePacketV1 {
    pub schema: String,
    pub schema_version: u64,
    pub id: String,
    pub business: BusinessIdentity,
    pub issue: IssueV1,
    pub facts: Vec<FactV1>,
    pub original_observation: ObservationV1,
    pub claims: Vec<ClaimV1>,
    pub judgments: Vec<JudgmentV1>,
    pub interventions: Vec<InterventionV1>,
    pub reobservations: Vec<ReobservationV1>,
    pub reobservation_observations: Vec<ObservationV1>,
    pub reobservation_claims: Vec<ClaimV1>,
    pub reobservation_judgments: Vec<JudgmentV1>,
    pub observed_outcome: ObservedOutcome,
    pub causal_attribution: CausalAttribution,
    pub explicit_unknowns: Vec<ExplicitUnknownV1>,
    pub synthetic: bool,
    pub generated_at: String,
    pub signatures: Vec<Value>,
    pub packet_digest: String,
}

// ---------------------------------------------------------------------------
// Measurement comparison and outcome derivation
// ---------------------------------------------------------------------------

pub fn measurement_signature(context: &MeasurementContextV1) -> MeasurementSignatureV1 {
    let s = &context.surface;
    MeasurementSignatureV1 {
        business_id: context.business_id.clone(),
        question_id: context.question_id.clone(),
        question_version: context.question_version.clone(),
        exact_question_digest: sha256_hex(context.question.as_bytes()),
        surface_kind: s.kind,
        product: s.product.clone(),
        adapter: s.adapter.clone(),
        adapter_version: s.adapter_version.clone(),
        gateway: s.gateway.clone(),
        requested_provider: s.requested_provider.clone(),
        requested_model: s.requested_model.clone(),
        observed_provider: s.observed_provider.clone(),
        observed_model: s.observed_model.clone(),
        account_state: s.account_state.clone(),
        subscription_tier: s.subscription_tier.clone(),
        search_mode: s.search_mode.clone(),
        locale: s.locale.clone(),
        region: s.region.clone(),
        personalization_state: s.personalization_state.clone(),
        generation_configuration: context.measurement_configuration.clone(),
    }
}

/// `(conflict, either_unknown)` for one Knowledge dimension.
fn dimension<K: Knowledge + Serialize>(a: &K, b: &K) -> (bool, bool) {
    if a.is_unknown() || b.is_unknown() {
        return (false, true);
    }
    let canon = |k: &K| {
        serde_json::to_value(k)
            .ok()
            .and_then(|v| canonical_json(&v).ok())
    };
    (canon(a) != canon(b), false)
}

/// Same rules as TypeScript `compareMeasurements`. EXACT_MATCH is reachable
/// only when no dimension is UNKNOWN on either side.
pub fn compare_measurements(
    a: &MeasurementSignatureV1,
    b: &MeasurementSignatureV1,
) -> MatchClassification {
    if a.business_id != b.business_id
        || a.question_id != b.question_id
        || a.exact_question_digest != b.exact_question_digest
        || a.surface_kind != b.surface_kind
        || a.product != b.product
        || a.adapter != b.adapter
    {
        return MatchClassification::NotComparable;
    }
    let critical = [
        dimension(&a.gateway, &b.gateway),
        dimension(&a.requested_provider, &b.requested_provider),
        dimension(&a.requested_model, &b.requested_model),
        dimension(&a.account_state, &b.account_state),
        dimension(&a.subscription_tier, &b.subscription_tier),
        dimension(&a.search_mode, &b.search_mode),
        dimension(&a.personalization_state, &b.personalization_state),
        dimension(&a.generation_configuration, &b.generation_configuration),
    ];
    let supporting = [
        dimension(&a.question_version, &b.question_version),
        dimension(&a.observed_provider, &b.observed_provider),
        dimension(&a.observed_model, &b.observed_model),
        dimension(&a.locale, &b.locale),
        dimension(&a.region, &b.region),
    ];
    if critical.iter().chain(supporting.iter()).any(|(c, _)| *c) {
        return MatchClassification::NotComparable;
    }
    if critical.iter().any(|(_, u)| *u) {
        return MatchClassification::Indeterminate;
    }
    if supporting.iter().any(|(_, u)| *u) || a.adapter_version != b.adapter_version {
        return MatchClassification::Comparable;
    }
    MatchClassification::ExactMatch
}

fn usable(m: MatchClassification) -> bool {
    matches!(
        m,
        MatchClassification::ExactMatch | MatchClassification::Comparable
    )
}

pub fn derive_observed_change(m: MatchClassification, before: &str, after: &str) -> ObservedChange {
    if !usable(m) {
        ObservedChange::Indeterminate
    } else if before == after {
        ObservedChange::NoChange
    } else {
        ObservedChange::Changed
    }
}

pub fn derive_outcome(
    before: Option<Verdict>,
    after: Option<Verdict>,
    m: MatchClassification,
    change: ObservedChange,
) -> ObservedOutcome {
    let (Some(before), Some(after)) = (before, after) else {
        return ObservedOutcome::Indeterminate;
    };
    if !usable(m) {
        return ObservedOutcome::Indeterminate;
    }
    match (before, after) {
        (Verdict::Contradicted, Verdict::Supported) => ObservedOutcome::ObservedCorrection,
        (Verdict::Supported, Verdict::Contradicted) => ObservedOutcome::ObservedRegression,
        (b, a) if b != a => ObservedOutcome::ObservedDifference,
        _ if change == ObservedChange::Changed => ObservedOutcome::ObservedDifference,
        _ => ObservedOutcome::NoObservedChange,
    }
}

pub fn issue_state_for(verdict: Option<Verdict>) -> IssueState {
    match verdict {
        None => IssueState::NeedsReview,
        Some(Verdict::Contradicted) => IssueState::Wrong,
        Some(Verdict::Partial) => IssueState::Partial,
        Some(Verdict::InsufficientEvidence) => IssueState::Unknown,
        Some(Verdict::Supported) => IssueState::Resolved,
    }
}

fn by_time_then_id(a: (&str, &str), b: (&str, &str)) -> std::cmp::Ordering {
    a.0.cmp(b.0).then_with(|| a.1.cmp(b.1))
}

/// Head of a claim's append-only judgment chain.
pub fn latest_judgment<'a>(judgments: &'a [JudgmentV1], claim_id: &str) -> Option<&'a JudgmentV1> {
    let chain: Vec<&JudgmentV1> = judgments
        .iter()
        .filter(|j| j.claim_id == claim_id)
        .collect();
    let superseded: HashSet<&str> = chain
        .iter()
        .filter_map(|j| j.supersedes_id.as_deref())
        .collect();
    let mut heads: Vec<&JudgmentV1> = chain
        .into_iter()
        .filter(|j| !superseded.contains(j.id.as_str()))
        .collect();
    heads.sort_by(|a, b| by_time_then_id((&a.created_at, &a.id), (&b.created_at, &b.id)));
    heads.last().copied()
}

fn sole_claim<'a>(claims: &'a [ClaimV1], observation_id: &str) -> Option<&'a ClaimV1> {
    let own: Vec<&ClaimV1> = claims
        .iter()
        .filter(|c| c.observation_id == observation_id)
        .collect();
    if own.len() == 1 {
        Some(own[0])
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Packet assembly (mirror of TypeScript `assembleEvidencePacket`)
// ---------------------------------------------------------------------------

struct ReobservationInput {
    id: String,
    intervention_id: Option<String>,
    created_at: String,
    observation: ObservationV1,
    claims: Vec<ClaimV1>,
    judgments: Vec<JudgmentV1>,
}

fn unknown(subject_id: &str, field: &str) -> ExplicitUnknownV1 {
    ExplicitUnknownV1 {
        subject_id: subject_id.to_string(),
        field: field.to_string(),
    }
}

fn observation_unknowns(o: &ObservationV1) -> Vec<ExplicitUnknownV1> {
    let s = &o.measurement.surface;
    let fields: [(&str, &KnowledgeString); 11] = [
        ("gateway", &s.gateway),
        ("requested_provider", &s.requested_provider),
        ("requested_model", &s.requested_model),
        ("observed_provider", &s.observed_provider),
        ("observed_model", &s.observed_model),
        ("account_state", &s.account_state),
        ("subscription_tier", &s.subscription_tier),
        ("locale", &s.locale),
        ("region", &s.region),
        ("search_mode", &s.search_mode),
        ("personalization_state", &s.personalization_state),
    ];
    let mut out: Vec<ExplicitUnknownV1> = fields
        .iter()
        .filter(|(_, k)| k.is_unknown())
        .map(|(name, _)| unknown(&o.id, &format!("surface.{name}")))
        .collect();
    if o.measurement.question_version.is_unknown() {
        out.push(unknown(&o.id, "measurement.question_version"));
    }
    if o.measurement.measurement_configuration.is_unknown() {
        out.push(unknown(&o.id, "measurement.measurement_configuration"));
    }
    if o.measurement.repeat_id.is_unknown() {
        out.push(unknown(&o.id, "measurement.repeat_id"));
    }
    if o.provider_metadata.is_unknown() {
        out.push(unknown(&o.id, "provider_metadata"));
    }
    out
}

fn assemble(p: &EvidencePacketV1) -> Result<EvidencePacketV1, PacketError> {
    let original = &p.original_observation;
    let mut claims = p.claims.clone();
    claims.sort_by(|a, b| by_time_then_id((&a.created_at, &a.id), (&b.created_at, &b.id)));
    let mut judgments = p.judgments.clone();
    judgments.sort_by(|a, b| by_time_then_id((&a.created_at, &a.id), (&b.created_at, &b.id)));
    let mut interventions = p.interventions.clone();
    interventions.sort_by(|a, b| {
        a.performed_at
            .cmp(&b.performed_at)
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut re_inputs: Vec<ReobservationInput> = p
        .reobservations
        .iter()
        .zip(p.reobservation_observations.iter())
        .map(|(r, observation)| {
            let claims: Vec<ClaimV1> = p
                .reobservation_claims
                .iter()
                .filter(|c| c.observation_id == observation.id)
                .cloned()
                .collect();
            let ids: HashSet<&str> = claims.iter().map(|c| c.id.as_str()).collect();
            let judgments = p
                .reobservation_judgments
                .iter()
                .filter(|j| ids.contains(j.claim_id.as_str()))
                .cloned()
                .collect();
            ReobservationInput {
                id: r.id.clone(),
                intervention_id: r.intervention_id.clone(),
                created_at: r.created_at.clone(),
                observation: observation.clone(),
                claims,
                judgments,
            }
        })
        .collect();
    re_inputs.sort_by(|a, b| by_time_then_id((&a.created_at, &a.id), (&b.created_at, &b.id)));

    let issue_id = &p.issue.id;
    let before_judgment = latest_judgment(&judgments, &p.issue.claim_id).cloned();
    let before_signature = measurement_signature(&original.measurement);
    let mut unknowns = observation_unknowns(original);
    if p.issue.issue_type.is_unknown() {
        unknowns.push(unknown(issue_id, "issue.type"));
    }
    if before_judgment.is_none() {
        unknowns.push(unknown(issue_id, "verdict"));
    }
    for i in &interventions {
        if i.actor == InterventionActor::Unknown {
            unknowns.push(unknown(&i.id, "actor"));
        }
        if i.actor_id.is_unknown() {
            unknowns.push(unknown(&i.id, "actor_id"));
        }
        if i.evidence_before_digest.is_unknown() {
            unknowns.push(unknown(&i.id, "evidence_before_digest"));
        }
        if i.evidence_after_digest.is_unknown() {
            unknowns.push(unknown(&i.id, "evidence_after_digest"));
        }
    }

    let mut reobservations = Vec::new();
    let mut re_claims = Vec::new();
    let mut re_judgments = Vec::new();
    for r in &re_inputs {
        let after = &r.observation;
        let after_signature = measurement_signature(&after.measurement);
        let m = compare_measurements(&before_signature, &after_signature);
        let after_claim = sole_claim(&r.claims, &after.id);
        let after_judgment = after_claim.and_then(|c| latest_judgment(&r.judgments, &c.id));
        let change = derive_observed_change(
            m,
            &original.normalized_answer_text,
            &after.normalized_answer_text,
        );
        let before_verdict = before_judgment.as_ref().map(|j| j.verdict);
        let after_verdict = after_judgment.map(|j| j.verdict);
        reobservations.push(ReobservationV1 {
            schema: REOBSERVATION_SCHEMA_V1.into(),
            schema_version: PROTOCOL_VERSION,
            id: r.id.clone(),
            business_id: p.business.id.clone(),
            original_observation_id: original.id.clone(),
            issue_id: issue_id.clone(),
            intervention_id: r.intervention_id.clone(),
            observation_id: after.id.clone(),
            before_signature: before_signature.clone(),
            after_signature,
            match_classification: m,
            before_judgment_id: before_judgment.as_ref().map(|j| j.id.clone()),
            after_claim_id: after_claim.map(|c| c.id.clone()),
            after_judgment_id: after_judgment.map(|j| j.id.clone()),
            before_verdict,
            after_verdict,
            observed_change: change,
            outcome: derive_outcome(before_verdict, after_verdict, m, change),
            causal_attribution: CausalAttribution::Unknown,
            created_at: r.created_at.clone(),
        });
        re_claims.extend(r.claims.iter().cloned());
        re_judgments.extend(r.judgments.iter().cloned());
        unknowns.extend(observation_unknowns(after));
        if after_claim.is_none() {
            unknowns.push(unknown(&r.id, "after_claim"));
        } else if after_judgment.is_none() {
            unknowns.push(unknown(&r.id, "after_verdict"));
        }
    }
    if !interventions.is_empty() && reobservations.is_empty() {
        unknowns.push(unknown(issue_id, "outcome_after_intervention"));
    }
    if !interventions.is_empty() || !reobservations.is_empty() {
        unknowns.push(unknown(issue_id, "causal_attribution"));
    }

    let mut synthetic = false;
    for o in std::iter::once(original).chain(re_inputs.iter().map(|r| &r.observation)) {
        if o.measurement.surface.kind == SurfaceKind::Mock && !o.synthetic {
            return Err(PacketError::new("MockObservationNotSynthetic", &o.id));
        }
        synthetic |= o.synthetic;
    }

    let mut facts = p.facts.clone();
    facts.sort_by(|a, b| {
        a.subject
            .cmp(&b.subject)
            .then_with(|| a.predicate.cmp(&b.predicate))
            .then_with(|| a.version.cmp(&b.version))
            .then_with(|| a.id.cmp(&b.id))
    });
    re_claims.sort_by(|a, b| by_time_then_id((&a.created_at, &a.id), (&b.created_at, &b.id)));
    re_judgments.sort_by(|a, b| by_time_then_id((&a.created_at, &a.id), (&b.created_at, &b.id)));
    let observed_outcome = reobservations
        .last()
        .map_or(ObservedOutcome::NotObserved, |r| r.outcome);

    Ok(EvidencePacketV1 {
        schema: PACKET_SCHEMA_V1.into(),
        schema_version: PROTOCOL_VERSION,
        id: p.id.clone(),
        business: p.business.clone(),
        issue: IssueV1 {
            schema: ISSUE_SCHEMA_V1.into(),
            schema_version: PROTOCOL_VERSION,
            id: issue_id.clone(),
            business_id: p.business.id.clone(),
            observation_id: original.id.clone(),
            claim_id: p.issue.claim_id.clone(),
            issue_type: p.issue.issue_type.clone(),
            state: issue_state_for(before_judgment.as_ref().map(|j| j.verdict)),
            derived_from_judgment_id: before_judgment.as_ref().map(|j| j.id.clone()),
            created_at: p.issue.created_at.clone(),
        },
        facts,
        original_observation: original.clone(),
        claims,
        judgments,
        interventions,
        reobservations,
        reobservation_observations: re_inputs.into_iter().map(|r| r.observation).collect(),
        reobservation_claims: re_claims,
        reobservation_judgments: re_judgments,
        observed_outcome,
        causal_attribution: CausalAttribution::Unknown,
        explicit_unknowns: unknowns,
        synthetic,
        generated_at: p.generated_at.clone(),
        signatures: vec![],
        packet_digest: String::new(),
    })
}

// ---------------------------------------------------------------------------
// Fail-closed validation
// ---------------------------------------------------------------------------

fn timestamp_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$").expect("timestamp regex")
    })
}

fn digest_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-f0-9]{64}$").expect("digest regex"))
}

/// Formats Effect Schema enforces beyond serde's structure.
struct Shape(Vec<String>);

impl Shape {
    fn header(&mut self, what: &str, schema: &str, version: u64, expected: &str) {
        if schema != expected || version != PROTOCOL_VERSION {
            self.0.push(format!("{what}: schema {schema}@{version}"));
        }
    }
    fn id(&mut self, what: &str, v: &str) {
        if v.is_empty() {
            self.0.push(format!("{what}: empty id"));
        }
    }
    fn ts(&mut self, what: &str, v: &str) {
        if !timestamp_re().is_match(v) {
            self.0.push(format!("{what}: timestamp {v}"));
        }
    }
    fn digest(&mut self, what: &str, v: &str) {
        if !digest_re().is_match(v) {
            self.0.push(format!("{what}: digest"));
        }
    }
    fn knowledge_digest(&mut self, what: &str, v: &KnowledgeString) {
        if let KnowledgeString::Known(d) = v {
            self.digest(what, d);
        }
    }
    fn observation(&mut self, o: &ObservationV1) {
        self.header(
            "observation",
            &o.schema,
            o.schema_version,
            OBSERVATION_SCHEMA_V1,
        );
        self.id("observation.id", &o.id);
        self.id("observation.business_id", &o.business_id);
        self.ts("observation.created_at", &o.created_at);
        let m = &o.measurement;
        self.header(
            "measurement",
            &m.schema,
            m.schema_version,
            MEASUREMENT_SCHEMA_V1,
        );
        self.header(
            "surface",
            &m.surface.schema,
            m.surface.schema_version,
            SURFACE_SCHEMA_V1,
        );
        self.id("measurement.question_id", &m.question_id);
        self.id("measurement.business_id", &m.business_id);
        self.ts("measurement.observed_at", &m.observed_at);
        if m.sample_number < 1 {
            self.0.push("measurement.sample_number < 1".into());
        }
        self.id("raw_evidence.id", &o.raw_evidence.id);
        self.digest("raw_evidence.digest_sha256", &o.raw_evidence.digest_sha256);
        self.ts("raw_evidence.received_at", &o.raw_evidence.received_at);
    }
    fn claim(&mut self, c: &ClaimV1) {
        self.header("claim", &c.schema, c.schema_version, CLAIM_SCHEMA_V1);
        for v in [&c.id, &c.business_id, &c.observation_id] {
            self.id("claim", v);
        }
        self.ts("claim.created_at", &c.created_at);
    }
    fn judgment(&mut self, j: &JudgmentV1) {
        self.header("judgment", &j.schema, j.schema_version, JUDGMENT_SCHEMA_V1);
        for v in [&j.id, &j.business_id, &j.claim_id]
            .into_iter()
            .chain(j.fact_ids.iter())
            .chain(j.supersedes_id.iter())
        {
            self.id("judgment", v);
        }
        self.ts("judgment.created_at", &j.created_at);
    }
    fn signature(&mut self, s: &MeasurementSignatureV1) {
        self.id("signature.business_id", &s.business_id);
        self.id("signature.question_id", &s.question_id);
        self.digest("signature.exact_question_digest", &s.exact_question_digest);
    }
}

fn check_shape(p: &EvidencePacketV1) -> Result<(), PacketError> {
    let mut s = Shape(Vec::new());
    s.id("packet.id", &p.id);
    s.id("business.id", &p.business.id);
    s.ts("generated_at", &p.generated_at);
    s.digest("packet_digest", &p.packet_digest);
    if !p.signatures.is_empty() {
        s.0.push("signatures must be empty in V1".into());
    }
    let i = &p.issue;
    s.header("issue", &i.schema, i.schema_version, ISSUE_SCHEMA_V1);
    for v in [&i.id, &i.business_id, &i.observation_id, &i.claim_id]
        .into_iter()
        .chain(i.derived_from_judgment_id.iter())
    {
        s.id("issue", v);
    }
    s.ts("issue.created_at", &i.created_at);
    for f in &p.facts {
        s.header("fact", &f.schema, f.schema_version, FACT_SCHEMA_V1);
        s.id("fact.id", &f.id);
        s.id("fact.business_id", &f.business_id);
        if f.version < 1 {
            s.0.push("fact.version < 1".into());
        }
        s.ts("fact.valid_from", &f.valid_from);
        if let Some(until) = &f.valid_until {
            s.ts("fact.valid_until", until);
        }
        s.ts("fact.created_at", &f.created_at);
    }
    s.observation(&p.original_observation);
    p.reobservation_observations
        .iter()
        .for_each(|o| s.observation(o));
    p.claims
        .iter()
        .chain(p.reobservation_claims.iter())
        .for_each(|c| s.claim(c));
    p.judgments
        .iter()
        .chain(p.reobservation_judgments.iter())
        .for_each(|j| s.judgment(j));
    for iv in &p.interventions {
        s.header(
            "intervention",
            &iv.schema,
            iv.schema_version,
            INTERVENTION_SCHEMA_V1,
        );
        s.id("intervention.id", &iv.id);
        iv.issue_ids
            .iter()
            .for_each(|v| s.id("intervention.issue_ids", v));
        s.ts("intervention.performed_at", &iv.performed_at);
        s.ts("intervention.created_at", &iv.created_at);
        s.knowledge_digest(
            "intervention.evidence_before_digest",
            &iv.evidence_before_digest,
        );
        s.knowledge_digest(
            "intervention.evidence_after_digest",
            &iv.evidence_after_digest,
        );
    }
    for r in &p.reobservations {
        s.header(
            "reobservation",
            &r.schema,
            r.schema_version,
            REOBSERVATION_SCHEMA_V1,
        );
        s.id("reobservation.id", &r.id);
        s.ts("reobservation.created_at", &r.created_at);
        s.signature(&r.before_signature);
        s.signature(&r.after_signature);
    }
    if s.0.is_empty() {
        Ok(())
    } else {
        Err(PacketError::new("SchemaViolation", s.0.join("; ")))
    }
}

fn require(cond: bool, reason: &'static str, detail: &str) -> Result<(), PacketError> {
    if cond {
        Ok(())
    } else {
        Err(PacketError::new(reason, detail))
    }
}

fn unique<'a>(ids: impl Iterator<Item = &'a String>, what: &str) -> Result<(), PacketError> {
    let mut seen = HashSet::new();
    for id in ids {
        require(seen.insert(id), "DuplicateId", what)?;
    }
    Ok(())
}

fn check_judgment_chain_linear(js: &[JudgmentV1]) -> Result<(), PacketError> {
    if js.is_empty() {
        return Ok(());
    }
    use std::collections::HashMap;
    let by_id: HashMap<&str, &JudgmentV1> = js.iter().map(|j| (j.id.as_str(), j)).collect();
    for j in js {
        if let Some(s) = &j.supersedes_id {
            if s == &j.id {
                return Err(PacketError::new("InvalidJudgmentSupersession", &j.id));
            }
            let target = by_id.get(s.as_str());
            match target {
                None => return Err(PacketError::new("DanglingReference", &j.id)),
                Some(t) if t.claim_id != j.claim_id => {
                    return Err(PacketError::new("DanglingReference", &j.id))
                }
                _ => {}
            }
        }
    }
    let mut children: HashMap<&str, usize> = HashMap::new();
    for j in js {
        if let Some(s) = &j.supersedes_id {
            let n = children.get(s.as_str()).copied().unwrap_or(0) + 1;
            children.insert(s.as_str(), n);
            if n > 1 {
                return Err(PacketError::new("InvalidJudgmentSupersession", s));
            }
        }
    }
    let superseded: HashSet<&str> = js
        .iter()
        .filter_map(|j| j.supersedes_id.as_deref())
        .collect();
    let heads: Vec<&JudgmentV1> = js
        .iter()
        .filter(|j| !superseded.contains(j.id.as_str()))
        .collect();
    if heads.len() != 1 {
        return Err(PacketError::new(
            "InvalidJudgmentSupersession",
            format!("heads:{}", heads.len()),
        ));
    }
    let mut visited: HashSet<&str> = HashSet::new();
    let mut cur: Option<&JudgmentV1> = Some(heads[0]);
    while let Some(c) = cur {
        if !visited.insert(c.id.as_str()) {
            return Err(PacketError::new("InvalidJudgmentSupersession", &c.id));
        }
        cur = c
            .supersedes_id
            .as_deref()
            .and_then(|s| by_id.get(s).copied());
    }
    require(
        visited.len() == js.len(),
        "InvalidJudgmentSupersession",
        "disconnected",
    )?;
    Ok(())
}

fn check_judgment_groups_linear(js: &[JudgmentV1]) -> Result<(), PacketError> {
    use std::collections::HashMap;
    let mut by_claim: HashMap<&str, Vec<&JudgmentV1>> = HashMap::new();
    for j in js {
        by_claim.entry(j.claim_id.as_str()).or_default().push(j);
    }
    for group in by_claim.values() {
        let owned: Vec<JudgmentV1> = group.iter().map(|j| (*j).clone()).collect();
        check_judgment_chain_linear(&owned)?;
    }
    Ok(())
}

fn check_intervention_chain_linear(items: &[InterventionV1]) -> Result<(), PacketError> {
    if items.len() <= 1 {
        if let Some(i) = items.first() {
            if i.supersedes_id.as_deref() == Some(i.id.as_str()) {
                return Err(PacketError::new("InvalidInterventionSupersession", &i.id));
            }
        }
        return Ok(());
    }
    use std::collections::HashMap;
    let by_id: HashMap<&str, &InterventionV1> = items.iter().map(|i| (i.id.as_str(), i)).collect();
    for i in items {
        if let Some(s) = &i.supersedes_id {
            if s == &i.id {
                return Err(PacketError::new("InvalidInterventionSupersession", &i.id));
            }
            require(by_id.contains_key(s.as_str()), "DanglingReference", &i.id)?;
        }
    }
    let mut children: HashMap<&str, usize> = HashMap::new();
    for i in items {
        if let Some(s) = &i.supersedes_id {
            let n = children.get(s.as_str()).copied().unwrap_or(0) + 1;
            children.insert(s.as_str(), n);
            if n > 1 {
                return Err(PacketError::new("InvalidInterventionSupersession", s));
            }
        }
    }
    let superseded: HashSet<&str> = items
        .iter()
        .filter_map(|i| i.supersedes_id.as_deref())
        .collect();
    let heads: Vec<&InterventionV1> = items
        .iter()
        .filter(|i| !superseded.contains(i.id.as_str()))
        .collect();
    if heads.len() != 1 {
        return Err(PacketError::new(
            "InvalidInterventionSupersession",
            format!("heads:{}", heads.len()),
        ));
    }
    let mut visited: HashSet<&str> = HashSet::new();
    let mut cur: Option<&InterventionV1> = Some(heads[0]);
    while let Some(c) = cur {
        if !visited.insert(c.id.as_str()) {
            return Err(PacketError::new("InvalidInterventionSupersession", &c.id));
        }
        cur = c
            .supersedes_id
            .as_deref()
            .and_then(|s| by_id.get(s).copied());
    }
    require(
        visited.len() == items.len(),
        "InvalidInterventionSupersession",
        "disconnected",
    )?;
    Ok(())
}

fn check_references(p: &EvidencePacketV1) -> Result<(), PacketError> {
    let biz = &p.business.id;
    let observations: Vec<&ObservationV1> = std::iter::once(&p.original_observation)
        .chain(p.reobservation_observations.iter())
        .collect();
    let mut owned: Vec<(&String, &String)> = vec![(&p.issue.business_id, &p.issue.id)];
    owned.extend(p.facts.iter().map(|x| (&x.business_id, &x.id)));
    owned.extend(observations.iter().map(|x| (&x.business_id, &x.id)));
    owned.extend(p.claims.iter().map(|x| (&x.business_id, &x.id)));
    owned.extend(p.judgments.iter().map(|x| (&x.business_id, &x.id)));
    owned.extend(p.interventions.iter().map(|x| (&x.business_id, &x.id)));
    owned.extend(p.reobservations.iter().map(|x| (&x.business_id, &x.id)));
    owned.extend(
        p.reobservation_claims
            .iter()
            .map(|x| (&x.business_id, &x.id)),
    );
    owned.extend(
        p.reobservation_judgments
            .iter()
            .map(|x| (&x.business_id, &x.id)),
    );
    for (b, id) in owned {
        require(b == biz, "CrossTenantReference", id)?;
    }
    for o in &observations {
        require(
            o.measurement.business_id == *biz,
            "CrossTenantReference",
            &o.id,
        )?;
    }

    unique(p.facts.iter().map(|x| &x.id), "facts")?;
    unique(observations.iter().map(|x| &x.id), "observations")?;
    unique(
        p.claims
            .iter()
            .chain(&p.reobservation_claims)
            .map(|x| &x.id),
        "claims",
    )?;
    unique(
        p.judgments
            .iter()
            .chain(&p.reobservation_judgments)
            .map(|x| &x.id),
        "judgments",
    )?;
    unique(p.interventions.iter().map(|x| &x.id), "interventions")?;
    unique(p.reobservations.iter().map(|x| &x.id), "reobservations")?;

    let fact_ids: HashSet<&str> = p.facts.iter().map(|f| f.id.as_str()).collect();
    let claim_ids: HashSet<&str> = p.claims.iter().map(|c| c.id.as_str()).collect();
    let re_claim_ids: HashSet<&str> = p
        .reobservation_claims
        .iter()
        .map(|c| c.id.as_str())
        .collect();
    let re_obs_ids: HashSet<&str> = p
        .reobservation_observations
        .iter()
        .map(|o| o.id.as_str())
        .collect();
    let intervention_ids: HashSet<&str> = p.interventions.iter().map(|i| i.id.as_str()).collect();
    let original_id = p.original_observation.id.as_str();

    require(
        p.issue.observation_id == original_id,
        "DanglingReference",
        "issue.observation_id",
    )?;
    require(
        claim_ids.contains(p.issue.claim_id.as_str()),
        "DanglingReference",
        "issue.claim_id",
    )?;
    for c in &p.claims {
        require(c.observation_id == original_id, "DanglingReference", &c.id)?;
    }
    for c in &p.reobservation_claims {
        require(
            re_obs_ids.contains(c.observation_id.as_str()),
            "DanglingReference",
            &c.id,
        )?;
    }
    let check_judgments = |js: &[JudgmentV1], owners: &HashSet<&str>| -> Result<(), PacketError> {
        for j in js {
            require(
                owners.contains(j.claim_id.as_str()),
                "DanglingReference",
                &j.id,
            )?;
            for f in &j.fact_ids {
                require(fact_ids.contains(f.as_str()), "DanglingReference", &j.id)?;
            }
            if let Some(s) = &j.supersedes_id {
                require(
                    js.iter().any(|o| &o.id == s && o.claim_id == j.claim_id),
                    "DanglingReference",
                    &j.id,
                )?;
            }
        }
        Ok(())
    };
    check_judgments(&p.judgments, &claim_ids)?;
    check_judgments(&p.reobservation_judgments, &re_claim_ids)?;
    check_judgment_groups_linear(&p.judgments)?;
    check_judgment_groups_linear(&p.reobservation_judgments)?;
    check_intervention_chain_linear(&p.interventions)?;
    for f in &p.facts {
        if let Some(s) = &f.supersedes_id {
            require(fact_ids.contains(s.as_str()), "DanglingReference", &f.id)?;
        }
    }
    for i in &p.interventions {
        require(
            i.issue_ids.contains(&p.issue.id),
            "DanglingReference",
            &i.id,
        )?;
        if let Some(s) = &i.supersedes_id {
            require(
                intervention_ids.contains(s.as_str()),
                "DanglingReference",
                &i.id,
            )?;
        }
        require(
            i.supersedes_id.is_none() == i.correction_reason.is_none(),
            "InvalidCorrection",
            &i.id,
        )?;
    }
    require(
        p.reobservations.len() == p.reobservation_observations.len(),
        "DanglingReference",
        "reobservation_observations",
    )?;
    for (r, o) in p.reobservations.iter().zip(&p.reobservation_observations) {
        require(r.observation_id == o.id, "DanglingReference", &r.id)?;
        if let Some(i) = &r.intervention_id {
            require(
                intervention_ids.contains(i.as_str()),
                "DanglingReference",
                &r.id,
            )?;
        }
    }
    Ok(())
}

/// Fail-closed reader: version, schema shape, digest, references, then full
/// re-derivation of every derived field. Never imports into any store.
pub fn validate_packet_value(value: &Value) -> Result<EvidencePacketV1, PacketError> {
    let object = value
        .as_object()
        .ok_or_else(|| PacketError::new("NotAnObject", "packet"))?;
    let schema = object.get("schema").and_then(Value::as_str);
    let version = object.get("schema_version").and_then(Value::as_u64);
    if schema != Some(PACKET_SCHEMA_V1) || version != Some(PROTOCOL_VERSION) {
        return Err(PacketError::new(
            "UnsupportedSchemaVersion",
            format!("{schema:?}@{version:?}"),
        ));
    }
    let packet: EvidencePacketV1 = serde_json::from_value(value.clone())
        .map_err(|e| PacketError::new("SchemaViolation", e.to_string()))?;
    check_shape(&packet)?;
    if packet_digest(value)? != packet.packet_digest {
        return Err(PacketError::new("DigestMismatch", &packet.id));
    }
    check_references(&packet)?;
    let rederived = assemble(&packet)?;
    let mut unsealed: Map<String, Value> = object.clone();
    unsealed.remove("packet_digest");
    let mut rederived_value = serde_json::to_value(&rederived)
        .map_err(|e| PacketError::new("SchemaViolation", e.to_string()))?;
    rederived_value
        .as_object_mut()
        .expect("packet object")
        .remove("packet_digest");
    let canon = |v: &Value| canonical_json(v).map_err(|e| PacketError::new("SchemaViolation", e));
    if canon(&rederived_value)? != canon(&Value::Object(unsealed))? {
        return Err(PacketError::new("DerivationMismatch", &packet.id));
    }
    Ok(packet)
}

pub fn validate_packet_bytes(bytes: &[u8]) -> Result<EvidencePacketV1, PacketError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|e| PacketError::new("NotJson", e.to_string()))?;
    validate_packet_value(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_surfaces_are_explicit() {
        let router = SurfaceIdentityV1::from_worker("9router", Some("pin"), None).unwrap();
        assert_eq!(router.kind, SurfaceKind::RouterApi);
        assert_eq!(router.gateway, KnowledgeString::Known("9router".into()));
        assert_eq!(router.requested_model, KnowledgeString::Known("pin".into()));
        assert_eq!(router.observed_model, KnowledgeString::Unknown);
        assert_eq!(router.requested_provider, KnowledgeString::Unknown);
        assert_eq!(router.search_mode, KnowledgeString::Unknown);
        let mock = SurfaceIdentityV1::from_worker("mock", None, None).unwrap();
        assert_eq!(mock.kind, SurfaceKind::Mock);
        assert_eq!(mock.search_mode, KnowledgeString::NotApplicable);
        assert!(SurfaceIdentityV1::from_worker("openai", None, None).is_err());
        for p in ["9router", "mock"] {
            let s = SurfaceIdentityV1::from_worker(p, Some("m"), Some("m")).unwrap();
            assert_ne!(s.kind, SurfaceKind::ConsumerUi);
        }
    }

    #[test]
    fn js_number_formatting_matches_ecmascript() {
        let cases = [
            (0.7, "0.7"),
            (1.5, "1.5"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (1.5e-10, "1.5e-10"),
            (123.456, "123.456"),
            (-2.25, "-2.25"),
        ];
        for (x, want) in cases {
            assert_eq!(js_number(x), want, "{x}");
        }
    }

    #[test]
    fn outcome_matrix() {
        use MatchClassification::*;
        use ObservedChange::*;
        use Verdict::*;
        assert_eq!(
            derive_outcome(Some(Contradicted), Some(Supported), ExactMatch, Changed),
            ObservedOutcome::ObservedCorrection
        );
        assert_eq!(
            derive_outcome(Some(Supported), Some(Contradicted), Comparable, Changed),
            ObservedOutcome::ObservedRegression
        );
        assert_eq!(
            derive_outcome(None, Some(Supported), ExactMatch, Changed),
            ObservedOutcome::Indeterminate
        );
        assert_eq!(
            derive_outcome(Some(Contradicted), Some(Supported), NotComparable, Changed),
            ObservedOutcome::Indeterminate
        );
    }
}
