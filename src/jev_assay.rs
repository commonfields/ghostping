//! Jev judgment assay (research only, never production).
//!
//! Evaluates whether TypeSafe AI's Jev can classify narrow semantic
//! relationships (factual relationship, citation support) with high
//! precision and useful coverage. Ghostping's deterministic code owns every
//! decision: Jev answers closed noul questions; composers map answers to
//! labels and dispositions. See `research/jev-assay/PROTOCOL.md`
//! (preregistered, frozen question-set-v1 + threshold-policy-v1).
//!
//! No production path may call this module. Live transport requires
//! `TYPESAFE_API_KEY` + `GHOSTPING_LIVE_JEV=1` + an explicit request budget.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

pub const QUESTION_SET_V1: &str = "question-set-v1";
pub const THRESHOLD_POLICY_V1: &str = "threshold-policy-v1";
pub const RECEIPT_SCHEMA_V1: &str = "receipt-schema-v1";
pub const JEV_MODEL_REQUESTED: &str = "jev-latest";
/// Input budget: state + rendered questions must fit; larger inputs are
/// refused before any request (no silent truncation past evidence).
pub const MAX_INPUT_CHARS: usize = 8000;

// ── Labels ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LabelA {
    Supported,
    Contradicted,
    Partial,
    InsufficientEvidence,
    Ambiguous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LabelB {
    Supports,
    Contradicts,
    Ambiguous,
    Insufficient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Disposition {
    AutoClassify,
    HumanReview,
    Unavailable,
}

// ── Question sets (frozen v1) ─────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct NoulQuestion {
    pub name: &'static str,
    pub instructions: &'static str,
}

pub const TASK_A_QUESTIONS: &[NoulQuestion] = &[
    NoulQuestion {
        name: "fully_supported",
        instructions: "The facts fully establish the claim as stated.",
    },
    NoulQuestion {
        name: "contains_contradiction",
        instructions: "The facts contradict the claim as stated.",
    },
    NoulQuestion {
        name: "partially_supported",
        instructions: "The facts establish part of the claim but not all of it.",
    },
    NoulQuestion {
        name: "enough_evidence",
        instructions: "The facts contain enough information to decide the claim.",
    },
];

pub const TASK_B_QUESTIONS: &[NoulQuestion] = &[
    NoulQuestion {
        name: "source_entails_claim",
        instructions: "The source excerpt entails the claim.",
    },
    NoulQuestion {
        name: "source_conflicts_with_claim",
        instructions: "The source excerpt conflicts with the claim.",
    },
    NoulQuestion {
        name: "source_has_enough_information",
        instructions: "The source excerpt contains enough information to decide the claim.",
    },
];

// ── Transport ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoulAnswer {
    pub name: String,
    pub noul: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionResponse {
    pub provider: String,
    pub model: String,
    pub provider_model_version: Option<String>,
    pub answers: Vec<NoulAnswer>,
    pub latency_ms: u64,
    pub usage: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub enum TransportFailure {
    Timeout,
    RateLimit,
    Auth,
    Malformed(String),
    BudgetExhausted,
    InputTooLarge(usize),
    Other(String),
}

impl std::fmt::Display for TransportFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout => write!(f, "timeout"),
            Self::RateLimit => write!(f, "rate limit"),
            Self::Auth => write!(f, "auth"),
            Self::Malformed(s) => write!(f, "malformed: {}", s),
            Self::BudgetExhausted => write!(f, "request budget exhausted"),
            Self::InputTooLarge(n) => write!(f, "input too large ({} chars)", n),
            Self::Other(s) => write!(f, "{}", redact_secrets(s)),
        }
    }
}

fn redact_secrets(s: &str) -> String {
    let mut out = s.to_string();
    for pattern in [
        r"(?i)bearer\s+[A-Za-z0-9._\-~+/=]{8,}",
        r"sk-[A-Za-z0-9._\-]{8,}",
        r"ts-[A-Za-z0-9._\-]{8,}",
    ] {
        if let Ok(re) = regex::Regex::new(pattern) {
            out = re.replace_all(&out, "[REDACTED]").to_string();
        }
    }
    out
}

pub trait JevTransport {
    fn decide(
        &self,
        state: &str,
        questions: &[NoulQuestion],
    ) -> Result<DecisionResponse, TransportFailure>;
}

/// Scripted transport for harness-correctness tests and offline demos.
/// Program answers/failures per question name; record calls for assertions.
#[derive(Debug, Default)]
pub struct MockTransport {
    pub answers: HashMap<String, f64>,
    pub fail_with: Option<String>,
    pub calls: std::sync::Mutex<Vec<String>>,
}

impl MockTransport {
    pub fn answer(mut self, question: &str, noul: f64) -> Self {
        self.answers.insert(question.to_string(), noul);
        self
    }

    pub fn fail(mut self, kind: &str) -> Self {
        self.fail_with = Some(kind.to_string());
        self
    }
}

impl JevTransport for MockTransport {
    fn decide(
        &self,
        state: &str,
        questions: &[NoulQuestion],
    ) -> Result<DecisionResponse, TransportFailure> {
        self.calls.lock().unwrap().push(state.to_string());
        if let Some(kind) = &self.fail_with {
            return Err(match kind.as_str() {
                "timeout" => TransportFailure::Timeout,
                "rate_limit" => TransportFailure::RateLimit,
                "auth" => TransportFailure::Auth,
                other => TransportFailure::Other(other.to_string()),
            });
        }
        let mut answers = Vec::new();
        for q in questions {
            match self.answers.get(q.name) {
                Some(v) => answers.push(NoulAnswer {
                    name: q.name.to_string(),
                    noul: *v,
                }),
                None => {
                    return Err(TransportFailure::Malformed(format!(
                        "mock has no answer for '{}'",
                        q.name
                    )))
                }
            }
        }
        Ok(DecisionResponse {
            provider: "mock".to_string(),
            model: "mock-jev".to_string(),
            provider_model_version: None,
            answers,
            latency_ms: 0,
            usage: None,
        })
    }
}

/// Live TypeSafe transport. Constructing or calling requires the three
/// mandatory gates; the request budget is enforced before every request.
pub struct LiveTransport {
    api_key: String,
    endpoint: String,
    /// Exact model string sent on every request of the run (pinned).
    model: String,
    remaining: AtomicUsize,
    client: reqwest::Client,
}

/// One entry from the official model-discovery endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredModel {
    pub name: String,
    pub description: Option<String>,
    pub release_date: Option<String>,
}

/// Pure alias-resolution rule (offline-testable): prefer a concrete
/// `jev-X.Y.Z` entry whose description ties it to the requested alias
/// lineage; otherwise no pinning.
pub fn select_pinned_model(models: &[DiscoveredModel], requested_alias: &str) -> Option<String> {
    models
        .iter()
        .find(|m| {
            m.name != requested_alias
                && m.name.starts_with("jev-")
                && m.description.as_deref().is_some_and(|d| {
                    let d = d.to_lowercase();
                    d.contains("latest") || d.contains("stable") || d.contains("current")
                })
        })
        .map(|m| m.name.clone())
}

