# Representation integrity (pilot)

Three different realities, three different records. Nothing here rewrites
anything else.

## The boundary

```text
RAW PROVIDER RESPONSE
        ↓ (immutable, content-addressed)
immutable Observation (evidence.db: observations + raw_evidence)
        ↓ (deterministic provider interpretation)
manually selected CandidateClaim (extraction_method = MANUAL, always)
        ↓ (human-authored review)
HumanJudgment (append-only, versioned via supersedes links)
        ↓ (derived at read time)
IntegrityFinding (never stored, never scored)
```

- A judgment never rewrites its observation.
- A fact is never rewritten from an AI answer (facts supersede, old rows stay).
- No classifier inference exists in this layer, so none can leak into truth.

## Authoritative facts

Business-authorized assertions with `ACTIVE | SUPERSEDED | RETIRED`
statuses (never TRUE/FALSE — the registry is authorization, not
metaphysics). Value types: `text|number|currency|boolean|date|url|enum`,
validated but never normalized. Validity windows (`valid_from/valid_until`)
let historical observations compare against the fact valid at their time
(`facts_valid_at`). Sources: `manual|website|product_catalog|
policy_document|other`; manual facts are honestly labeled manual.

Versioning example from tests: `FACT-0001 price=$29` →
`FACT-0002 price=$39 supersedes FACT-0001` (row 1 kept, marked superseded).

## Claims and judgments

- Claims require an existing `observation_id` (unknown → hard error).
  `EXACT_SPAN` when span text is supplied (offsets optional, never
  invented); otherwise `MANUAL_TRANSCRIPTION`. No automatic extraction of
  any kind exists on this path by design.
- Judgments require an existing claim + ≥1 same-project fact. Duplicate
  identical judgments are **idempotent** (return the existing id, no new
  row). Changed decisions are new versions linked with `--supersedes`;
  `latest_judgment` resolves the un-superseded head. History is kept for
  auditability, classifier evaluation, disagreement analysis, calibration.

## Findings

Derived per claim: state ∈ `SUPPORTED | CONTRADICTION | PARTIAL |
INSUFFICIENT | UNJUDGED` from the latest judgment + referenced facts.
`SUPPORTED` describes the judged observation only — the report says so
explicitly. No scores, no causal claims.

## Workflow

```bash
openrecord facts add --subject pricing --predicate monthly_price \
  --value '$39' --type currency --source manual
openrecord claims add --observation <obs-id> --text 'OpenRecord costs $29 per month'
openrecord judgments add --claim CLM-0001 --fact FACT-0001 \
  --verdict contradicted --reviewer human
openrecord integrity report [--claim CLM-0001]
```

Empty lists exit 0 with guidance; unknown IDs exit non-zero (see
`docs/engineering/cli-exit-contracts.md` conventions and
`scripts/check-cli-contracts.sh`).

## Human-label compounding loop

```text
business-authorized fact
→ observed AI claim
→ human adjudication
→ assay-exportable labeled case
```

`integrity export-assay` writes deterministic Task-A JSONL where
`label_origin = human_adjudicated` means exactly one thing: the label came
from a `HumanJudgment` record. It does NOT mean OpenRecord independently
verified the business fact. Only current (unsuperseded) judgments export;
history never exports as independent ground truth. Deterministic ordering
(by claim id); stable case ids (`human-{claim}-{judgment}`); no timestamps
in identity.

## Fact conflict semantics

`FACT_AUTHORITY_CONFLICT` (different values, overlapping ACTIVE windows)
and `REDUNDANT_ACTIVE_FACTS` (identical values) are derived views over
`(project, subject, predicate)` groups. SUPERSEDED/RETIRED rows are history
and never conflict. OpenRecord surfaces conflicts (`facts conflicts`,
insert warnings, report notes) and never chooses a winner automatically;
human reviewers may deliberately judge against any fact. Conflicts are
product data: `facts conflicts` exits 0 with or without them.

## Temporal model (V1)

- Bounds accept `YYYY-MM-DD` or RFC3339 (offsets honored); malformed bounds
  are rejected at creation, original strings preserved verbatim.
- Date-only `valid_from` → 00:00:00 UTC that day; date-only `valid_until`
  → exclusive 00:00:00 UTC the next day (whole date included).
- Intervals are `[start, end)`; adjacent bounds never double-include.
- Open (absent) bounds are unbounded: `(-∞,…]`, `[…,+∞)`, `(-∞,+∞)`.
- Empty windows (`end <= start` after normalization) are rejected.

> UTC normalization is a V1 engineering convention, not an assertion about
> the business's local timezone. Business-local timezone semantics are not
> modeled yet.

## Assay export

See the loop above. Evidence arrays carry every referenced fact verbatim
(no summaries). Observation provenance (provider/model/surface/
collected_at/raw digest) is resolved where available, explicit null
otherwise — never a hash of rendered text.
