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
ghostping facts add --subject pricing --predicate monthly_price \
  --value '$39' --type currency --source manual
ghostping claims add --observation <obs-id> --text 'Ghostping costs $29 per month'
ghostping judgments add --claim CLM-0001 --fact FACT-0001 \
  --verdict contradicted --reviewer human
ghostping integrity report [--claim CLM-0001]
```

Empty lists exit 0 with guidance; unknown IDs exit non-zero (see
`docs/engineering/cli-exit-contracts.md` conventions and
`scripts/check-cli-contracts.sh`).