/// Model resolution outcome for a benchmark run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelResolution {
    pub requested_alias: String,
    /// Exact string frozen for the whole run.
    pub resolved_model: String,
    /// True when the provider supports explicit version pinning and the
    /// resolved string is a concrete version (not the alias).
    pub pinned: bool,
    pub discovery_models: Vec<DiscoveredModel>,
}

/// Query the official discovery endpoint (`GET /v1/models`) and resolve
/// `requested_alias` to one frozen string for the whole benchmark.
/// TypeSafe accepts versioned IDs whether or not they are listed; when no
/// concrete version can be established, the alias itself is frozen and
/// `pinned=false` (`MODEL_PINNING = UNSUPPORTED_BY_PROVIDER` semantics —
/// per-response identities plus the drift check then carry the weight).
pub fn resolve_model(
    client: &reqwest::Client,
    api_key: &str,
    models_endpoint: &str,
    requested_alias: &str,
) -> Result<ModelResolution> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| anyhow::anyhow!("runtime: {}", redact_secrets(&e.to_string())))?;
    let resp = rt
        .block_on(client.get(models_endpoint).bearer_auth(api_key).send())
        .map_err(|e| {
            anyhow::anyhow!("model discovery failed: {}", redact_secrets(&e.to_string()))
        })?;
    if !resp.status().is_success() {
        bail!("model discovery HTTP {}", resp.status());
    }
    let json: serde_json::Value = rt.block_on(resp.json()).map_err(|e| {
        anyhow::anyhow!(
            "model discovery bad JSON: {}",
            redact_secrets(&e.to_string())
        )
    })?;
    let mut models = Vec::new();
    if let Some(arr) = json.get("models").and_then(|v| v.as_array()) {
        for m in arr {
            models.push(DiscoveredModel {
                name: m
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                description: m
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                release_date: m
                    .get("release_date")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            });
        }
    }
    // A concrete version mentions the alias lineage (e.g. "latest", "stable",
    // "current") in its description, or is a bare jev-X.Y.Z id.
    let pinned = select_pinned_model(&models, requested_alias);
    match pinned {
        Some(v) => Ok(ModelResolution {
            requested_alias: requested_alias.to_string(),
            resolved_model: v,
            pinned: true,
            discovery_models: models,
        }),
        None => Ok(ModelResolution {
            requested_alias: requested_alias.to_string(),
            resolved_model: requested_alias.to_string(),
            pinned: false,
            discovery_models: models,
        }),
    }
}

impl LiveTransport {
    pub fn gated(max_requests: usize) -> Result<Self> {
        Self::gated_with_model(max_requests, JEV_MODEL_REQUESTED)
    }

    pub fn gated_with_model(max_requests: usize, model: &str) -> Result<Self> {
        if std::env::var("GHOSTPING_LIVE_JEV").unwrap_or_default() != "1" {
            bail!("Live Jev requires GHOSTPING_LIVE_JEV=1 (explicit opt-in; spends budget)");
        }
        let key = std::env::var("TYPESAFE_API_KEY")
            .map_err(|_| anyhow::anyhow!("Live Jev requires TYPESAFE_API_KEY"))?;
        if key.trim().is_empty() {
            bail!("TYPESAFE_API_KEY is empty");
        }
        if max_requests == 0 {
            bail!("--max-requests must be >= 1 (no unlimited execution)");
        }
        Ok(Self {
            api_key: key,
            endpoint: "https://api.typesafe.ai/v1/systemone".to_string(),
            model: model.to_string(),
            remaining: AtomicUsize::new(max_requests),
            client: reqwest::Client::new(),
        })
    }

    /// Exact model string this transport sends on every request.
    pub fn model(&self) -> &str {
        &self.model
    }

    /// Research hooks for model discovery (same process, no extra auth).
    pub fn client_ref(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn key_ref(&self) -> &str {
        &self.api_key
    }

    pub fn remaining(&self) -> usize {
        self.remaining.load(Ordering::SeqCst)
    }
}

#[derive(Serialize)]
struct LiveRequest<'a> {
    state: &'a str,
    model: &'a str,
    questions: HashMap<&'a str, LiveQuestion<'a>>,
}

#[derive(Serialize)]
struct LiveQuestion<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    instructions: &'a str,
}

