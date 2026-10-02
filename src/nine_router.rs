//! Hosted 9Router adapter (exactly one pinned external model).
//!
//! Execution mode `provider=9router` calls a 9Router gateway over HTTPS
//! using its documented OpenAI-compatible shape:
//! `POST {base}/chat/completions` with `{model, messages, stream:false}`.
//!
//! Secrets come from the environment only (`NINE_ROUTER_API_KEY`), never
//! from the job payload. The exact response bytes are preserved as raw
//! evidence before any normalization; unknown metadata stays UNKNOWN
//! (observed_model None, retrieval unknown, citations never invented).
use crate::worker_contract::{
    now_rfc3339, sha256_hex, WorkerCitation, WorkerJob, WorkerResult, RESULT_CONTRACT_VERSION,
};

pub const NINE_ROUTER_PROVIDER: &str = "9router";

pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;

#[derive(Debug, Clone)]
pub struct NineRouterConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NineRouterConfigError {
    MissingModel,
    RefusesNonHttpsUrl,
}

impl std::fmt::Display for NineRouterConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NineRouterConfigError::MissingModel => write!(f, "NINE_ROUTER_MODEL is not set"),
            NineRouterConfigError::RefusesNonHttpsUrl => {
                write!(f, "refusing non-HTTPS 9Router URL outside localhost")
            }
        }
    }
}

/// Read adapter configuration from the environment. The API key is optional:
/// some gateways run without auth; when set it travels only in the
/// `Authorization` header, never in payloads, logs, or evidence.
pub fn config_from_env() -> Result<NineRouterConfig, NineRouterConfigError> {
    let base_url = std::env::var("NINE_ROUTER_BASE_URL")
        .unwrap_or_else(|_| "http://localhost:20128/v1".to_string());
    let api_key = std::env::var("NINE_ROUTER_API_KEY")
        .ok()
        .filter(|k| !k.is_empty());
    let model = std::env::var("NINE_ROUTER_MODEL")
        .ok()
        .filter(|m| !m.is_empty())
        .ok_or(NineRouterConfigError::MissingModel)?;
    let timeout_ms = std::env::var("NINE_ROUTER_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    let cfg = NineRouterConfig {
        base_url,
        api_key,
        model,
        timeout_ms,
    };
    check_url(&cfg)?;
    Ok(cfg)
}

/// HTTPS is required except for loopback (local gateway, local tests).
fn check_url(cfg: &NineRouterConfig) -> Result<(), NineRouterConfigError> {
    let lower = cfg.base_url.to_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    if lower.starts_with("http://localhost")
        || lower.starts_with("http://127.")
        || lower.starts_with("http://[::1]")
    {
        return Ok(());
    }
    Err(NineRouterConfigError::RefusesNonHttpsUrl)
}

fn failed(
    job: &WorkerJob,
    requested_model: Option<String>,
    raw: serde_json::Value,
    failure_class: &str,
    detail: &str,
) -> WorkerResult {
    let raw_bytes = serde_json::to_vec(&raw).unwrap_or_default();
    WorkerResult {
        contract_version: RESULT_CONTRACT_VERSION.to_string(),
        run_id: job.run_id.clone(),
        status: "failed".to_string(),
        provider: NINE_ROUTER_PROVIDER.to_string(),
        requested_model,
        observed_model: None,
        collected_at: now_rfc3339(),
        answer_text: None,
        retrieval_mode: "unknown".to_string(),
        citations: vec![],
        raw_digest: sha256_hex(&raw_bytes),
        raw_response: raw,
        raw_bytes_hex: Some(hex::encode(&raw_bytes)),
        raw_content_type: Some("application/json".to_string()),
        provider_metadata: None,
        failure_class: Some(failure_class.to_string()),
        failure_detail_safe: Some(detail.to_string()),
    }
}

fn config_failure(job: &WorkerJob, err: &NineRouterConfigError) -> WorkerResult {
    failed(
        job,
        job.model.clone(),
        serde_json::json!({"error": "9router misconfigured"}),
        "WORKER_FAILED",
        &err.to_string(),
    )
}

