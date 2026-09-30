//! Cross-language worker-contract fixtures: the SAME golden JSON files under
//! tests/worker-contract/ must decode in Rust (serde) and TypeScript
//! (Effect Schema). No codegen in V1 — compatibility testing only.
use ghostping::worker_contract::{
    WorkerJob, WorkerResult, JOB_CONTRACT_VERSION, RESULT_CONTRACT_VERSION,
};
use std::path::PathBuf;

fn fixture(name: &str) -> String {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/worker-contract");
    std::fs::read_to_string(dir.join(name)).unwrap_or_else(|_| panic!("missing fixture {name}"))
}

#[test]
fn valid_job_fixture_decodes_in_rust() {
    let job: WorkerJob = serde_json::from_str(&fixture("job-v1.valid.json")).expect("job fixture");
    assert_eq!(job.contract_version, JOB_CONTRACT_VERSION);
    assert_eq!(job.run_id, "RUN-FIXTURE-1");
    assert_eq!(job.provider, "mock");
}

#[test]
fn valid_success_result_fixture_decodes_in_rust() {
    let r: WorkerResult =
        serde_json::from_str(&fixture("result-v1.success.json")).expect("success fixture");
    assert_eq!(r.contract_version, RESULT_CONTRACT_VERSION);
    assert_eq!(r.status, "succeeded");
    assert!(r.answer_text.unwrap().contains("$29"));
    assert_eq!(r.failure_class, None);
}

#[test]
fn valid_failure_result_fixture_decodes_in_rust() {
    let r: WorkerResult =
        serde_json::from_str(&fixture("result-v1.failure.json")).expect("failure fixture");
    assert_eq!(r.contract_version, RESULT_CONTRACT_VERSION);
    assert_eq!(r.status, "failed");
    assert_eq!(r.failure_class.as_deref(), Some("PROVIDER_UNAVAILABLE"));
}

#[test]
fn valid_9router_result_fixture_decodes_in_rust() {
    // provider=9router observations share result-v1 (no version bump): the
    // gateway is the provider field, resolved model is observed_model, and
    // usage/cost metadata rides inside the exact raw_response body.
    let r: WorkerResult =
        serde_json::from_str(&fixture("result-v1.9router.json")).expect("9router fixture");
    assert_eq!(r.contract_version, RESULT_CONTRACT_VERSION);
    assert_eq!(r.status, "succeeded");
    assert_eq!(r.provider, "9router");
    assert_eq!(r.requested_model.as_deref(), Some("oc/pinned-free-test"));
    assert_eq!(r.observed_model.as_deref(), Some("oc/pinned-free-test"));
    assert_eq!(r.retrieval_mode, "unknown");
    assert!(r.citations.is_empty());
    assert_eq!(r.raw_response["usage"]["total_tokens"], 30);
}

#[test]
fn unknown_contract_version_is_rejected_or_mismatch() {
    let mut v: serde_json::Value = serde_json::from_str(&fixture("job-v1.valid.json")).unwrap();
    v["contract_version"] = serde_json::Value::String("ghostping-worker-job-v99".to_string());
    let job: WorkerJob = serde_json::from_value(v).expect("shape still parses");
    let out = ghostping::worker_contract::execute_job(&job);
    assert_eq!(out.status, "failed");
    assert_eq!(
        out.failure_class.as_deref(),
        Some("WORKER_CONTRACT_MISMATCH")
    );
}

#[test]
fn wrong_field_type_is_rejected() {
    let mut v: serde_json::Value = serde_json::from_str(&fixture("job-v1.valid.json")).unwrap();
    v["run_id"] = serde_json::json!(42);
    assert!(serde_json::from_value::<WorkerJob>(v).is_err());
}

#[test]
fn missing_required_field_is_rejected() {
    let mut v: serde_json::Value =
        serde_json::from_str(&fixture("result-v1.success.json")).unwrap();
    v.as_object_mut().unwrap().remove("raw_digest");
    assert!(serde_json::from_value::<WorkerResult>(v).is_err());
}

#[test]
fn rust_result_output_matches_fixture_shape() {
    // execute_job output must serialize back into the same contract the
    // fixtures pin (contract_version + run_id + status + raw_digest).
    let job: WorkerJob = serde_json::from_str(&fixture("job-v1.valid.json")).unwrap();
    let out = ghostping::worker_contract::execute_job(&job);
    let v = serde_json::to_value(&out).unwrap();
    assert_eq!(v["contract_version"], RESULT_CONTRACT_VERSION);
    assert_eq!(v["run_id"], "RUN-FIXTURE-1");
    assert_eq!(v["status"], "succeeded");
    assert!(v["raw_digest"].as_str().is_some());
}