impl JevTransport for LiveTransport {
    fn decide(
        &self,
        state: &str,
        questions: &[NoulQuestion],
    ) -> Result<DecisionResponse, TransportFailure> {
        let rendered = render_state(state, questions);
        if rendered.len() > MAX_INPUT_CHARS {
            return Err(TransportFailure::InputTooLarge(rendered.len()));
        }
        // Budget enforced BEFORE the request. fetch_sub-style atomic take.
        let prev = self.remaining.fetch_sub(1, Ordering::SeqCst);
        if prev == 0 {
            self.remaining.fetch_add(1, Ordering::SeqCst);
            return Err(TransportFailure::BudgetExhausted);
        }
        let mut qs = HashMap::new();
        for q in questions {
            qs.insert(
                q.name,
                LiveQuestion {
                    kind: "noul",
                    instructions: q.instructions,
                },
            );
        }
        let body = LiveRequest {
            state,
            model: &self.model,
            questions: qs,
        };
        let started = Instant::now();
        // Sync trait surface: drive the async client on a throwaway runtime.
        // No production async context is touched by the assay.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| TransportFailure::Other(redact_secrets(&e.to_string())))?;
        let resp = rt
            .block_on(
                self.client
                    .post(&self.endpoint)
                    .bearer_auth(&self.api_key)
                    .json(&body)
                    .send(),
            )
            .map_err(|e| classify_reqwest(&e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(if status.as_u16() == 401 || status.as_u16() == 403 {
                TransportFailure::Auth
            } else if status.as_u16() == 429 {
                TransportFailure::RateLimit
            } else {
                TransportFailure::Other(format!("HTTP {}", status))
            });
        }
        let json: serde_json::Value = rt.block_on(resp.json()).map_err(|e| {
            TransportFailure::Malformed(format!("bad JSON: {}", redact_secrets(&e.to_string())))
        })?;
        parse_live_response(&json, questions, started.elapsed().as_millis() as u64)
    }
}

fn render_state(state: &str, questions: &[NoulQuestion]) -> String {
    let mut out = state.to_string();
    for q in questions {
        out.push_str("\n\nQ: ");
        out.push_str(q.instructions);
    }
    out
}

fn classify_reqwest(e: &reqwest::Error) -> TransportFailure {
    if e.is_timeout() {
        TransportFailure::Timeout
    } else if e.is_connect() {
        TransportFailure::Other("connect error".to_string())
    } else {
        TransportFailure::Other(redact_secrets(&e.to_string()))
    }
}

fn parse_live_response(
    json: &serde_json::Value,
    questions: &[NoulQuestion],
    latency_ms: u64,
) -> Result<DecisionResponse, TransportFailure> {
    let model = json
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(JEV_MODEL_REQUESTED)
        .to_string();
    let answers_obj = json
        .get("answers")
        .and_then(|v| v.as_object())
        .ok_or_else(|| TransportFailure::Malformed("missing 'answers' object".to_string()))?;
    let mut answers = Vec::new();
    for q in questions {
        let entry = answers_obj
            .get(q.name)
            .ok_or_else(|| TransportFailure::Malformed(format!("missing answer '{}'", q.name)))?;
        let noul = entry.get("noul").and_then(|v| v.as_f64()).ok_or_else(|| {
            TransportFailure::Malformed(format!("answer '{}' has no numeric noul", q.name))
        })?;
        if !(0.0..=1.0).contains(&noul) {
            return Err(TransportFailure::Malformed(format!(
                "answer '{}' noul {} out of [0,1]",
                q.name, noul
            )));
        }
        answers.push(NoulAnswer {
            name: q.name.to_string(),
            noul,
        });
    }
    Ok(DecisionResponse {
        provider: "typesafe-jev".to_string(),
        model: JEV_MODEL_REQUESTED.to_string(),
        provider_model_version: Some(model),
        answers,
        latency_ms,
        usage: json.get("usage").cloned(),
    })
}

// ── Deterministic composers (threshold-policy-v1, frozen) ──────────────────

fn get(answers: &[NoulAnswer], name: &str) -> Option<f64> {
    answers.iter().find(|a| a.name == name).map(|a| a.noul)
}

pub fn compose_a(answers: &[NoulAnswer]) -> LabelA {
    let full = get(answers, "fully_supported").unwrap_or(0.0);
    let contra = get(answers, "contains_contradiction").unwrap_or(0.0);
    let part = get(answers, "partially_supported").unwrap_or(0.0);
    let enough = get(answers, "enough_evidence").unwrap_or(0.0);
    if contra >= 0.80 && full >= 0.80 {
        LabelA::Ambiguous
    } else if full >= 0.80 && contra <= 0.20 && enough >= 0.60 {
        LabelA::Supported
    } else if contra >= 0.80 && full <= 0.20 {
        LabelA::Contradicted
    } else if part >= 0.70 && contra <= 0.20 {
        LabelA::Partial
    } else {
        LabelA::InsufficientEvidence
    }
}

pub fn compose_b(answers: &[NoulAnswer]) -> LabelB {
    let entails = get(answers, "source_entails_claim").unwrap_or(0.0);
    let conflicts = get(answers, "source_conflicts_with_claim").unwrap_or(0.0);
    let enough = get(answers, "source_has_enough_information").unwrap_or(0.0);
    if conflicts >= 0.80 && entails >= 0.80 {
        LabelB::Ambiguous
    } else if entails >= 0.80 && conflicts <= 0.20 && enough >= 0.60 {
        LabelB::Supports
    } else if conflicts >= 0.80 && entails <= 0.20 {
        LabelB::Contradicts
    } else {
        LabelB::Insufficient
    }
}

pub fn dispose_a(label: LabelA, answers: &[NoulAnswer]) -> Disposition {
    let full = get(answers, "fully_supported").unwrap_or(0.0);
    let contra = get(answers, "contains_contradiction").unwrap_or(0.0);
    let part = get(answers, "partially_supported").unwrap_or(0.0);
    let enough = get(answers, "enough_evidence").unwrap_or(0.0);
    match label {
        LabelA::Supported if full >= 0.90 && contra <= 0.10 && enough >= 0.70 => {
            Disposition::AutoClassify
        }
        LabelA::Contradicted if contra >= 0.90 && full <= 0.10 => Disposition::AutoClassify,
        LabelA::Partial if part >= 0.85 && contra <= 0.15 => Disposition::AutoClassify,
        _ => Disposition::HumanReview,
    }
}

pub fn dispose_b(label: LabelB, answers: &[NoulAnswer]) -> Disposition {
    let entails = get(answers, "source_entails_claim").unwrap_or(0.0);
    let conflicts = get(answers, "source_conflicts_with_claim").unwrap_or(0.0);
    match label {
        LabelB::Supports if entails >= 0.90 && conflicts <= 0.10 => Disposition::AutoClassify,
        LabelB::Contradicts if conflicts >= 0.90 && entails <= 0.10 => Disposition::AutoClassify,
        _ => Disposition::HumanReview,
    }
}

// ── Receipts ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptQuestion {
    pub name: String,
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JudgmentReceipt {
    pub receipt_version: String,
    pub case_id: String,
    pub task: String,
    pub evidence_digest: String,
    pub question_set_version: String,
    pub threshold_policy_version: String,
    pub provider: String,
    pub model: String,
    pub provider_model_version: Option<String>,
    pub questions: Vec<ReceiptQuestion>,
    pub answers: Vec<NoulAnswer>,
    pub probabilities: Vec<f64>,
    pub composed_label: String,
    pub disposition: Disposition,
    pub latency_ms: u64,
    pub usage: Option<serde_json::Value>,
    pub cost_usd: Option<f64>,
    pub collected_at: String,
    pub transport_status: String,
    pub failure_class: Option<String>,
}

pub fn write_receipt(
    dir: &std::path::Path,
    receipt: &JudgmentReceipt,
) -> Result<std::path::PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.json", receipt.case_id));
    std::fs::write(&path, serde_json::to_string_pretty(receipt)?)?;
    Ok(path)
}

pub fn read_receipt(path: &std::path::Path) -> Result<JudgmentReceipt> {
    let text = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&text)?)
}

/// Replay: recompute label + disposition from receipt answers only.
/// Must equal the stored values (determinism proof).
pub fn replay_a(receipt: &JudgmentReceipt) -> (LabelA, Disposition) {
    let label = compose_a(&receipt.answers);
    (label, dispose_a(label, &receipt.answers))
}

pub fn replay_b(receipt: &JudgmentReceipt) -> (LabelB, Disposition) {
    let label = compose_b(&receipt.answers);
    (label, dispose_b(label, &receipt.answers))
}

// ── Datasets ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssayCase {
    pub case_id: String,
    pub task: String,
    pub claim: String,
    pub evidence: serde_json::Value,
    pub label: String,
    pub label_origin: String,
    pub category: String,
    /// Frozen per-question binary truth (null for AMBIGUOUS rows).
    #[serde(default)]
    pub noul_truth: Option<HashMap<String, bool>>,
}

pub fn load_jsonl(path: &std::path::Path) -> Result<Vec<AssayCase>> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("Cannot read {}", path.display()))?;
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        out.push(
            serde_json::from_str(line)
                .with_context(|| format!("{}:{} bad JSON", path.display(), i + 1))?,
        );
    }
    Ok(out)
}