/// Resolve the exact pinned model to request. A job that names a different
/// model fails closed: one CheckRun configuration must never silently
/// measure an arbitrary model.
fn resolve_model(job: &WorkerJob, cfg: &NineRouterConfig) -> Result<String, Box<WorkerResult>> {
    match &job.model {
        Some(wanted) if wanted != &cfg.model => Err(Box::new(failed(
            job,
            Some(wanted.clone()),
            serde_json::json!({"error": "model pin mismatch"}),
            "WORKER_FAILED",
            "job model does not match NINE_ROUTER_MODEL pin",
        ))),
        Some(wanted) => Ok(wanted.clone()),
        None => Ok(cfg.model.clone()),
    }
}

pub async fn execute_9router_with(
    job: &WorkerJob,
    cfg: &NineRouterConfig,
    http: &reqwest::Client,
) -> WorkerResult {
    if let Err(e) = check_url(cfg) {
        return config_failure(job, &e);
    }
    let model = match resolve_model(job, cfg) {
        Ok(m) => m,
        Err(boxed) => return *boxed,
    };
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": job.prompt}],
        "stream": false,
    });
    let mut req = http.post(&url).json(&body);
    if let Some(key) = &cfg.api_key {
        req = req.bearer_auth(key);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_timeout() {
                return failed(
                    job,
                    Some(model.clone()),
                    serde_json::json!({"error": "9router timeout"}),
                    "PROVIDER_TIMEOUT",
                    "9router request timed out",
                );
            }
            return failed(
                job,
                Some(model.clone()),
                serde_json::json!({"error": "9router unreachable"}),
                "PROVIDER_UNAVAILABLE",
                "9router gateway unreachable",
            );
        }
    };
    let status = resp.status();
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(_) => {
            return failed(
                job,
                Some(model.clone()),
                serde_json::json!({"error": "9router unreadable response"}),
                "PROVIDER_UNAVAILABLE",
                "9router response could not be read",
            );
        }
    };
    let code = status.as_u16();
    if code == 401 || code == 403 {
        return failed(
            job,
            Some(model.clone()),
            serde_json::json!({"error": "9router auth rejected", "status": code}),
            "PROVIDER_AUTH",
            "9router rejected credentials",
        );
    }
    if code == 429 {
        return failed(
            job,
            Some(model.clone()),
            serde_json::json!({"error": "9router rate limited", "status": code}),
            "PROVIDER_RATE_LIMITED",
            "9router rate limited (429)",
        );
    }
    if !(200..300).contains(&code) {
        return failed(
            job,
            Some(model.clone()),
            serde_json::json!({"error": "9router gateway error", "status": code}),
            "PROVIDER_UNAVAILABLE",
            "9router gateway error",
        );
    }
    // Exact bytes are the evidence; parse a copy for normalization.
    let parsed: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => {
            return failed(
                job,
                Some(model.clone()),
                serde_json::json!({"error": "9router malformed body"}),
                "PROVIDER_MALFORMED",
                "9router returned invalid JSON",
            );
        }
    };
    let answer = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    let answer = match answer {
        Some(a) => a,
        None => {
            return failed(
                job,
                Some(model.clone()),
                serde_json::json!({"error": "9router unexpected schema"}),
                "PROVIDER_MALFORMED",
                "9router response has no choices[0].message.content",
            );
        }
    };
    // Resolved model only when positively reported; never inferred.
    let observed = parsed
        .get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());
    let citations = provider_citations(&parsed);
    let provider_metadata = provider_metadata(&parsed);
    WorkerResult {
        contract_version: RESULT_CONTRACT_VERSION.to_string(),
        run_id: job.run_id.clone(),
        status: "succeeded".to_string(),
        provider: NINE_ROUTER_PROVIDER.to_string(),
        requested_model: Some(model),
        observed_model: observed,
        collected_at: now_rfc3339(),
        answer_text: Some(answer),
        // UNKNOWN unless directly proven: a chat completion carries no
        // grounding signal, and citations are never invented.
        retrieval_mode: "unknown".to_string(),
        citations,
        raw_digest: sha256_hex(&bytes),
        raw_response: parsed,
        raw_bytes_hex: Some(hex::encode(&bytes)),
        raw_content_type: Some("application/json".to_string()),
        provider_metadata,
        failure_class: None,
        failure_detail_safe: None,
    }
}

