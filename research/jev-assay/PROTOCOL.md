# Jev Judgment Assay — Protocol v1 (preregistered)

Status: PREREGISTERED. Thresholds and question sets below predate all
results. Once held-out evaluation begins, `question-set-v1` and
`threshold-policy-v1` are frozen; any change requires v2 and a new
protocol version. Do not tune against the holdout.

## Research question

Can Jev classify narrow semantic relationships over Ghostping evidence
with sufficiently high precision and useful coverage while being
materially cheaper or faster than a conventional frontier-model judge?

Out of scope: general business reasoning, prose judging, production use.

## Tasks (exactly two)

### Task A — factual relationship

Inputs: `claim` + `authoritative facts[]`.
Jev answers four closed noul questions (`question-set-v1`):

```text
fully_supported?       The facts fully establish the claim as stated.
contains_contradiction? The facts contradict the claim as stated.
partially_supported?   The facts establish part of the claim but not all.
enough_evidence?       The facts contain enough information to decide.
```

Deterministic composer (`threshold-policy-v1`) produces:

```text
SUPPORTED | CONTRADICTED | PARTIAL | INSUFFICIENT_EVIDENCE | AMBIGUOUS
```

Composition rules (frozen):

```text
if contradiction >= 0.80 AND fully_supported >= 0.80 → AMBIGUOUS
elif fully_supported >= 0.80 AND contradiction <= 0.20 AND enough >= 0.60 → SUPPORTED
elif contradiction >= 0.80 AND fully_supported <= 0.20 → CONTRADICTED
elif partially >= 0.70 AND contradiction <= 0.20 → PARTIAL
else → INSUFFICIENT_EVIDENCE
```

### Task B — citation support

Inputs: `claim` + `source excerpt`.
Jev answers three closed noul questions:

```text
source_entails_claim?  The excerpt entails the claim.
source_conflicts_with_claim? The excerpt conflicts with the claim.
source_has_enough_information? The excerpt contains enough to decide.
```

Composition rules (frozen):

```text
if conflicts >= 0.80 AND entails >= 0.80 → AMBIGUOUS
elif entails >= 0.80 AND conflicts <= 0.20 AND enough >= 0.60 → SUPPORTS
elif conflicts >= 0.80 AND entails <= 0.20 → CONTRADICTS
else → INSUFFICIENT
```

## Disposition (deterministic only; Jev never outputs these)

```text
transport failure OR malformed typed response → UNAVAILABLE
label INSUFFICIENT_EVIDENCE | INSUFFICIENT | AMBIGUOUS → HUMAN_REVIEW
SUPPORTED  with fully_supported >= 0.90 AND contradiction <= 0.10 AND enough >= 0.70 → AUTO_CLASSIFY
CONTRADICTED with contradiction >= 0.90 AND fully_supported <= 0.10 → AUTO_CLASSIFY
PARTIAL / SUPPORTS with partial|entails >= 0.85 AND contradiction|conflicts <= 0.15 → AUTO_CLASSIFY
otherwise → HUMAN_REVIEW
```

## Preregistered product gates

```text
SUPPORTED AUTO_CLASSIFY precision >= 95%
CONTRADICTED AUTO_CLASSIFY precision >= 95%
AUTO_CLASSIFY coverage >= 60% (no precision-by-abstention)
```

No systematic dangerous error pattern (reviewed in the error report).

## Operational comparison

KEEP additionally requires material cost and/or latency benefit versus the
viable comparison (deterministic baseline where it covers; frontier judge
where executed). Mocks prove harness correctness only and can never
produce KEEP.

## Datasets and split

- `datasets/task_a_synthetic.jsonl`: 240 constructed cases,
  `label_origin = synthetic_constructed`. Engineering only.
- `datasets/task_b_synthetic.jsonl`: constructed citation cases,
  `label_origin = synthetic_constructed`. Engineering only.
- `datasets/task_b_real.jsonl`: real-evidence labeling format, human labels
  only. Empty until adjudicated. `REAL_WORLD_VALIDATION = NOT_EXECUTED`.
- `datasets/split-v1.json`: frozen dev/holdout case IDs. Frozen before the
  first live held-out run. After that: no moves, no deletions, no relabels,
  no wording/threshold changes without a protocol v2.

## Receipts

Every decision writes a `receipt-schema-v1` JSONL receipt under
`research/jev-assay/reports/` (assay-local; never the production kernel)
with: receipt/question-set/policy versions, case/task, evidence digest,
provider/model identity, questions, typed answers, probabilities,
composed label, disposition, latency, usage/cost, timestamps, transport
status, failure class.

## Live-run preconditions (all mandatory)

```text
TYPESAFE_API_KEY
GHOSTPING_LIVE_JEV=1
--max-requests N   (enforced before every outbound request)
```

CI never makes live requests. Secrets are never persisted; errors redact
credentials. Live spend requires explicit authorization per run.

## Verdicts

Exactly one of `KEEP | KILL | INSUFFICIENT_EVIDENCE` per the mission's
verdict logic. Without a live held-out execution the only honest verdict
is `INSUFFICIENT_EVIDENCE`.