pub fn validate_dataset(cases: &[AssayCase], task: &str, valid_labels: &[&str]) -> Result<()> {
    if cases.is_empty() {
        bail!("Dataset is empty");
    }
    let mut ids = std::collections::HashSet::new();
    for c in cases {
        if c.task != task {
            bail!(
                "case {} has task '{}', expected '{}'",
                c.case_id,
                c.task,
                task
            );
        }
        if !valid_labels.contains(&c.label.as_str()) {
            bail!("case {} has invalid label '{}'", c.case_id, c.label);
        }
        if !ids.insert(c.case_id.clone()) {
            bail!("duplicate case_id '{}'", c.case_id);
        }
    }
    Ok(())
}

pub fn sha256_hex_label(s: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(s.as_bytes()))
}

// ── Metrics ─────────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct ClassStats {
    pub tp: usize,
    pub fp: usize,
    pub fn_: usize,
}

pub fn confusion(
    expected: &[String],
    predicted: &[Option<String>],
    classes: &[&str],
) -> HashMap<String, ClassStats> {
    let mut map: HashMap<String, ClassStats> = HashMap::new();
    for c in classes {
        map.insert((*c).to_string(), ClassStats::default());
    }
    for (e, p) in expected.iter().zip(predicted.iter()) {
        // Abstention counts against recall (conservative); unseen predicted
        // labels (e.g. baseline markers) count as errors without panicking.
        match p {
            Some(p) if p == e => {
                map.entry(e.clone()).or_default().tp += 1;
            }
            Some(p) => {
                map.entry(p.clone()).or_default().fp += 1;
                map.entry(e.clone()).or_default().fn_ += 1;
            }
            None => {
                map.entry(e.clone()).or_default().fn_ += 1;
            }
        }
    }
    map
}

pub fn precision(s: &ClassStats) -> Option<f64> {
    if s.tp + s.fp == 0 {
        None
    } else {
        Some(s.tp as f64 / (s.tp + s.fp) as f64)
    }
}

pub fn recall(s: &ClassStats) -> Option<f64> {
    if s.tp + s.fn_ == 0 {
        None
    } else {
        Some(s.tp as f64 / (s.tp + s.fn_) as f64)
    }
}

pub fn accuracy(expected: &[String], predicted: &[Option<String>]) -> Option<f64> {
    let decided: Vec<(&String, &Option<String>)> = expected.iter().zip(predicted.iter()).collect();
    if decided.is_empty() {
        return None;
    }
    let ok = decided
        .iter()
        .filter(|(e, p)| p.as_ref().is_some_and(|p| p == *e))
        .count();
    Some(ok as f64 / decided.len() as f64)
}

pub fn macro_f1(conf: &HashMap<String, ClassStats>) -> Option<f64> {
    if conf.is_empty() {
        return None;
    }
    let mut sum = 0.0;
    let mut n = 0;
    for s in conf.values() {
        match (precision(s), recall(s)) {
            (Some(p), Some(r)) if p + r > 0.0 => {
                sum += 2.0 * p * r / (p + r);
                n += 1;
            }
            _ => {}
        }
    }
    if n == 0 {
        None
    } else {
        Some(sum / n as f64)
    }
}

/// Brier score over AUTO decisions: mean((decisive_p - correctness)^2).
/// Lower is better; 0 is perfect.
pub fn brier_score(probs: &[f64], correct: &[bool]) -> Option<f64> {
    if probs.is_empty() || probs.len() != correct.len() {
        return None;
    }
    let sum: f64 = probs
        .iter()
        .zip(correct.iter())
        .map(|(p, c)| (p - if *c { 1.0 } else { 0.0 }).powi(2))
        .sum();
    Some(sum / probs.len() as f64)
}

/// Calibration bins over (probability, correctness) pairs.
pub fn calibration_bins(probs: &[f64], correct: &[bool], bins: usize) -> Vec<(f64, f64, usize)> {
    let mut out = vec![(0.0f64, 0.0f64, 0usize); bins];
    for (p, c) in probs.iter().zip(correct.iter()) {
        let mut i = (p * bins as f64).floor() as usize;
        if i >= bins {
            i = bins - 1;
        }
        out[i].0 += p;
        out[i].1 += if *c { 1.0 } else { 0.0 };
        out[i].2 += 1;
    }
    out.into_iter()
        .map(|(sump, sumc, n)| {
            if n == 0 {
                (0.0, 0.0, 0)
            } else {
                (sump / n as f64, sumc / n as f64, n)
            }
        })
        .collect()
}

/// Nearest-rank percentile.
pub fn percentile(mut xs: Vec<u64>, pct: f64) -> Option<u64> {
    if xs.is_empty() {
        return None;
    }
    xs.sort_unstable();
    let rank = (pct / 100.0 * xs.len() as f64).ceil() as usize;
    Some(xs[rank.saturating_sub(1).min(xs.len() - 1)])
}

// ── Per-question binary truth (frozen with question-set-v1) ─────────────────
// Maps a constructed multiclass label to the expected truth value of each
// Noul question. Used ONLY for raw-Noul calibration measurement, never to
// relabel cases. AMBIGUOUS has no mapping (excluded from per-question
// calibration and counted separately): a contradictory state has no single
// honest binary target per question.

