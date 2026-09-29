# Jev Judgment Assay (research, not production)

Evaluates whether TypeSafe AI's Jev can serve as Ghostping's narrow
probabilistic judgment layer. Read `PROTOCOL.md` first — it is
preregistered and frozen.

## Status

```text
JEV_LIVE_ASSAY = NOT_EXECUTED (no TYPESAFE_API_KEY in this environment)
FRONTIER_BASELINE = NOT_EXECUTED (no authorized key / spend approval)
REAL_WORLD_VALIDATION = NOT_EXECUTED (0 human-adjudicated cases)
VERDICT = INSUFFICIENT_EVIDENCE (see reports/ when a live run completes)
```

Live execution requires ALL of: `TYPESAFE_API_KEY`, `GHOSTPING_LIVE_JEV=1`,
`--max-requests N`. CI never makes live requests.

## Layout

```text
research/jev-assay/
  README.md            this file
  PROTOCOL.md          preregistered gates, frozen question-set/policy
  datasets/
    generate.py            deterministic synthetic corpus generator
    task_a_synthetic.jsonl 240 constructed cases (60/label)
    task_b_synthetic.jsonl 200 constructed cases (50/label)
    task_b_real.jsonl      real-evidence labeling format (0 human cases)
    split-v1.json          frozen dev/holdout manifest + digest guard
  reports/             receipts + metrics output (assay-local only)
```

All synthetic rows carry `label_origin = synthetic_constructed` and are
engineering development material only — never real-world accuracy.

## Architecture rule

Jev never decides what evidence exists. It receives `CandidateClaim` +
`AuthoritativeFactSet` (Task A) or `CandidateClaim` + `CitationExcerpt`
(Task B) and answers closed noul questions. Deterministic Ghostping code
composes labels and dispositions. No production path (`audit`,
`observations`, `report`, `scheduler`, `Tauri`, `watch`, `chat`,
`generate`) imports or calls the assay.

## Running (offline, no keys)

```bash
cargo test --locked jev_assay          # harness: policy, receipts, datasets
cargo run --bin jev-assay -- eval --task a --dataset research/jev-assay/datasets/task_a_synthetic.jsonl --transport mock-decide --out /tmp/assay
```

Mock transports prove harness correctness only and can never produce KEEP.

## Running (live, requires authorization)

```bash
export TYPESAFE_API_KEY=...            # never commit, never log
export GHOSTPING_LIVE_JEV=1
cargo run --release --bin jev-assay -- eval --task a \
  --dataset research/jev-assay/datasets/task_a_synthetic.jsonl \
  --transport live --split holdout --max-requests 220 --out research/jev-assay/reports/holdout-a
```

The canonical held-out command always carries `--split holdout`.
`--max-requests` must cover every selected case (one request each) or the
run is refused up front (`INSUFFICIENT_REQUEST_BUDGET`). A run manifest is
written before request #1; per-question calibration, drift check, and
completion record follow automatically.

Budget is enforced before every request; `--max-requests 0` is rejected.
Secrets are never persisted; errors redact credentials.
