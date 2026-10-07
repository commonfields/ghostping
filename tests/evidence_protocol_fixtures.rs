//! Cross-language Evidence Protocol V1 contract (Rust side).
//!
//! The TypeScript generator in `packages/protocol` writes the fixtures and
//! `vectors/expected.json`. Rust must independently reach the same verdict,
//! digest, match classifications, and outcomes for every fixture, and
//! produce byte-identical canonical JSON for the shared vectors.

use std::fs;
use std::path::PathBuf;

use openrecord::evidence_protocol::{
    canonical_json, compare_measurements, measurement_signature, sha256_hex, validate_packet_bytes,
    KnowledgeString, MatchClassification,
};
use serde_json::Value;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/evidence-protocol-v1")
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_slice(&fs::read(&path).expect("read")).expect("json")
}

#[test]
fn rust_agrees_with_typescript_on_every_fixture() {
    let expected = read_json(dir().join("vectors/expected.json"));
    let expected = expected.as_object().expect("manifest");
    let mut seen = 0;
    for entry in fs::read_dir(dir()).expect("fixture dir") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let name = path.file_stem().unwrap().to_str().unwrap().to_string();
        let want = expected
            .get(&name)
            .unwrap_or_else(|| panic!("{name} missing from expected.json"));
        let result = validate_packet_bytes(&fs::read(&path).expect("read"));
        if want["valid"] == Value::Bool(true) {
            let packet = result.unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(packet.packet_digest, want["packet_digest"], "{name}");
            assert_eq!(packet.synthetic, want["synthetic"], "{name}");
            assert_eq!(
                serde_json::to_value(packet.observed_outcome).unwrap(),
                want["observed_outcome"],
                "{name}"
            );
            let matches: Vec<Value> = packet
                .reobservations
                .iter()
                .map(|r| serde_json::to_value(r.match_classification).unwrap())
                .collect();
            assert_eq!(
                Value::Array(matches),
                want["match_classifications"],
                "{name}"
            );
            let outcomes: Vec<Value> = packet
                .reobservations
                .iter()
                .map(|r| serde_json::to_value(r.outcome).unwrap())
                .collect();
            assert_eq!(Value::Array(outcomes), want["outcomes"], "{name}");
        } else {
            let err = result
                .err()
                .unwrap_or_else(|| panic!("{name} must be rejected"));
            assert_eq!(
                err.reason,
                want["reason"].as_str().unwrap(),
                "{name}: {err}"
            );
        }
        seen += 1;
    }
    assert_eq!(seen, expected.len(), "every manifest entry has a fixture");
}

#[test]
fn rust_rejects_future_version_fixture() {
    let bytes = fs::read(dir().join("malformed-future-version.json")).expect("fixture");
    let err = validate_packet_bytes(&bytes).unwrap_err();
    assert_eq!(err.reason, "UnsupportedSchemaVersion");
}

#[test]
fn canonical_json_vectors_are_byte_identical() {
    let vectors = read_json(dir().join("vectors/canonical-json.json"));
    for v in vectors["accepted"].as_array().expect("accepted") {
        let canonical = canonical_json(&v["input"]).expect("canonical");
        assert_eq!(canonical, v["canonical"].as_str().unwrap());
        assert_eq!(
            sha256_hex(canonical.as_bytes()),
            v["sha256"].as_str().unwrap()
        );
    }
    for raw in vectors["rejected"].as_array().expect("rejected") {
        let raw = raw.as_str().unwrap();
        let refused = match serde_json::from_str::<Value>(raw) {
            Ok(v) => canonical_json(&v).is_err(),
            Err(_) => true,
        };
        assert!(refused, "{raw} must be refused");
    }
}

#[test]
fn unknown_never_proves_an_exact_match() {
    let bytes = fs::read(dir().join("corrected-reobservation.json")).expect("fixture");
    let packet = validate_packet_bytes(&bytes).expect("valid");
    let sig = measurement_signature(&packet.original_observation.measurement);
    assert_eq!(
        compare_measurements(&sig, &sig),
        MatchClassification::ExactMatch
    );
    let mut hidden = sig.clone();
    hidden.locale = KnowledgeString::Unknown;
    assert_eq!(
        compare_measurements(&hidden, &hidden),
        MatchClassification::Comparable
    );
    hidden.search_mode = KnowledgeString::Unknown;
    assert_eq!(
        compare_measurements(&hidden, &hidden),
        MatchClassification::Indeterminate
    );
    let mut other = sig.clone();
    other.requested_provider = KnowledgeString::Known("other".into());
    assert_eq!(
        compare_measurements(&sig, &other),
        MatchClassification::NotComparable
    );
}