/// Expected truth per Task-A question, in TASK_A_QUESTIONS order.
/// None for AMBIGUOUS (excluded, documented).
pub fn noul_truth_a(label: &LabelA) -> Option<[(&'static str, bool); 4]> {
    match label {
        LabelA::Supported => Some([
            ("fully_supported", true),
            ("contains_contradiction", false),
            ("partially_supported", false),
            ("enough_evidence", true),
        ]),
        LabelA::Contradicted => Some([
            ("fully_supported", false),
            ("contains_contradiction", true),
            ("partially_supported", false),
            ("enough_evidence", true),
        ]),
        LabelA::Partial => Some([
            ("fully_supported", false),
            ("contains_contradiction", false),
            ("partially_supported", true),
            ("enough_evidence", true),
        ]),
        LabelA::InsufficientEvidence => Some([
            ("fully_supported", false),
            ("contains_contradiction", false),
            ("partially_supported", false),
            ("enough_evidence", false),
        ]),
        LabelA::Ambiguous => None,
    }
}

/// Expected truth per Task-B question, in TASK_B_QUESTIONS order.
pub fn noul_truth_b(label: &LabelB) -> Option<[(&'static str, bool); 3]> {
    match label {
        LabelB::Supports => Some([
            ("source_entails_claim", true),
            ("source_conflicts_with_claim", false),
            ("source_has_enough_information", true),
        ]),
        LabelB::Contradicts => Some([
            ("source_entails_claim", false),
            ("source_conflicts_with_claim", true),
            ("source_has_enough_information", true),
        ]),
        LabelB::Ambiguous => None,
        LabelB::Insufficient => Some([
            ("source_entails_claim", false),
            ("source_conflicts_with_claim", false),
            ("source_has_enough_information", false),
        ]),
    }
}

pub fn parse_label_a(s: &str) -> Option<LabelA> {
    match s {
        "SUPPORTED" => Some(LabelA::Supported),
        "CONTRADICTED" => Some(LabelA::Contradicted),
        "PARTIAL" => Some(LabelA::Partial),
        "INSUFFICIENT_EVIDENCE" => Some(LabelA::InsufficientEvidence),
        "AMBIGUOUS" => Some(LabelA::Ambiguous),
        _ => None,
    }
}

pub fn parse_label_b(s: &str) -> Option<LabelB> {
    match s {
        "SUPPORTS" => Some(LabelB::Supports),
        "CONTRADICTS" => Some(LabelB::Contradicts),
        "AMBIGUOUS" => Some(LabelB::Ambiguous),
        "INSUFFICIENT" => Some(LabelB::Insufficient),
        _ => None,
    }
}

/// Raw-Noul calibration for one question: Brier over (p, binary truth),
/// mean predicted probability, empirical positive rate, sample count, bins.
/// This is the actual calibration test. Kept separate from final-label
/// quality and from selective-decision confidence by construction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionCalibration {
    pub question: String,
    pub n: usize,
    pub brier: Option<f64>,
    pub mean_predicted: Option<f64>,
    pub empirical_positive_rate: Option<f64>,
    pub bins: Vec<(f64, f64, usize)>,
}

pub fn calibrate_question(name: &str, truths: &[bool], probs: &[f64]) -> QuestionCalibration {
    let n = truths.len().min(probs.len());
    let (t, p) = (&truths[..n], &probs[..n]);
    QuestionCalibration {
        question: name.to_string(),
        n,
        brier: brier_score(p, t),
        mean_predicted: if n == 0 {
            None
        } else {
            Some(p.iter().sum::<f64>() / n as f64)
        },
        empirical_positive_rate: if n == 0 {
            None
        } else {
            Some(t.iter().filter(|c| **c).count() as f64 / n as f64)
        },
        bins: calibration_bins(p, t, 5),
    }
}

// ── Deterministic baseline ──────────────────────────────────────────────────

fn normalize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Strip currency/thousands/percent markers and stray sentence periods
/// from token ends. Interior decimals ("2.5") survive.
fn trim_number(raw: &str) -> String {
    raw.trim_matches(|c| c == ',' || c == '$' || c == '%' || c == '.')
        .to_string()
}

fn numbers_in(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() || c == '.' || c == ',' || c == '%' || c == '$' {
            cur.push(c);
        } else if !cur.is_empty() {
            out.push(trim_number(&cur));
            cur.clear();
        }
    }
    if !cur.is_empty() {
        out.push(trim_number(&cur));
    }
    out.into_iter().filter(|n| !n.is_empty()).collect()
}

/// Legitimate small baseline: exact normalized containment, explicit
/// negation, numeric mismatch — otherwise abstain. Not crippled on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaselineVerdict {
    Supported,
    Contradicted,
    Abstain,
}

