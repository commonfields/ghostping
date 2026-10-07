//! jev-assay: research runner for the Jev judgment assay.
//!
//! Offline transports (mock-*, deterministic) need no keys or network.
//! Live transport requires TYPESAFE_API_KEY + GHOSTPING_LIVE_JEV=1 +
//! --max-requests N, all enforced before any request.

use anyhow::{bail, Result};
use clap::{Parser, ValueEnum};
use openrecord::jev_assay::*;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, ValueEnum)]
enum TransportKind {
    /// Scripted answers matching the expected label (pipeline check only).
    MockDecide,
    /// Uniform 0.5 answers (abstention-path check only).
    MockUniform,
    /// Live TypeSafe API (gated; spends budget).
    Live,
    /// Deterministic baseline (no model).
    Deterministic,
}

#[derive(Clone, ValueEnum, PartialEq)]
enum Task {
    A,
    B,
}

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(clap::Subcommand)]
enum Commands {
    Eval {
        #[arg(long, value_enum)]
        task: Task,
        #[arg(long)]
        dataset: std::path::PathBuf,
        #[arg(long, value_enum, default_value = "mock-decide")]
        transport: TransportKind,
        #[arg(long, default_value = "0")]
        max_requests: usize,
        /// Case population: dev | holdout | all (default all for offline).
        /// Live transport REQUIRES an explicit value; live + all is refused
        /// unless --allow-all-split is passed.
        #[arg(long)]
        split: Option<String>,
        /// Explicit research override permitting a live full-split run.
        #[arg(long, default_value = "false")]
        allow_all_split: bool,
        #[arg(long)]
        out: std::path::PathBuf,
    },
}

/// One evaluated case: composed label, disposition, answers, provider
/// identity, latency, usage — or a transport failure string.
type CaseOutcome = Result<
    (
        String,
        Disposition,
        Vec<NoulAnswer>,
        String,
        String,
        Option<String>,
        u64,
        Option<serde_json::Value>,
    ),
    String,
>;

fn state_for(case: &AssayCase) -> String {
    match case.task.as_str() {
        "fact_relationship" => {
            let facts = case.evidence.as_array().map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| format!("- {}", s))
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            format!(
                "Claim: {}\nAuthoritative facts:\n{}",
                case.claim,
                facts.unwrap_or_default()
            )
        }
        _ => format!(
            "Claim: {}\nSource excerpt:\n{}",
            case.claim,
            case.evidence.as_str().unwrap_or("")
        ),
    }
}