/// Citations exactly as the response returned them, in returned order.
/// Accepts `{uri,title,position?,attributed?}` objects or bare URL strings;
/// anything else is dropped rather than reinterpreted. Never invented.
fn provider_citations(parsed: &serde_json::Value) -> Vec<WorkerCitation> {
    let Some(items) = parsed.get("citations").and_then(|v| v.as_array()) else {
        return vec![];
    };
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let returned_position = i64::try_from(index + 1).ok();
            if let Some(uri) = item.as_str() {
                return Some(WorkerCitation {
                    uri: Some(uri.to_string()),
                    title: None,
                    position: returned_position,
                    attributed: false,
                });
            }
            let text = |key: &str| item.get(key).and_then(|v| v.as_str()).map(str::to_string);
            let (uri, title) = (text("uri"), text("title"));
            if uri.is_none() && title.is_none() {
                return None;
            }
            Some(WorkerCitation {
                uri,
                title,
                position: item
                    .get("position")
                    .and_then(|v| v.as_i64())
                    .or(returned_position),
                attributed: item
                    .get("attributed")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// Response-level metadata the router actually returned. Absent keys stay
/// absent (never `null`); no keys at all means no metadata (UNKNOWN).
fn provider_metadata(parsed: &serde_json::Value) -> Option<serde_json::Value> {
    let mut out = serde_json::Map::new();
    for key in [
        "id",
        "object",
        "created",
        "model",
        "usage",
        "system_fingerprint",
    ] {
        if let Some(value) = parsed.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    (!out.is_empty()).then_some(serde_json::Value::Object(out))
}

/// Synchronous entry point for the stdio worker binary: env config plus a
/// current-thread runtime, bounded by `NINE_ROUTER_TIMEOUT_MS`.
pub fn execute_9router(job: &WorkerJob) -> WorkerResult {
    let cfg = match config_from_env() {
        Ok(c) => c,
        Err(e) => return config_failure(job, &e),
    };
    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(cfg.timeout_ms))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return failed(
                job,
                Some(cfg.model.clone()),
                serde_json::json!({"error": "http client failed"}),
                "WORKER_FAILED",
                "could not build 9router http client",
            );
        }
    };
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt.block_on(execute_9router_with(job, &cfg, &http)),
        Err(_) => failed(
            job,
            Some(cfg.model.clone()),
            serde_json::json!({"error": "async runtime failed"}),
            "WORKER_FAILED",
            "could not start 9router runtime",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    fn job9(prompt: &str) -> WorkerJob {
        WorkerJob {
            contract_version: crate::worker_contract::JOB_CONTRACT_VERSION.to_string(),
            run_id: "RUN-9R".to_string(),
            provider: NINE_ROUTER_PROVIDER.to_string(),
            model: None,
            prompt: prompt.to_string(),
        }
    }

    fn cfg_for(port: u16) -> NineRouterConfig {
        NineRouterConfig {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            api_key: Some("test-key".to_string()),
            model: "oc/pinned-free-test".to_string(),
            timeout_ms: 5_000,
        }
    }

    /// Minimal single-shot HTTP stub: records the request head, replies once.
    struct Stub {
        port: u16,
        seen: mpsc::Receiver<String>,
    }

    fn stub_once(status: &str, body: &str) -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let port = listener.local_addr().expect("addr").port();
        let (tx, rx) = mpsc::channel();
        let body = body.to_string();
        let status = status.to_string();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = tx.send(head);
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
        });
        Stub { port, seen: rx }
    }

    fn run_with(
        stub: &Stub,
        mutate: impl FnOnce(&mut WorkerJob),
        cfg_mut: impl FnOnce(&mut NineRouterConfig),
    ) -> (WorkerResult, String) {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
        let http = reqwest::Client::builder()
            .timeout(Duration::from_millis(5_000))
            .build()
            .expect("client");
        let mut job = job9("What does Notion cost?");
        mutate(&mut job);
        let mut cfg = cfg_for(stub.port);
        cfg_mut(&mut cfg);
        let out = rt.block_on(execute_9router_with(&job, &cfg, &http));
        let seen = stub
            .seen
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_default();
        (out, seen)
    }

    const SUCCESS_BODY: &str = r#"{
      "id": "chatcmpl-test1",
      "object": "chat.completion",
      "created": 1790000000,
      "model": "oc/pinned-free-test",
      "choices": [{"index": 0, "message": {"role": "assistant", "content": "Notion Plus costs $10 per member per month."}, "finish_reason": "stop"}],
      "usage": {"prompt_tokens": 18, "completion_tokens": 12, "total_tokens": 30}
    }"#;

    #[test]
    fn citations_are_only_what_the_provider_returned() {
        assert!(provider_citations(&serde_json::json!({"choices": []})).is_empty());
        let parsed = serde_json::json!({"citations": [
            "https://a.example/",
            {"uri": "https://b.example/", "title": "B", "position": 7, "attributed": true},
            {"unrelated": 1},
            42
        ]});
        let out = provider_citations(&parsed);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].uri.as_deref(), Some("https://a.example/"));
        assert_eq!(out[0].position, Some(1));
        assert!(!out[0].attributed);
        assert_eq!(out[1].title.as_deref(), Some("B"));
        assert_eq!(out[1].position, Some(7));
        assert!(out[1].attributed);
    }

    #[test]
    fn metadata_keeps_absent_keys_absent() {
        let meta = provider_metadata(&serde_json::json!({"id": "x", "model": "m"})).unwrap();
        assert_eq!(meta, serde_json::json!({"id": "x", "model": "m"}));
        assert!(provider_metadata(&serde_json::json!({"choices": []})).is_none());
    }

    #[test]
    fn success_preserves_exact_bytes_and_metadata() {
        let stub = stub_once("200 OK", SUCCESS_BODY);
        let (out, seen) = run_with(&stub, |_| {}, |_| {});
        assert_eq!(out.status, "succeeded");
        assert_eq!(out.provider, "9router");
        assert_eq!(out.requested_model.as_deref(), Some("oc/pinned-free-test"));
        assert_eq!(out.observed_model.as_deref(), Some("oc/pinned-free-test"));
        assert!(out.answer_text.unwrap().contains("$10"));
        assert_eq!(out.retrieval_mode, "unknown");
        assert!(out.citations.is_empty());
        // Exact bytes preserved: digest matches the wire body, usage kept.
        assert_eq!(out.raw_digest, sha256_hex(SUCCESS_BODY.as_bytes()));
        assert_eq!(
            hex::decode(out.raw_bytes_hex.as_deref().expect("wire bytes")).expect("hex"),
            SUCCESS_BODY.as_bytes()
        );
        assert_eq!(out.raw_response["usage"]["total_tokens"], 30);
        assert_eq!(
            out.provider_metadata.as_ref().expect("metadata")["usage"]["total_tokens"],
            30
        );
        // One user prompt, explicit pinned model, no streaming.
        assert!(seen.contains("POST /v1/chat/completions"));
        assert!(
            seen.contains("authorization: Bearer test-key")
                || seen.contains("Authorization: Bearer test-key")
        );
        assert!(seen.starts_with("POST"));
    }

    #[test]
    fn request_body_pins_model_and_single_prompt() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = vec![0u8; 0];
            let mut chunk = [0u8; 4096];
            // Read headers then Content-Length bytes.
            loop {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                let s = String::from_utf8_lossy(&buf).to_string();
                if let Some(idx) = s.find("\r\n\r\n") {
                    let head = &s[..idx];
                    let len: usize = head
                        .lines()
                        .find(|l| l.to_lowercase().starts_with("content-length:"))
                        .and_then(|l| l.split(':').nth(1))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    if s.len() >= idx + 4 + len {
                        break;
                    }
                }
                if buf.len() > 65536 {
                    break;
                }
            }
            let s = String::from_utf8_lossy(&buf).to_string();
            let _ = tx.send(s);
            let reply = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
            let _ = stream.write_all(reply.as_bytes());
        });
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
        let http = reqwest::Client::builder()
            .timeout(Duration::from_millis(5_000))
            .build()
            .expect("client");
        let cfg = cfg_for(port);
        let _ = rt.block_on(execute_9router_with(
            &job9("Does Notion have offline mode?"),
            &cfg,
            &http,
        ));
        let seen = rx.recv_timeout(Duration::from_secs(5)).expect("request");
        let body_json: serde_json::Value = {
            let idx = seen.find("\r\n\r\n").expect("split");
            serde_json::from_str(&seen[idx + 4..]).expect("body json")
        };
        assert_eq!(body_json["model"], "oc/pinned-free-test");
        assert_eq!(body_json["stream"], false);
        assert_eq!(
            body_json["messages"],
            serde_json::json!([{"role": "user", "content": "Does Notion have offline mode?"}])
        );
    }

    #[test]
    fn auth_failure_maps_to_provider_auth() {
        let stub = stub_once("401 Unauthorized", r#"{"error": {"message": "bad key"}}"#);
        let (out, _) = run_with(&stub, |_| {}, |_| {});
        assert_eq!(out.status, "failed");
        assert_eq!(out.failure_class.as_deref(), Some("PROVIDER_AUTH"));
    }

    #[test]
    fn rate_limit_maps_to_retryable_class() {
        let stub = stub_once(
            "429 Too Many Requests",
            r#"{"error": {"message": "slow down"}}"#,
        );
        let (out, _) = run_with(&stub, |_| {}, |_| {});
        assert_eq!(out.status, "failed");
        assert_eq!(out.failure_class.as_deref(), Some("PROVIDER_RATE_LIMITED"));
    }

    #[test]
    fn server_error_maps_to_unavailable() {
        let stub = stub_once("502 Bad Gateway", "upstream exploded");
        let (out, _) = run_with(&stub, |_| {}, |_| {});
        assert_eq!(out.status, "failed");
        assert_eq!(out.failure_class.as_deref(), Some("PROVIDER_UNAVAILABLE"));
    }

    #[test]
    fn invalid_json_maps_to_malformed() {
        let stub = stub_once("200 OK", "this is not json{{{");
        let (out, _) = run_with(&stub, |_| {}, |_| {});
        assert_eq!(out.status, "failed");
        assert_eq!(out.failure_class.as_deref(), Some("PROVIDER_MALFORMED"));
    }

    #[test]
    fn missing_content_maps_to_malformed() {
        let stub = stub_once("200 OK", r#"{"model": "x", "choices": []}"#);
        let (out, _) = run_with(&stub, |_| {}, |_| {});
        assert_eq!(out.status, "failed");
        assert_eq!(out.failure_class.as_deref(), Some("PROVIDER_MALFORMED"));
    }

    #[test]
    fn unknown_resolved_model_stays_unknown() {
        let stub = stub_once(
            "200 OK",
            r#"{"choices": [{"message": {"content": "Yes."}}]}"#,
        );
        let (out, _) = run_with(&stub, |_| {}, |_| {});
        assert_eq!(out.status, "succeeded");
        assert_eq!(out.observed_model, None);
    }

    #[test]
    fn pin_mismatch_fails_closed_without_network() {
        // Unroutable base URL proves no request is attempted on mismatch.
        let stub = stub_once("200 OK", SUCCESS_BODY);
        let (out, seen) = run_with(
            &stub,
            |j| j.model = Some("some/other-model".to_string()),
            |c| c.base_url = "http://127.0.0.1:1/v1".to_string(),
        );
        assert_eq!(out.status, "failed");
        assert_eq!(out.failure_class.as_deref(), Some("WORKER_FAILED"));
        assert!(seen.is_empty());
        drop(stub);
    }

    #[test]
    fn non_https_remote_is_refused() {
        let mut cfg = cfg_for(20128);
        cfg.base_url = "http://router.example.com/v1".to_string();
        assert_eq!(
            check_url(&cfg),
            Err(NineRouterConfigError::RefusesNonHttpsUrl)
        );
        let mut ok = cfg_for(20128);
        ok.base_url = "https://router.example.com/v1".to_string();
        assert!(check_url(&ok).is_ok());
    }

    #[test]
    fn no_secret_in_failure_details() {
        let stub = stub_once("403 Forbidden", r#"{"error": "denied"}"#);
        let (out, seen) = run_with(&stub, |_| {}, |_| {});
        assert_eq!(out.failure_class.as_deref(), Some("PROVIDER_AUTH"));
        // Key travels in the header only, never in details or evidence.
        assert!(seen
            .to_lowercase()
            .contains("authorization: bearer test-key"));
        let detail = out.failure_detail_safe.unwrap_or_default();
        assert!(!detail.contains("test-key"));
        assert!(!out.raw_digest.contains("test-key"));
    }
}
