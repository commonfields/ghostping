# Jev Judgment Assay — Protocol v1 (preregistered)

Status: PREREGISTERED. Thresholds and question sets below predate all
results. Once held-out evaluation begins, `question-set-v1` and
`threshold-policy-v1` are frozen; any change requires v2 and a new
protocol version. Do not tune against the holdout.

```text
HOLDOUT_MODEL_EXPOSURE_COUNT = 0
```

No live Jev response has been received, so the protocol corrections in
v1.1 (explicit live split, budget gate, model pinning, per-question truth
maps, run manifest) repair the harness without contaminating any model
evaluation. After the first held-out Jev response: no edits to questions,
policy, truth maps, labels, or split without a protocol v2.

## Research question

Can Jev classify narrow semantic relationships over OpenRecord evidence
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
--split holdout              (explicit; live+implicit-all is refused;
                              live+all needs --allow-all-split)
--max-requests N             (enforced before every outbound request)
```

Budget sanity precedes everything: `cases_selected × 1 request/case` (all
questions batched per call) must fit `--max-requests`, else
`INSUFFICIENT_REQUEST_BUDGET` before any manifest, request, or receipt.
Partial benchmarks are forbidden.

## Model pinning

Before the benchmark, `GET /v1/models` (official discovery) resolves
`jev-latest` to one frozen string sent on every request. When no concrete
version is establishable, `MODEL_PINNING = UNSUPPORTED_BY_PROVIDER` is
recorded and the alias is frozen instead. Every receipt records the
provider-reported model; more than one distinct identity in a run yields
`RUN_INVALIDATED_MODEL_DRIFT` and bars a KEEP verdict.

## Raw-Noul calibration targets (frozen)

Binary truth per question, derived from constructed labels (stored as
`noul_truth` per dataset row; AMBIGUOUS rows excluded and counted):

```text
Task A  SUPPORTED    full=T contra=F part=F enough=T
        CONTRADICTED full=F contra=T part=F enough=T
        PARTIAL      full=F contra=F part=T enough=T
        INSUFFICIENT full=F contra=F part=F enough=F
Task B  SUPPORTS     entails=T conflicts=F enough=T
        CONTRADICTS  entails=F conflicts=T enough=T
        AMBIGUOUS    (excluded)
        INSUFFICIENT entails=F conflicts=F enough=F
```

Reported per question: Brier, mean predicted p, empirical positive rate,
sample count, calibration bins. The older single "Brier score" over AUTO
decisiveness is renamed `selective_confidence_brier` and documented as
decision-confidence, NOT Noul calibration.

## Run manifest

Written before request #1 (`run-manifest.json`): run id, protocol +
question/threshold/receipt versions, dataset version, split,
holdout digest, requested alias, resolved model, pinning status,
selected/planned/max requests, start time. `completion.json` lands
afterwards (completed_at, actual/succeeded/failed, observed identities,
drift verdict). Preregistered fields are never mutated.

CI never makes live requests. Secrets are never persisted; errors redact
credentials. Live spend requires explicit authorization per run.

## Verdicts

Exactly one of `KEEP | KILL | INSUFFICIENT_EVIDENCE` per the mission's
verdict logic. Without a live held-out execution the only honest verdict
is `INSUFFICIENT_EVIDENCE`.
