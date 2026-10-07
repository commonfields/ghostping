//! Assay CLI enforcement: live split/budget gates provable without keys.
//!
//! These run the real `jev-assay` binary. Live execution itself needs
//! credentials and is never attempted here; the gates under test fire
//! before any environment or network access.

use std::path::PathBuf;
use std::process::Command;

fn assay_bin() -> PathBuf {
    if let Some(p) = option_env!("CARGO_BIN_EXE_jev-assay") {
        return PathBuf::from(p);
    }
    let dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(dir).join("target/debug/jev-assay")
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("research/jev-assay/datasets")
}

fn run(args: &[&str]) -> (i32, String) {
    let out = Command::new(assay_bin())
        .args(args)
        .env_remove("TYPESAFE_API_KEY")
        .env_remove("OPENRECORD_LIVE_JEV")
        .output()
        .expect("spawn jev-assay");
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    (out.status.code().unwrap_or(-1), text)
}

#[test]
fn test_live_without_explicit_split_is_refused() {
    let ds = fixtures().join("task_a_synthetic.jsonl");
    let dir = tempfile::TempDir::new().unwrap();
    let (code, text) = run(&[
        "eval",
        "--task",
        "a",
        "--dataset",
        ds.to_str().unwrap(),
        "--transport",
        "live",
        "--out",
        dir.path().to_str().unwrap(),
    ]);
    assert_ne!(code, 0);
    assert!(
        text.contains("explicit --split"),
        "must demand an explicit split, got:\n{}",
        text
    );
}

#[test]
fn test_live_all_split_refused_without_override() {
    let ds = fixtures().join("task_a_synthetic.jsonl");
    let dir = tempfile::TempDir::new().unwrap();
    let (code, text) = run(&[
        "eval",
        "--task",
        "a",
        "--dataset",
        ds.to_str().unwrap(),
        "--transport",
        "live",
        "--split",
        "all",
        "--out",
        dir.path().to_str().unwrap(),
    ]);
    assert_ne!(code, 0);
    assert!(text.contains("--allow-all-split"), "got:\n{}", text);
}

#[test]
fn test_insufficient_budget_refused_before_any_request() {
    // 220 holdout cases need 220 requests; 5 is insufficient. Must fail
    // before env checks, manifests, or requests (no keys here to proceed).
    let ds = fixtures().join("task_a_synthetic.jsonl");
    let dir = tempfile::TempDir::new().unwrap();
    let (code, text) = run(&[
        "eval",
        "--task",
        "a",
        "--dataset",
        ds.to_str().unwrap(),
        "--transport",
        "live",
        "--split",
        "holdout",
        "--max-requests",
        "5",
        "--out",
        dir.path().to_str().unwrap(),
    ]);
    assert_ne!(code, 0);
    assert!(
        text.contains("INSUFFICIENT_REQUEST_BUDGET"),
        "got:\n{}",
        text
    );
    // Nothing started: no manifest, no receipts.
    assert!(!dir.path().join("run-manifest.json").exists());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn test_offline_eval_still_needs_no_split() {
    // Offline transports keep the old default (all) — no behavior change.
    let ds = fixtures().join("task_b_synthetic.jsonl");
    let dir = tempfile::TempDir::new().unwrap();
    let (code, _) = run(&[
        "eval",
        "--task",
        "b",
        "--dataset",
        ds.to_str().unwrap(),
        "--transport",
        "mock-uniform",
        "--out",
        dir.path().to_str().unwrap(),
    ]);
    assert_eq!(code, 0);
    assert!(dir.path().join("metrics.json").exists());
}
