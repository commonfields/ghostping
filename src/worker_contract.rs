//! Hosted worker contract v1 (stateless, no SQLite, no Postgres).
//! The TypeScript Effect worker spawns `ghostping-worker` with one job on
//! stdin and reads one result from stdout. Provider credentials come from
//! the environment, never from the job payload.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const JOB_CONTRACT_VERSION: &str = "ghostping-worker-job-v1";
pub const RESULT_CONTRACT_VERSION: &str = "ghostping-worker-result-v1";

#[derive(Debug, Clone, Deserialize)]
pub struct WorkerJob {
    pub contract_version: String,
    pub run_id: String,
    pub provider: String,
    pub model: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerCitation {
    pub uri: Option<String>,
    pub title: Option<String>,
    pub position: Option<i64>,
    pub attributed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerResult {
    pub contract_version: String,
    pub run_id: String,
    pub status: String,
    pub provider: String,
    pub requested_model: Option<String>,
    pub observed_model: Option<String>,
    pub collected_at: String,
    pub answer_text: Option<String>,
    pub retrieval_mode: String,
    pub citations: Vec<WorkerCitation>,
    pub raw_digest: String,
    pub raw_response: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_bytes_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<serde_json::Value>,
    pub failure_class: Option<String>,
    pub failure_detail_safe: Option<String>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Deterministic mock fixtures for CI/demo (never calls external providers).
/// Selection is prompt-driven so the Northstar demo yields:
/// cost question -> contradiction ($29 vs approved $39),
/// salesforce question -> supported (no integration),
/// cancellation question -> unknown/insufficient,
/// `__fail__` marker (or "FAIL_PROVIDER") -> provider failure.
fn mock_answer(prompt: &str) -> Option<String> {
    let p = prompt.to_lowercase();
    if p.contains("__wrong__") {
        return Some("Northstar costs $29/month.".to_string());
    }
    if p.contains("__supported__") {
        return Some("Northstar does not integrate with Salesforce.".to_string());
    }
    if p.contains("__unknown__") {
        return Some(
            "I don't have enough information about Northstar's cancellation policy.".to_string(),
        );
    }
    if p.contains("cost") || p.contains("price") || p.contains("much does northstar") {
        return Some("Northstar costs $29/month.".to_string());
    }
    if p.contains("salesforce") {
        return Some("Northstar does not integrate with Salesforce.".to_string());
    }
    if p.contains("cancellation") || p.contains("cancel") {
        return Some(
            "I'm not sure about Northstar's cancellation policy — I don't have reliable information."
                .to_string(),
        );
    }
    None
}

fn is_mock_failure(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    p.contains("__fail__") || p.contains("fail_provider")
}

pub fn execute_job(job: &WorkerJob) -> WorkerResult {
    let collected_at = now_rfc3339();
    if job.contract_version != JOB_CONTRACT_VERSION {
        return WorkerResult {
            contract_version: RESULT_CONTRACT_VERSION.to_string(),
            run_id: job.run_id.clone(),
            status: "failed".to_string(),
            provider: job.provider.clone(),
            requested_model: job.model.clone(),
            observed_model: None,
            collected_at,
            answer_text: None,
            retrieval_mode: "unknown".to_string(),
            citations: vec![],
            raw_digest: sha256_hex(b"contract-mismatch"),
            raw_response: serde_json::json!({"error": "unknown contract version"}),
            raw_bytes_hex: None,
            raw_content_type: None,
            provider_metadata: None,
            failure_class: Some("WORKER_CONTRACT_MISMATCH".to_string()),
            failure_detail_safe: Some(format!(
                "expected {}, got {}",
                JOB_CONTRACT_VERSION, job.contract_version
            )),
        };
    }
    if job.provider != "mock" && job.provider != crate::nine_router::NINE_ROUTER_PROVIDER {
        return WorkerResult {
            contract_version: RESULT_CONTRACT_VERSION.to_string(),
            run_id: job.run_id.clone(),
            status: "failed".to_string(),
            provider: job.provider.clone(),
            requested_model: job.model.clone(),
            observed_model: None,
            collected_at,
            answer_text: None,
            // UNKNOWN remains first-class: unconfigured providers report unknown, not fabricated.
            retrieval_mode: "unknown".to_string(),
            citations: vec![],
            raw_digest: sha256_hex(b"unsupported-provider"),
            raw_response: serde_json::json!({"error": "unsupported provider in hosted V1"}),
            raw_bytes_hex: None,
            raw_content_type: None,
            provider_metadata: None,
            failure_class: Some("WORKER_FAILED".to_string()),
            failure_detail_safe: Some(
                "only provider=mock,9router is enabled in Hosted V1".to_string(),
            ),
        };
    }
    if job.provider == crate::nine_router::NINE_ROUTER_PROVIDER {
        return crate::nine_router::execute_9router(job);
    }
    if is_mock_failure(&job.prompt) {
        let raw = serde_json::json!({
            "provider": "mock",
            "prompt": job.prompt,
            "error": "simulated provider failure",
        });
        let raw_bytes = serde_json::to_vec(&raw).unwrap_or_default();
        return WorkerResult {
            contract_version: RESULT_CONTRACT_VERSION.to_string(),
            run_id: job.run_id.clone(),
            status: "failed".to_string(),
            provider: "mock".to_string(),
            requested_model: job.model.clone(),
            observed_model: Some("mock-v1".to_string()),
            collected_at,
            answer_text: None,
            retrieval_mode: "unknown".to_string(),
            citations: vec![],
            raw_digest: sha256_hex(&raw_bytes),
            raw_response: raw,
            raw_bytes_hex: Some(hex::encode(&raw_bytes)),
            raw_content_type: Some("application/json".to_string()),
            provider_metadata: None,
            failure_class: Some("PROVIDER_UNAVAILABLE".to_string()),
            failure_detail_safe: Some(
                "mock simulated provider failure (safe detail only)".to_string(),
            ),
        };
    }
    let answer = mock_answer(&job.prompt).unwrap_or_else(|| {
        "I don't have enough information to answer that about Northstar.".to_string()
    });
    // Never fabricate citations: mock returns none.
    let raw = serde_json::json!({
        "provider": "mock",
        "model": "mock-v1",
        "prompt": job.prompt,
        "answer": answer,
        "retrieval_mode": "unknown",
        "citations": [],
    });
    let raw_bytes = serde_json::to_vec(&raw).unwrap_or_default();
    WorkerResult {
        contract_version: RESULT_CONTRACT_VERSION.to_string(),
        run_id: job.run_id.clone(),
        status: "succeeded".to_string(),
        provider: "mock".to_string(),
        requested_model: job.model.clone(),
        observed_model: Some("mock-v1".to_string()),
        collected_at,
        answer_text: Some(answer),
        retrieval_mode: "unknown".to_string(),
        citations: vec![],
        raw_digest: sha256_hex(&raw_bytes),
        raw_response: raw,
        raw_bytes_hex: Some(hex::encode(&raw_bytes)),
        raw_content_type: Some("application/json".to_string()),
        provider_metadata: Some(serde_json::json!({"synthetic": true})),
        failure_class: None,
        failure_detail_safe: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(prompt: &str) -> WorkerJob {
        WorkerJob {
            contract_version: JOB_CONTRACT_VERSION.to_string(),
            run_id: "RUN-1".to_string(),
            provider: "mock".to_string(),
            model: None,
            prompt: prompt.to_string(),
        }
    }

    #[test]
    fn wrong_fact_fixture() {
        let r = execute_job(&job("How much does Northstar cost? __wrong__"));
        assert_eq!(r.status, "succeeded");
        assert!(r.answer_text.unwrap().contains("$29"));
    }

    #[test]
    fn supported_fact_fixture() {
        let r = execute_job(&job("Does it integrate? __supported__"));
        assert_eq!(r.status, "succeeded");
        assert!(r.answer_text.unwrap().contains("does not integrate"));
    }

    #[test]
    fn unknown_fixture_preserves_unknown() {
        let r = execute_job(&job("policy? __unknown__"));
        assert_eq!(r.status, "succeeded");
        assert_eq!(r.retrieval_mode, "unknown");
        assert!(r.citations.is_empty());
    }

    #[test]
    fn failure_fixture_is_typed() {
        let r = execute_job(&job("boom __fail__"));
        assert_eq!(r.status, "failed");
        assert_eq!(r.failure_class.as_deref(), Some("PROVIDER_UNAVAILABLE"));
    }

    #[test]
    fn unknown_contract_version_is_mismatch() {
        let mut j = job("hi");
        j.contract_version = "nope".to_string();
        let r = execute_job(&j);
        assert_eq!(r.status, "failed");
        assert_eq!(r.failure_class.as_deref(), Some("WORKER_CONTRACT_MISMATCH"));
    }

    #[test]
    fn raw_digest_deterministic() {
        let a = execute_job(&job("How much does Northstar cost?"));
        let b = execute_job(&job("How much does Northstar cost?"));
        assert_eq!(a.raw_digest, b.raw_digest);
        let raw = hex::decode(a.raw_bytes_hex.expect("mock exact bytes")).expect("hex");
        assert_eq!(sha256_hex(&raw), a.raw_digest);
    }

    #[test]
    fn result_serializes_v1() {
        let r = execute_job(&job("How much does Northstar cost?"));
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["contract_version"], RESULT_CONTRACT_VERSION);
        assert_eq!(v["run_id"], "RUN-1");
    }

    #[test]
    fn non_mock_provider_fails_before_any_network_path() {
        // Hosted V1 supports ONLY provider=mock. openai/anthropic/gemini must
        // fail locally as unsupported — this test proves no network-capable
        // path exists for them (execute_job is pure; no HTTP client involved).
        for provider in ["openai", "anthropic", "gemini", "perplexity"] {
            let r = execute_job(&WorkerJob {
                contract_version: JOB_CONTRACT_VERSION.to_string(),
                run_id: "RUN-1".to_string(),
                provider: provider.to_string(),
                model: None,
                prompt: "How much does Northstar cost?".to_string(),
            });
            assert_eq!(r.status, "failed", "provider={provider}");
            assert!(r
                .failure_detail_safe
                .as_deref()
                .unwrap_or_default()
                .contains("only provider=mock"));
            let v = serde_json::to_value(&r).unwrap().to_string().to_lowercase();
            assert!(!v.contains("api_key"));
        }
    }

    #[test]
    fn no_key_in_job_or_result() {
        let r = execute_job(&job("How much does Northstar cost?"));
        let v = serde_json::to_value(&r).unwrap().to_string().to_lowercase();
        assert!(!v.contains("api_key"));
        assert!(!v.contains("api-key"));
        assert!(!v.contains("sk-"));
    }
}