fn mock_for_label(task: &Task, label: &str) -> MockTransport {
    let hi = 0.95;
    let lo = 0.02;
    match task {
        Task::A => match label {
            "SUPPORTED" => MockTransport::default()
                .answer("fully_supported", hi)
                .answer("contains_contradiction", lo)
                .answer("partially_supported", 0.10)
                .answer("enough_evidence", hi),
            "CONTRADICTED" => MockTransport::default()
                .answer("fully_supported", lo)
                .answer("contains_contradiction", hi)
                .answer("partially_supported", lo)
                .answer("enough_evidence", hi),
            "PARTIAL" => MockTransport::default()
                .answer("fully_supported", 0.30)
                .answer("contains_contradiction", lo)
                .answer("partially_supported", 0.90)
                .answer("enough_evidence", hi),
            _ => MockTransport::default()
                .answer("fully_supported", 0.30)
                .answer("contains_contradiction", 0.30)
                .answer("partially_supported", 0.30)
                .answer("enough_evidence", 0.30),
        },
        Task::B => match label {
            "SUPPORTS" => MockTransport::default()
                .answer("source_entails_claim", hi)
                .answer("source_conflicts_with_claim", lo)
                .answer("source_has_enough_information", hi),
            "CONTRADICTS" => MockTransport::default()
                .answer("source_entails_claim", lo)
                .answer("source_conflicts_with_claim", hi)
                .answer("source_has_enough_information", hi),
            _ => MockTransport::default()
                .answer("source_entails_claim", 0.40)
                .answer("source_conflicts_with_claim", 0.40)
                .answer("source_has_enough_information", 0.40),
        },
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Eval {
            task,
            dataset,
            transport,
            max_requests,
            split,
            allow_all_split,
            out,
        } => {
            let is_live = matches!(transport, TransportKind::Live);
            // Phase 1: live execution requires an EXPLICIT split. The frozen
            // benchmark population is holdout; `all` needs an override.
            let split_name: String = match (is_live, split.as_deref()) {
                (true, None) => bail!(
                    "live transport requires an explicit --split (dev|holdout); refusing implicit all"
                ),
                (true, Some("all")) if !allow_all_split => bail!(
                    "live transport with --split all requires --allow-all-split"
                ),
                (_, Some(v)) => v.to_string(),
                (_, None) => "all".to_string(),
            };
            let task_name = match task {
                Task::A => "fact_relationship",
                Task::B => "citation_support",
            };
            let valid: &[&str] = match task {
                Task::A => &[
                    "SUPPORTED",
                    "CONTRADICTED",
                    "PARTIAL",
                    "INSUFFICIENT_EVIDENCE",
                ],
                Task::B => &["SUPPORTS", "CONTRADICTS", "AMBIGUOUS", "INSUFFICIENT"],
            };
            let mut cases = load_jsonl(&dataset)?;
            validate_dataset(&cases, task_name, valid)?;

            // Frozen-split filter (dev | holdout | all).
            if split_name != "all" {
                let split_path = dataset
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .join("split-v1.json");
                let split_json: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(&split_path)?)?;
                let ids: HashSet<String> = split_json
                    .get(split_name.as_str())
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                if ids.is_empty() {
                    bail!(
                        "split '{}' missing or empty in {}",
                        split_name,
                        split_path.display()
                    );
                }
                cases.retain(|c| ids.contains(&c.case_id));
            }

            let questions: &[NoulQuestion] = match task {
                Task::A => TASK_A_QUESTIONS,
                Task::B => TASK_B_QUESTIONS,
            };
            // Budget sanity BEFORE any request or manifest: one request
            // per case (all questions batched in a single call).
            let planned_requests = cases.len();
            if is_live && max_requests < planned_requests {
                bail!(
                    "INSUFFICIENT_REQUEST_BUDGET: {} cases need {} requests, --max-requests {}.                      Refusing partial benchmark.",
                    cases.len(),
                    planned_requests,
                    max_requests
                );
            }
            // Model discovery + pinning (live only): resolve once, freeze for
            // the whole run; every request sends the resolved string.
            let mut manifest_extra = serde_json::json!({});
            let live = match transport {
                TransportKind::Live => {
                    let probe = LiveTransport::gated_with_model(usize::MAX, JEV_MODEL_REQUESTED)?;
                    let resolution = resolve_model(
                        probe.client_ref(),
                        probe.key_ref(),
                        "https://api.typesafe.ai/v1/models",
                        JEV_MODEL_REQUESTED,
                    )?;
                    manifest_extra = serde_json::json!({
                        "requested_alias": resolution.requested_alias,
                        "resolved_model": resolution.resolved_model,
                        "model_pinning": if resolution.pinned {
                            "pinned"
                        } else {
                            "MODEL_PINNING = UNSUPPORTED_BY_PROVIDER"
                        },
                        "discovery_models": resolution.discovery_models,
                    });
                    // The probe spent no request budget (discovery is not a
                    // judgment request); the run transport owns the budget.
                    Some(LiveTransport::gated_with_model(
                        max_requests,
                        &resolution.resolved_model,
                    )?)
                }
                _ => None,
            };
            // Run manifest BEFORE request #1 (live runs only).
            let run_id = format!(
                "jev-{}-{}-{}",
                match task {
                    Task::A => "a",
                    Task::B => "b",
                },
                split_name,
                chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
            );
            if is_live {
                std::fs::create_dir_all(&out)?;
                let split_json: serde_json::Value = serde_json::from_str(
                    &std::fs::read_to_string(
                        dataset
                            .parent()
                            .unwrap_or(std::path::Path::new("."))
                            .join("split-v1.json"),
                    )
                    .unwrap_or_else(|_| "{}".to_string()),
                )
                .unwrap_or(serde_json::json!({}));
                let manifest = serde_json::json!({
                    "run_id": run_id,
                    "protocol": "jev-assay-v1",
                    "question_set": QUESTION_SET_V1,
                    "threshold_policy": THRESHOLD_POLICY_V1,
                    "receipt_schema": RECEIPT_SCHEMA_V1,
                    "dataset": dataset.display().to_string(),
                    "split": split_name,
                    "holdout_digest": split_json.get("holdout_digest"),
                    "selected_cases": cases.len(),
                    "planned_requests": planned_requests,
                    "max_requests": max_requests,
                    "started_at": chrono::Utc::now().to_rfc3339(),
                    "budget_note": "one request per case; all questions batched per call",
                });
                let mut manifest = manifest.as_object().unwrap().clone();
                manifest.extend(manifest_extra.as_object().unwrap().clone());
                std::fs::write(
                    out.join("run-manifest.json"),
                    serde_json::to_string_pretty(&manifest)?,
                )?;
            }

            let mut expected = Vec::new();
            let mut predicted_auto: Vec<Option<String>> = Vec::new();
            let mut brier_p = Vec::new();
            let mut brier_c = Vec::new();
            // Raw-Noul calibration pairs per question: (truth, prob).
            let mut per_question: HashMap<String, (Vec<bool>, Vec<f64>)> = HashMap::new();
            for q in questions {
                per_question.insert(q.name.to_string(), (Vec::new(), Vec::new()));
            }
            // Provider-reported model identities observed this run.
            let mut observed_models: HashMap<String, usize> = HashMap::new();
            let mut actual_requests = 0usize;
            let mut succeeded = 0usize;
            let mut latencies = Vec::new();
            let mut failures = 0usize;
            let mut auto_n = 0usize;
            let mut human_n = 0usize;
            let mut errors: Vec<serde_json::Value> = Vec::new();

            for case in &cases {
                let state = state_for(case);
                let started = std::time::Instant::now();
                let outcome: CaseOutcome = match transport {
                    TransportKind::Deterministic => {
                        let text = match task {
                            Task::A => {
                                let facts = case.evidence.as_array().map(|a| {
                                    a.iter()
                                        .filter_map(|v| v.as_str())
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                });
                                facts.unwrap_or_default()
                            }
                            Task::B => case.evidence.as_str().unwrap_or("").to_string(),
                        };
                        let v = deterministic_baseline(&case.claim, &text);
                        // Plain task labels: the baseline is scored in the same
                        // space; the provider field records its origin.
                        let label = match task {
                            Task::A => match v {
                                BaselineVerdict::Supported => "SUPPORTED",
                                BaselineVerdict::Contradicted => "CONTRADICTED",
                                BaselineVerdict::Abstain => "ABSTAIN",
                            },
                            Task::B => match v {
                                BaselineVerdict::Supported => "SUPPORTS",
                                BaselineVerdict::Contradicted => "CONTRADICTS",
                                BaselineVerdict::Abstain => "ABSTAIN",
                            },
                        };
                        Ok((
                            label.to_string(),
                            if v == BaselineVerdict::Abstain {
                                Disposition::HumanReview
                            } else {
                                Disposition::AutoClassify
                            },
                            vec![],
                            "deterministic".to_string(),
                            "baseline-v1".to_string(),
                            None,
                            started.elapsed().as_millis() as u64,
                            None,
                        ))
                    }
                    _ => {
                        let owned: Option<Box<dyn JevTransport>> = match transport {
                            TransportKind::MockDecide => {
                                Some(Box::new(mock_for_label(&task, &case.label)))
                            }
                            TransportKind::MockUniform => {
                                let mut m = MockTransport::default();
                                for q in questions {
                                    m = m.answer(q.name, 0.5);
                                }
                                Some(Box::new(m))
                            }
                            _ => None,
                        };
                        let t: &dyn JevTransport = match transport {
                            TransportKind::Live => live.as_ref().unwrap() as &dyn JevTransport,
                            _ => owned.as_ref().unwrap().as_ref(),
                        };
                        match t.decide(&state, questions) {
                            Ok(resp) => {
                                let (label, disp) = match task {
                                    Task::A => {
                                        let l = compose_a(&resp.answers);
                                        (
                                            format!("{:?}", l).to_uppercase().replace(
                                                "INSUFFICIENTEVIDENCE",
                                                "INSUFFICIENT_EVIDENCE",
                                            ),
                                            dispose_a(l, &resp.answers),
                                        )
                                    }
                                    Task::B => {
                                        let l = compose_b(&resp.answers);
                                        (
                                            format!("{:?}", l).to_uppercase(),
                                            dispose_b(l, &resp.answers),
                                        )
                                    }
                                };
                                Ok((
                                    label,
                                    disp,
                                    resp.answers.clone(),
                                    resp.provider.clone(),
                                    resp.model.clone(),
                                    resp.provider_model_version.clone(),
                                    resp.latency_ms,
                                    resp.usage.clone(),
                                ))
                            }
                            Err(f) => Err(f.to_string()),
                        }
                    }
                };

                expected.push(case.label.clone());
                match outcome {
                    Ok((label, disp, answers, provider, model, pmv, latency, usage)) => {
                        latencies.push(latency);
                        let decisive = decisive_prob(&task, &answers);
                        match disp {
                            Disposition::AutoClassify => {
                                auto_n += 1;
                                let correct = label == case.label;
                                if let Some(p) = decisive {
                                    brier_p.push(p);
                                    brier_c.push(correct);
                                }
                                predicted_auto.push(Some(label.clone()));
                                if !correct {
                                    errors.push(serde_json::json!({
                                        "case_id": case.case_id,
                                        "expected": case.label,
                                        "predicted": label,
                                        "answers": answers,
                                        "evidence": case.evidence,
                                        "claim": case.claim,
                                    }));
                                }
                            }
                            _ => {
                                human_n += 1;
                                predicted_auto.push(None);
                            }
                        }
                        actual_requests += 1;
                        succeeded += 1;
                        if let Some(pmv) = pmv.clone() {
                            *observed_models.entry(pmv).or_insert(0) += 1;
                        }
                        for a in &answers {
                            if let Some(t) = case
                                .noul_truth
                                .as_ref()
                                .and_then(|t| t.get(&a.name))
                                .copied()
                            {
                                if let Some((ts, ps)) = per_question.get_mut(&a.name) {
                                    ts.push(t);
                                    ps.push(a.noul);
                                }
                            }
                        }
                        let receipt = JudgmentReceipt {
                            receipt_version: RECEIPT_SCHEMA_V1.to_string(),
                            case_id: case.case_id.clone(),
                            task: task_name.to_string(),
                            evidence_digest: sha256_hex_label(&state),
                            question_set_version: QUESTION_SET_V1.to_string(),
                            threshold_policy_version: THRESHOLD_POLICY_V1.to_string(),
                            provider,
                            model,
                            provider_model_version: pmv,
                            questions: questions
                                .iter()
                                .map(|q| ReceiptQuestion {
                                    name: q.name.to_string(),
                                    instructions: q.instructions.to_string(),
                                })
                                .collect(),
                            probabilities: answers.iter().map(|a| a.noul).collect(),
                            answers,
                            composed_label: label,
                            disposition: disp,
                            latency_ms: latency,
                            usage,
                            cost_usd: None,
                            collected_at: chrono::Utc::now().to_rfc3339(),
                            transport_status: "ok".to_string(),
                            failure_class: None,
                        };
                        write_receipt(&out, &receipt)?;
                    }
                    Err(failure) => {
                        failures += 1;
                        predicted_auto.push(None);
                        let receipt = JudgmentReceipt {
                            receipt_version: RECEIPT_SCHEMA_V1.to_string(),
                            case_id: case.case_id.clone(),
                            task: task_name.to_string(),
                            evidence_digest: sha256_hex_label(&state),
                            question_set_version: QUESTION_SET_V1.to_string(),
                            threshold_policy_version: THRESHOLD_POLICY_V1.to_string(),
                            provider: "transport".to_string(),
                            model: "none".to_string(),
                            provider_model_version: None,
                            questions: vec![],
                            answers: vec![],
                            probabilities: vec![],
                            composed_label: "UNAVAILABLE".to_string(),
                            disposition: Disposition::Unavailable,
                            latency_ms: started.elapsed().as_millis() as u64,
                            usage: None,
                            cost_usd: None,
                            collected_at: chrono::Utc::now().to_rfc3339(),
                            transport_status: "failed".to_string(),
                            failure_class: Some(failure),
                        };
                        write_receipt(&out, &receipt)?;
                    }
                }
            }

            let classes: Vec<&str> = valid.to_vec();
            let conf = confusion(&expected, &predicted_auto, &classes);
            // Accuracy over AUTO decisions only (abstention is not error).
            let auto_pairs: Vec<(String, Option<String>)> = expected
                .iter()
                .zip(predicted_auto.iter())
                .filter(|(_, p)| p.is_some())
                .map(|(e, p)| (e.clone(), p.clone()))
                .collect();
            let auto_acc = if auto_pairs.is_empty() {
                None
            } else {
                let (e, p): (Vec<String>, Vec<Option<String>>) = auto_pairs.into_iter().unzip();
                accuracy(&e, &p)
            };
            // Raw-Noul calibration per question (Phase 3A): frozen binary
            // targets from each case's noul_truth. AMBIGUOUS rows carry null
            // truth and are excluded here, counted in the label tables.
            let mut raw_noul_calibration = serde_json::Map::new();
            for q in questions {
                if let Some((ts, ps)) = per_question.get(q.name) {
                    let cal = calibrate_question(q.name, ts, ps);
                    raw_noul_calibration.insert(
                        q.name.to_string(),
                        serde_json::json!({
                            "n": cal.n,
                            "brier": cal.brier,
                            "mean_predicted": cal.mean_predicted,
                            "empirical_positive_rate": cal.empirical_positive_rate,
                            "bins": cal.bins,
                        }),
                    );
                }
            }
            // Model drift check (live): every receipt must report the same
            // provider identity, else RUN_INVALIDATED_MODEL_DRIFT.
            let mut observed: Vec<(String, usize)> = observed_models.into_iter().collect();
            observed.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
            let drift = is_live && observed.len() > 1;
            let metrics = serde_json::json!({
                "task": task_name,
                "transport": match transport {
                    TransportKind::MockDecide => "mock-decide",
                    TransportKind::MockUniform => "mock-uniform",
                    TransportKind::Live => "live",
                    TransportKind::Deterministic => "deterministic",
                },
                "split": split_name,
                "cases": cases.len(),
                "auto_classify": auto_n,
                "human_review": human_n,
                "failures": failures,
                "coverage": auto_n as f64 / cases.len().max(1) as f64,
                "auto_accuracy": auto_acc,
                "macro_f1": macro_f1(&conf),
                "raw_noul_calibration": raw_noul_calibration,
                "per_class": classes.iter().map(|c| {
                    let s = &conf[*c];
                    (c, serde_json::json!({
                        "precision": precision(s), "recall": recall(s),
                        "tp": s.tp, "fp": s.fp, "fn": s.fn_,
                    }))
                }).collect::<HashMap<_,_>>(),
                // Selective-decision confidence: decisiveness of AUTO rulings,
                // NOT per-question calibration (see raw_noul_calibration).
                "selective_confidence_brier": brier_score(&brier_p, &brier_c),
                "selective_confidence_bins": calibration_bins(&brier_p, &brier_c, 5),
                "latency_p50_ms": percentile(latencies.clone(), 50.0),
                "latency_p95_ms": percentile(latencies.clone(), 95.0),
                "observed_models": observed.iter().map(|(m, n)| serde_json::json!({
                    "model": m, "receipts": n,
                })).collect::<Vec<_>>(),
                "model_drift": if drift { "RUN_INVALIDATED_MODEL_DRIFT" } else { "none" },
                "question_set": QUESTION_SET_V1,
                "threshold_policy": THRESHOLD_POLICY_V1,
                "receipt_schema": RECEIPT_SCHEMA_V1,
            });
            std::fs::write(
                out.join("metrics.json"),
                serde_json::to_string_pretty(&metrics)?,
            )?;
            std::fs::write(
                out.join("auto_errors.json"),
                serde_json::to_string_pretty(&errors)?,
            )?;
            if is_live {
                // Completion record: preregistered manifest fields are never
                // mutated; outcomes land here.
                let completion = serde_json::json!({
                    "run_id": run_id,
                    "completed_at": chrono::Utc::now().to_rfc3339(),
                    "actual_requests": actual_requests,
                    "succeeded": succeeded,
                    "failed": failures,
                    "observed_models": observed.iter().map(|(m, n)| serde_json::json!({
                        "model": m, "receipts": n,
                    })).collect::<Vec<_>>(),
                    "model_drift": if drift { "RUN_INVALIDATED_MODEL_DRIFT" } else { "none" },
                });
                std::fs::write(
                    out.join("completion.json"),
                    serde_json::to_string_pretty(&completion)?,
                )?;
            }
            println!("{}", serde_json::to_string_pretty(&metrics)?);
            Ok(())
        }
    }
}

fn decisive_prob(task: &Task, answers: &[NoulAnswer]) -> Option<f64> {
    let get = |n: &str| answers.iter().find(|a| a.name == n).map(|a| a.noul);
    match task {
        Task::A => {
            // Highest decisive signal among the composed questions.
            [
                get("fully_supported"),
                get("contains_contradiction"),
                get("partially_supported"),
            ]
            .into_iter()
            .flatten()
            .fold(None, |acc: Option<f64>, v| {
                Some(acc.map_or(v, |a: f64| a.max(v)))
            })
        }
        Task::B => [
            get("source_entails_claim"),
            get("source_conflicts_with_claim"),
        ]
        .into_iter()
        .flatten()
        .fold(None, |acc: Option<f64>, v| {
            Some(acc.map_or(v, |a: f64| a.max(v)))
        }),
    }
}