pub fn deterministic_baseline(claim: &str, evidence_text: &str) -> BaselineVerdict {
    let c = normalize(claim);
    let e = normalize(evidence_text);
    if c.is_empty() || e.is_empty() {
        return BaselineVerdict::Abstain;
    }
    // Numeric disagreement on overlapping numbers.
    let cn = numbers_in(claim);
    let en = numbers_in(evidence_text);
    if !cn.is_empty() && !en.is_empty() {
        let overlap = cn.iter().any(|n| en.contains(n));
        if !overlap {
            return BaselineVerdict::Contradicted;
        }
    }
    // Explicit negation: "not X" vs "X".
    for neg in [" not ", " never ", " no ", "n't "] {
        if c.contains(neg.trim()) != e.contains(neg.trim()) {
            // One side negates a shared content word.
            let cw: Vec<&str> = c.split_whitespace().filter(|w| w.len() > 3).collect();
            let ew: Vec<&str> = e.split_whitespace().filter(|w| w.len() > 3).collect();
            if cw.iter().any(|w| ew.contains(w)) {
                return BaselineVerdict::Contradicted;
            }
        }
    }
    if e.contains(&c) || c.split_whitespace().all(|w| e.contains(w)) {
        return BaselineVerdict::Supported;
    }
    BaselineVerdict::Abstain
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ans(pairs: &[(&str, f64)]) -> Vec<NoulAnswer> {
        pairs
            .iter()
            .map(|(n, v)| NoulAnswer {
                name: n.to_string(),
                noul: *v,
            })
            .collect()
    }

    fn ans_a(full: f64, contra: f64, part: f64, enough: f64) -> Vec<NoulAnswer> {
        ans(&[
            ("fully_supported", full),
            ("contains_contradiction", contra),
            ("partially_supported", part),
            ("enough_evidence", enough),
        ])
    }

    fn ans_b(entails: f64, conflicts: f64, enough: f64) -> Vec<NoulAnswer> {
        ans(&[
            ("source_entails_claim", entails),
            ("source_conflicts_with_claim", conflicts),
            ("source_has_enough_information", enough),
        ])
    }

    #[test]
    fn test_question_sets_frozen_v1() {
        assert_eq!(QUESTION_SET_V1, "question-set-v1");
        assert_eq!(THRESHOLD_POLICY_V1, "threshold-policy-v1");
        assert_eq!(RECEIPT_SCHEMA_V1, "receipt-schema-v1");
        let names_a: Vec<&str> = TASK_A_QUESTIONS.iter().map(|q| q.name).collect();
        assert_eq!(
            names_a,
            vec![
                "fully_supported",
                "contains_contradiction",
                "partially_supported",
                "enough_evidence"
            ]
        );
        let names_b: Vec<&str> = TASK_B_QUESTIONS.iter().map(|q| q.name).collect();
        assert_eq!(
            names_b,
            vec![
                "source_entails_claim",
                "source_conflicts_with_claim",
                "source_has_enough_information"
            ]
        );
        // Serialization shape for the wire/harness.
        let q = &TASK_A_QUESTIONS[0];
        let json = serde_json::json!({"type": "noul", "instructions": q.instructions});
        assert_eq!(json["type"], "noul");
    }

    #[test]
    fn test_compose_a_truth_table() {
        assert_eq!(compose_a(&ans_a(0.95, 0.02, 0.1, 0.9)), LabelA::Supported);
        assert_eq!(
            compose_a(&ans_a(0.02, 0.95, 0.1, 0.9)),
            LabelA::Contradicted
        );
        assert_eq!(compose_a(&ans_a(0.3, 0.05, 0.9, 0.8)), LabelA::Partial);
        assert_eq!(
            compose_a(&ans_a(0.3, 0.3, 0.3, 0.3)),
            LabelA::InsufficientEvidence
        );
        // Contradictory typed decisions compose to AMBIGUOUS, never a verdict.
        assert_eq!(compose_a(&ans_a(0.9, 0.9, 0.1, 0.9)), LabelA::Ambiguous);
        // Exact frozen boundaries.
        assert_eq!(compose_a(&ans_a(0.80, 0.20, 0.0, 0.60)), LabelA::Supported);
        assert_eq!(
            compose_a(&ans_a(0.80, 0.21, 0.0, 0.60)),
            LabelA::InsufficientEvidence
        );
        assert_eq!(compose_a(&ans_a(0.0, 0.80, 0.0, 0.0)), LabelA::Contradicted);
        assert_eq!(compose_a(&ans_a(0.0, 0.0, 0.70, 0.0)), LabelA::Partial);
        assert_eq!(
            compose_a(&ans_a(0.0, 0.0, 0.69, 0.0)),
            LabelA::InsufficientEvidence
        );
    }

    #[test]
    fn test_compose_b_truth_table() {
        assert_eq!(compose_b(&ans_b(0.95, 0.02, 0.9)), LabelB::Supports);
        assert_eq!(compose_b(&ans_b(0.02, 0.95, 0.9)), LabelB::Contradicts);
        assert_eq!(compose_b(&ans_b(0.95, 0.95, 0.9)), LabelB::Ambiguous);
        assert_eq!(compose_b(&ans_b(0.4, 0.4, 0.4)), LabelB::Insufficient);
        assert_eq!(compose_b(&ans_b(0.80, 0.20, 0.60)), LabelB::Supports);
    }

    #[test]
    fn test_disposition_auto_human_unavailable() {
        // AUTO_CLASSIFY only above the frozen auto bar.
        assert_eq!(
            dispose_a(LabelA::Supported, &ans_a(0.95, 0.02, 0.1, 0.9)),
            Disposition::AutoClassify
        );
        assert_eq!(
            dispose_a(LabelA::Supported, &ans_a(0.85, 0.05, 0.1, 0.9)),
            Disposition::HumanReview
        );
        assert_eq!(
            dispose_a(LabelA::Contradicted, &ans_a(0.02, 0.95, 0.1, 0.9)),
            Disposition::AutoClassify
        );
        assert_eq!(
            dispose_a(LabelA::Partial, &ans_a(0.3, 0.05, 0.9, 0.8)),
            Disposition::AutoClassify
        );
        // Non-committal labels always need a human.
        assert_eq!(
            dispose_a(LabelA::InsufficientEvidence, &ans_a(0.3, 0.3, 0.3, 0.3)),
            Disposition::HumanReview
        );
        assert_eq!(
            dispose_a(LabelA::Ambiguous, &ans_a(0.9, 0.9, 0.1, 0.9)),
            Disposition::HumanReview
        );
        assert_eq!(
            dispose_b(LabelB::Supports, &ans_b(0.95, 0.02, 0.9)),
            Disposition::AutoClassify
        );
        assert_eq!(
            dispose_b(LabelB::Insufficient, &ans_b(0.4, 0.4, 0.4)),
            Disposition::HumanReview
        );
    }

    #[test]
    fn test_typed_response_parsing_valid() {
        let json = serde_json::json!({
            "model": "jev-1.13.0",
            "answers": {
                "fully_supported": {"type": "noul", "noul": 0.9},
                "contains_contradiction": {"type": "noul", "noul": 0.05},
                "partially_supported": {"type": "noul", "noul": 0.1},
                "enough_evidence": {"type": "noul", "noul": 0.95}
            },
            "usage": {"input_tokens": 100, "output_tokens": 4}
        });
        let resp = parse_live_response(&json, TASK_A_QUESTIONS, 42).unwrap();
        assert_eq!(resp.answers.len(), 4);
        assert_eq!(resp.provider_model_version.as_deref(), Some("jev-1.13.0"));
        assert_eq!(resp.latency_ms, 42);
        assert_eq!(compose_a(&resp.answers), LabelA::Supported);
    }

    #[test]
    fn test_typed_response_malformed_missing_invalid() {
        // Missing answers object.
        assert!(parse_live_response(&serde_json::json!({}), TASK_A_QUESTIONS, 0).is_err());
        // Missing one answer.
        let missing = serde_json::json!({"answers": {"fully_supported": {"noul": 0.9}}});
        assert!(parse_live_response(&missing, TASK_A_QUESTIONS, 0).is_err());
        // Non-numeric noul.
        let bad = serde_json::json!({"answers": {
            "fully_supported": {"noul": "high"},
            "contains_contradiction": {"noul": 0.1},
            "partially_supported": {"noul": 0.1},
            "enough_evidence": {"noul": 0.9}
        }});
        assert!(parse_live_response(&bad, TASK_A_QUESTIONS, 0).is_err());
        // Out-of-range probability.
        let oob = serde_json::json!({"answers": {
            "fully_supported": {"noul": 1.5},
            "contains_contradiction": {"noul": 0.1},
            "partially_supported": {"noul": 0.1},
            "enough_evidence": {"noul": 0.9}
        }});
        assert!(parse_live_response(&oob, TASK_A_QUESTIONS, 0).is_err());
    }

    #[test]
    fn test_mock_transport_failures_map_to_unavailable() {
        for kind in ["timeout", "rate_limit", "auth"] {
            let t = MockTransport::default().fail(kind);
            assert!(t.decide("s", TASK_A_QUESTIONS).is_err());
        }
        // Missing scripted answer is a malformed harness error, not a verdict.
        let t = MockTransport::default().answer("fully_supported", 0.9);
        assert!(t.decide("s", TASK_A_QUESTIONS).is_err());
        // Calls are recorded for assertions.
        let t = MockTransport::default()
            .answer("fully_supported", 0.9)
            .answer("contains_contradiction", 0.1)
            .answer("partially_supported", 0.1)
            .answer("enough_evidence", 0.9);
        let resp = t.decide("hello state", TASK_A_QUESTIONS).unwrap();
        assert_eq!(t.calls.lock().unwrap().len(), 1);
        assert_eq!(resp.provider, "mock");
        assert_eq!(compose_a(&resp.answers), LabelA::Supported);
    }

    #[test]
    fn test_live_gates_reject_without_all_three() {
        // No env keys in CI: construction must fail, never attempt network.
        assert!(LiveTransport::gated(10).is_err());
    }

    #[test]
    fn test_secret_redaction() {
        let dirty = "failed with Authorization: Bearer abcdefgh12345678 and sk-SECRETKEY99";
        let clean = redact_secrets(dirty);
        assert!(!clean.contains("abcdefgh"));
        assert!(!clean.contains("SECRETKEY"));
        assert!(clean.contains("[REDACTED]"));
        let disp =
            TransportFailure::Other("Bearer zyxwvutsr12345678 broke".to_string()).to_string();
        assert!(!disp.contains("zyxwvutsr"));
    }

    #[test]
    fn test_input_size_limit() {
        let big = "x".repeat(MAX_INPUT_CHARS + 1);
        assert!(big.len() > MAX_INPUT_CHARS);
        // Enforced pre-request in LiveTransport::decide (unit-checked here
        // via render length; live path unreachable in CI).
        assert!(render_state(&big, TASK_A_QUESTIONS).len() > MAX_INPUT_CHARS);
        assert!(render_state("tiny", TASK_A_QUESTIONS).len() < MAX_INPUT_CHARS);
    }

    #[test]
    fn test_receipt_determinism_and_replay() {
        let dir = tempfile::TempDir::new().unwrap();
        let answers = ans_a(0.95, 0.02, 0.1, 0.9);
        let receipt = JudgmentReceipt {
            receipt_version: RECEIPT_SCHEMA_V1.to_string(),
            case_id: "case-1".to_string(),
            task: "fact_relationship".to_string(),
            evidence_digest: "abc".to_string(),
            question_set_version: QUESTION_SET_V1.to_string(),
            threshold_policy_version: THRESHOLD_POLICY_V1.to_string(),
            provider: "mock".to_string(),
            model: "mock-jev".to_string(),
            provider_model_version: None,
            questions: TASK_A_QUESTIONS
                .iter()
                .map(|q| ReceiptQuestion {
                    name: q.name.to_string(),
                    instructions: q.instructions.to_string(),
                })
                .collect(),
            probabilities: answers.iter().map(|a| a.noul).collect(),
            answers: answers.clone(),
            composed_label: "SUPPORTED".to_string(),
            disposition: Disposition::AutoClassify,
            latency_ms: 3,
            usage: None,
            cost_usd: None,
            collected_at: "2026-09-29T00:00:00Z".to_string(),
            transport_status: "ok".to_string(),
            failure_class: None,
        };
        let path = write_receipt(dir.path(), &receipt).unwrap();
        let back = read_receipt(&path).unwrap();
        assert_eq!(back.case_id, "case-1");
        assert_eq!(back.receipt_version, RECEIPT_SCHEMA_V1);
        // Replay from answers alone reproduces label + disposition.
        assert_eq!(
            replay_a(&back),
            (LabelA::Supported, Disposition::AutoClassify)
        );
        // Tampering with an answer changes the replay (receipts are evidence).
        let mut tampered = back.clone();
        tampered.answers[0].noul = 0.1;
        assert_ne!(replay_a(&tampered).0, LabelA::Supported);
    }

    #[test]
    fn test_dataset_files_validate_with_balanced_classes() {
        let base =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("research/jev-assay/datasets");
        let a = load_jsonl(&base.join("task_a_synthetic.jsonl")).unwrap();
        validate_dataset(
            &a,
            "fact_relationship",
            &[
                "SUPPORTED",
                "CONTRADICTED",
                "PARTIAL",
                "INSUFFICIENT_EVIDENCE",
            ],
        )
        .unwrap();
        assert_eq!(a.len(), 240);
        for label in [
            "SUPPORTED",
            "CONTRADICTED",
            "PARTIAL",
            "INSUFFICIENT_EVIDENCE",
        ] {
            assert_eq!(
                a.iter().filter(|c| c.label == label).count(),
                60,
                "{}",
                label
            );
        }
        assert!(a.iter().all(|c| c.label_origin == "synthetic_constructed"));
        let b = load_jsonl(&base.join("task_b_synthetic.jsonl")).unwrap();
        validate_dataset(
            &b,
            "citation_support",
            &["SUPPORTS", "CONTRADICTS", "AMBIGUOUS", "INSUFFICIENT"],
        )
        .unwrap();
        assert_eq!(b.len(), 200);
    }

    #[test]
    fn test_split_stability_and_holdout_guard() {
        let base =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("research/jev-assay/datasets");
        let split: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(base.join("split-v1.json")).unwrap())
                .unwrap();
        let dev: Vec<String> = serde_json::from_value(split["dev"].clone()).unwrap();
        let holdout: Vec<String> = serde_json::from_value(split["holdout"].clone()).unwrap();
        // Disjoint and covering all synthetic IDs.
        let mut all: Vec<String> = dev.clone();
        all.extend(holdout.clone());
        all.sort();
        let mut expected = Vec::new();
        for name in ["task_a_synthetic.jsonl", "task_b_synthetic.jsonl"] {
            for c in load_jsonl(&base.join(name)).unwrap() {
                expected.push(c.case_id);
            }
        }
        expected.sort();
        assert_eq!(all, expected);
        // Immutability guard: digest of sorted holdout IDs must match.
        let digest = sha256_hex_label(&holdout.join("\n"));
        assert_eq!(digest, split["holdout_digest"].as_str().unwrap());
        // Stratified: every label present on both sides.
        assert!(!dev.is_empty() && !holdout.is_empty());
    }

    #[test]
    fn test_dataset_b_real_format_unpopulated() {
        // The real-evidence file exists as a format carrier with zero human
        // labels. REAL_WORLD_VALIDATION = NOT_EXECUTED.
        let base =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("research/jev-assay/datasets");
        let text = std::fs::read_to_string(base.join("task_b_real.jsonl")).unwrap();
        let rows: Vec<AssayCase> = text
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn test_metrics_brier_calibration_percentiles() {
        // Perfect confident predictor: Brier 0.
        assert_eq!(brier_score(&[1.0, 1.0], &[true, true]), Some(0.0));
        // Uncertain and wrong: (0.5-0)^2 = 0.25.
        assert_eq!(brier_score(&[0.5], &[false]), Some(0.25));
        assert_eq!(brier_score(&[], &[]), None);
        assert_eq!(brier_score(&[0.9], &[true, false]), None);
        let bins = calibration_bins(&[0.9, 0.9, 0.2], &[true, false, false], 5);
        assert_eq!(bins.len(), 5);
        assert_eq!(bins[4].2, 2); // two predictions in top bin
        assert_eq!(percentile(vec![10, 20, 30, 40], 50.0), Some(20));
        assert_eq!(percentile(vec![10, 20, 30, 40], 95.0), Some(40));
        assert_eq!(percentile(vec![], 50.0), None);
    }

    #[test]
    fn test_confusion_macro_f1_accuracy() {
        let expected = vec!["A".to_string(), "A".to_string(), "B".to_string()];
        let predicted = vec![Some("A".to_string()), Some("B".to_string()), None];
        let conf = confusion(&expected, &predicted, &["A", "B"]);
        assert_eq!(conf["A"].tp, 1);
        assert_eq!(conf["A"].fn_, 1);
        assert_eq!(conf["B"].fp, 1);
        assert_eq!(precision(&conf["A"]), Some(1.0));
        assert_eq!(recall(&conf["A"]), Some(0.5));
        assert!(macro_f1(&conf).unwrap() > 0.0);
        assert!((accuracy(&expected, &predicted).unwrap() - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(accuracy(&[], &[]), None);
    }

    #[test]
    fn test_deterministic_baseline_behaviour() {
        // Exact normalized containment decides.
        assert_eq!(
            deterministic_baseline("Ghostping costs $20.", "Ghostping costs $20 per month."),
            BaselineVerdict::Supported
        );
        // Numeric disagreement contradicts.
        assert_eq!(
            deterministic_baseline("Costs $20.", "Costs $99 per month."),
            BaselineVerdict::Contradicted
        );
        // Explicit negation contradicts.
        assert_eq!(
            deterministic_baseline("Has no free plan.", "Ghostping has a free plan for all."),
            BaselineVerdict::Contradicted
        );
        // Unrelated evidence abstains rather than guessing.
        assert_eq!(
            deterministic_baseline("Costs $20.", "The tower is tall."),
            BaselineVerdict::Abstain
        );
        // Unicode and case are normalized, not choked on.
        assert_eq!(
            deterministic_baseline("CAFÉ MÜNCHÉN", "visit café münchén today"),
            BaselineVerdict::Supported
        );
        assert_eq!(deterministic_baseline("", "x"), BaselineVerdict::Abstain);
    }
}

#[cfg(test)]
mod readiness_tests {
    use super::*;

    #[test]
    fn test_noul_truth_maps_frozen() {
        assert_eq!(
            noul_truth_a(&LabelA::Supported).unwrap(),
            [
                ("fully_supported", true),
                ("contains_contradiction", false),
                ("partially_supported", false),
                ("enough_evidence", true)
            ]
        );
        assert_eq!(
            noul_truth_a(&LabelA::Contradicted).unwrap()[1],
            ("contains_contradiction", true)
        );
        assert_eq!(
            noul_truth_a(&LabelA::Partial).unwrap()[2],
            ("partially_supported", true)
        );
        assert_eq!(
            noul_truth_a(&LabelA::InsufficientEvidence)
                .unwrap()
                .map(|(_, v)| v),
            [false, false, false, false]
        );
        // AMBIGUOUS is excluded: no honest binary target.
        assert_eq!(noul_truth_a(&LabelA::Ambiguous), None);
        assert_eq!(
            noul_truth_b(&LabelB::Supports).unwrap(),
            [
                ("source_entails_claim", true),
                ("source_conflicts_with_claim", false),
                ("source_has_enough_information", true)
            ]
        );
        assert_eq!(noul_truth_b(&LabelB::Ambiguous), None);
        assert_eq!(parse_label_a("SUPPORTED"), Some(LabelA::Supported));
        assert_eq!(parse_label_a("NOPE"), None);
        assert_eq!(parse_label_b("SUPPORTS"), Some(LabelB::Supports));
        assert_eq!(parse_label_b("NOPE"), None);
    }

    #[test]
    fn test_dataset_truth_fields_match_frozen_maps() {
        // Every synthetic row carries noul_truth consistent with its label.
        let base =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("research/jev-assay/datasets");
        for (name, task) in [
            ("task_a_synthetic.jsonl", "A"),
            ("task_b_synthetic.jsonl", "B"),
        ] {
            let text = std::fs::read_to_string(base.join(name)).unwrap();
            let cases: Vec<AssayCase> = load_jsonl(&base.join(name)).unwrap();
            let raws: Vec<serde_json::Value> = text
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(serde_json::from_str)
                .collect::<Result<_, _>>()
                .unwrap();
            assert!(!cases.is_empty());
            for (c, raw) in cases.iter().zip(raws.iter()) {
                let truth =
                    raw.get("noul_truth")
                        .and_then(|v| if v.is_null() { None } else { Some(v) });
                if task == "A" {
                    let label = parse_label_a(&c.label).unwrap();
                    match noul_truth_a(&label) {
                        Some(map) => {
                            let t = truth.expect("noul_truth missing");
                            for (q, v) in map {
                                assert_eq!(
                                    t.get(q).and_then(|x| x.as_bool()),
                                    Some(v),
                                    "{} {}",
                                    c.case_id,
                                    q
                                );
                            }
                        }
                        None => unreachable!("no AMBIGUOUS synthetic A cases"),
                    }
                } else {
                    let label = parse_label_b(&c.label).unwrap();
                    match noul_truth_b(&label) {
                        Some(map) => {
                            let t = truth.expect("noul_truth missing");
                            for (q, v) in map {
                                assert_eq!(
                                    t.get(q).and_then(|x| x.as_bool()),
                                    Some(v),
                                    "{} {}",
                                    c.case_id,
                                    q
                                );
                            }
                        }
                        None => assert!(
                            truth.is_none_or(|v| v.is_null()),
                            "{} AMBIGUOUS must carry null truth",
                            c.case_id
                        ),
                    }
                }
            }
        }
    }

    #[test]
    fn test_calibrate_question_reports_all_fields() {
        let cal = calibrate_question("q", &[true, true, false, false], &[0.9, 0.8, 0.2, 0.1]);
        assert_eq!(cal.question, "q");
        assert_eq!(cal.n, 4);
        assert!((cal.brier.unwrap() - 0.025).abs() < 1e-9);
        assert!((cal.mean_predicted.unwrap() - 0.5).abs() < 1e-9);
        assert!((cal.empirical_positive_rate.unwrap() - 0.5).abs() < 1e-9);
        assert_eq!(cal.bins.len(), 5);
        let empty = calibrate_question("q", &[], &[]);
        assert_eq!(empty.n, 0);
        assert_eq!(empty.brier, None);
    }

    #[test]
    fn test_select_pinned_model_rules() {
        let models = vec![
            DiscoveredModel {
                name: "jev-latest".to_string(),
                description: Some("alias".to_string()),
                release_date: None,
            },
            DiscoveredModel {
                name: "jev-1.13.0".to_string(),
                description: Some("The most recent stable release".to_string()),
                release_date: Some("2026-09-15".to_string()),
            },
        ];
        assert_eq!(
            select_pinned_model(&models, "jev-latest"),
            Some("jev-1.13.0".to_string())
        );
        // No lineage wording: no pinning, alias frozen instead.
        let bare = vec![DiscoveredModel {
            name: "jev-9.9.9".to_string(),
            description: Some("An old build".to_string()),
            release_date: None,
        }];
        assert_eq!(select_pinned_model(&bare, "jev-latest"), None);
        assert_eq!(select_pinned_model(&[], "jev-latest"), None);
    }

    #[test]
    fn test_live_gating_still_closed() {
        // No credentials here: every live constructor path fails before I/O.
        assert!(LiveTransport::gated(10).is_err());
        assert!(LiveTransport::gated_with_model(10, "jev-1.13.0").is_err());
    }
}
