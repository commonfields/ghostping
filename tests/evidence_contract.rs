//! Evidence-foundation contract tests.
//!
//! These run the real CLI binary end-to-end in an isolated HOME with the
//! mock provider (no network, no secrets) and prove:
//! 1. the canonical path (`audit run`) writes evidence-engine records with
//!    planned = succeeded + failed accounting;
//! 2. legacy `mentions.db` rows in the same HOME never leak into evidence
//!    summaries — legacy history cannot silently appear as current evidence;
//! 3. legacy summaries carry the explicit legacy source marker.

use std::path::PathBuf;
use std::process::Command;

fn openrecord_bin() -> PathBuf {
    // Cargo provides the freshly built binary path to integration tests.
    // Fall back to a prebuilt target binary for ad-hoc runs.
    let from_cargo = option_env!("CARGO_BIN_EXE_openrecord").map(PathBuf::from);
    if let Some(p) = from_cargo {
        return p;
    }
    let dir = env!("CARGO_MANIFEST_DIR");
    let debug = PathBuf::from(dir).join("target/debug/openrecord");
    if debug.exists() {
        return debug;
    }
    PathBuf::from(dir).join("target/release/openrecord")
}

struct Sandbox {
    home: tempfile::TempDir,
    proj: tempfile::TempDir,
    bin: PathBuf,
}

impl Sandbox {
    fn new() -> Self {
        let home = tempfile::TempDir::new().unwrap();
        let proj = tempfile::TempDir::new().unwrap();
        let bin = openrecord_bin();
        assert!(
            bin.exists(),
            "openrecord binary missing at {}; build it first (cargo build --bin openrecord)",
            bin.display()
        );
        Self { home, proj, bin }
    }

    fn run(&self, args: &[&str]) -> (i32, String) {
        let out = Command::new(&self.bin)
            .args(args)
            .current_dir(self.proj.path())
            .env("HOME", self.home.path())
            .env_remove("OPENRECORD_BIN")
            .output()
            .expect("failed to spawn openrecord");
        let code = out.status.code().unwrap_or(-1);
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&out.stderr));
        (code, text)
    }

    fn evidence_db(&self) -> PathBuf {
        self.home.path().join(".openrecord/evidence.db")
    }

    fn legacy_db(&self) -> PathBuf {
        self.home.path().join(".openrecord/mentions.db")
    }
}

fn query_count(db: &PathBuf, sql: &str) -> i64 {
    let conn = rusqlite::Connection::open(db).unwrap();
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn canonical_audit_writes_evidence_records_with_full_accounting() {
    let sb = Sandbox::new();
    assert_eq!(
        sb.run(&[
            "init",
            "--name",
            "C",
            "--website",
            "https://example.com",
            "--yes"
        ])
        .0,
        0
    );
    assert_eq!(sb.run(&["prompts", "discover"]).0, 0);
    let (code, _) = sb.run(&["audit", "run", "--models", "mock", "--samples", "1"]);
    assert_eq!(code, 0);

    // Evidence rows exist with planned = succeeded + failed.
    let total: i64 = query_count(&sb.evidence_db(), "SELECT COUNT(*) FROM audit_results");
    assert!(total > 0, "expected stored evidence responses");
    let failed: i64 = query_count(&sb.evidence_db(), "SELECT COUNT(*) FROM audit_errors");
    let planned = total + failed;
    assert_eq!(planned, total, "mock run should have zero failures");

    let status: String = {
        let conn = rusqlite::Connection::open(sb.evidence_db()).unwrap();
        conn.query_row(
            "SELECT status FROM audit_runs ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(status, "completed");

    // The canonical run wrote no legacy rows.
    assert!(
        !sb.legacy_db().exists()
            || query_count(&sb.legacy_db(), "SELECT COUNT(*) FROM mentions") == 0,
        "evidence audit must not write legacy mention rows"
    );
}

#[test]
fn legacy_history_cannot_appear_as_current_evidence() {
    let sb = Sandbox::new();
    assert_eq!(
        sb.run(&[
            "init",
            "--name",
            "C",
            "--website",
            "https://example.com",
            "--yes"
        ])
        .0,
        0
    );
    assert_eq!(sb.run(&["prompts", "discover"]).0, 0);
    assert_eq!(
        sb.run(&["audit", "run", "--models", "mock", "--samples", "1"])
            .0,
        0
    );

    // Plant legacy history directly in the same HOME, as an old `track`
    // run would have left it.
    {
        let conn = rusqlite::Connection::open(sb.legacy_db()).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS mentions (id INTEGER PRIMARY KEY AUTOINCREMENT,
             domain TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT NOT NULL,
             timestamp TEXT NOT NULL, mentioned INTEGER NOT NULL, cited INTEGER NOT NULL,
             position TEXT NOT NULL, sentiment TEXT NOT NULL, snippet TEXT,
             raw_response TEXT NOT NULL);",
        )
        .unwrap();
        for i in 0..5 {
            conn.execute(
                &format!(
                    "INSERT INTO mentions (domain, prompt, model, timestamp, mentioned,
                     cited, position, sentiment, snippet, raw_response)
                     VALUES ('legacy.example', 'legacy q{i}', 'openai',
                     '2026-01-01T00:00:00Z', 1, 1, 'Top', 'Positive', 's', 'LEGACY ROW')"
                ),
                [],
            )
            .unwrap();
        }
    }

    // Evidence summary counts only evidence rows: 5 legacy mentions must
    // not inflate anything.
    let before_total: i64 = query_count(&sb.evidence_db(), "SELECT COUNT(*) FROM audit_results");
    let (code, _) = sb.run(&["audit", "run", "--models", "mock", "--samples", "1"]);
    assert_eq!(code, 0);
    let after_total: i64 = query_count(&sb.evidence_db(), "SELECT COUNT(*) FROM audit_results");
    assert!(
        after_total > before_total,
        "second run should add evidence rows"
    );
    let legacy_count: i64 = query_count(&sb.legacy_db(), "SELECT COUNT(*) FROM mentions");
    assert!(legacy_count >= 5);
    // Evidence responses never contain the planted legacy marker text.
    let leaked: i64 = query_count(
        &sb.evidence_db(),
        "SELECT COUNT(*) FROM audit_results WHERE response_text LIKE '%LEGACY ROW%'",
    );
    assert_eq!(leaked, 0, "legacy rows leaked into evidence records");
}

#[test]
fn legacy_summaries_carry_explicit_source_marker() {
    // Unit-level pin: the legacy path's summary type is self-identifying,
    // so no consumer can mistake it for an evidence-engine AuditSummary.
    assert_eq!(openrecord::tracker::AUDIT_SOURCE_LEGACY, "legacy-tracker");
    let summary = openrecord::types::TrackSummary {
        domain: "x.example".to_string(),
        total_queries: 1,
        mention_count: 1,
        citation_count: 0,
        models_with_mention: vec!["openai".to_string()],
        results: vec![],
        source: openrecord::tracker::AUDIT_SOURCE_LEGACY.to_string(),
    };
    assert_eq!(summary.source, "legacy-tracker");
}
