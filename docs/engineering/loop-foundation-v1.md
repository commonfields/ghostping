# Loop foundation V1 (canonical architecture)

Branch: `feat/loop-foundation-v1`. Assay: `docs/engineering/loop-foundation-assay-v1.md`.
Covers one product loop: KNOW → OBSERVE → DIAGNOSE → ACT → VERIFY SOURCE → RE-OBSERVE → RECORD OUTCOME.

## Durable vs derived

Durable (append-only, tenant-scoped): facts + lineage, questions, check runs,
observations + raw evidence + citations, claims, judgments, interventions (+
corrections), discovery scopes/runs/frontier/observations/matches,
reobservation intents, reobservation links. Derived (never stored): issues
(from head judgments), findings, candidates, comparisons, outcomes, loop
stages, timelines.

## Stage ownership and boundaries

- KNOW: `AuthoritativeFact` + `supersedes_id` lineage; `business_authority_mode`
  guards the writer. Readers never mutate truth.
- OBSERVE: CheckRunner claims QUEUED runs, executes providers, persists
  raw evidence → observation → SUCCEEDED in one transaction scope; failures
  keep attempt evidence and never fabricate observations.
- DIAGNOSE: claims transcribed from observations, human judgments, derived
  issues; representation/discovery evidence is candidate-grade, never verdict.
- ACT: `interventions` + `intervention_issues`, actor from session identity,
  corrections as new rows. No automation.
- VERIFY SOURCE: existing bindings/observations/discovery evidence;
  unlinked targets read UNKNOWN. No auto-promotion, no fixed-checkbox.
- RE-OBSERVE: intent row (issue/observation/optional intervention/check run/
  author, no outcome columns) created with the QUEUED check; worker finalizes
  the link on success only (UNIQUE + insert-or-select, sweep recovery).
  FAILED checks retain intent, surface MEASUREMENT_FAILED, never invent links.
- RECORD OUTCOME: `measurementSignature`/`compareMeasurements`/
  `deriveObservedChange`/`deriveOutcome` in `packages/protocol` are the sole
  authority; DB/API/UI must not copy them. Unreviewed/ambiguous after-states
  force INDETERMINATE. Causal attribution is always UNKNOWN.

## Failure and crash semantics

Claim-then-execute with lease reclaim (checks + discovery + frontier);
heartbeat while processing; 304/validator reuse only under identical
authority digest + matcher; migration batch under advisory lock; packet
export validates its own output fail-closed.

## Closeout amendments (final)

- Atomic creation: `ReobservationIntentRepository.enqueueReobservation`
  validates lineage, inserts the QUEUED check run, and inserts the intent in
  ONE transaction. A re-observation run can never exist without its intent;
  `CheckRunRepository.enqueue` remains the ordinary-check path.
- Attempt authority: intents joined to check runs (QUEUED/RUNNING/FAILED/
  COMPLETED, plus transient FINALIZING for SUCCEEDED-with-observation
  awaiting the sweeper). Failed attempts stay visible with failure class;
  never outcomes.
- Source alignment vs change: alignment reuses RepresentationFinding;
  change requires same-binding before/after digests ordered around the
  latest intervention (digest equality decides; missing digests refuse).
  Disagreeing bindings stay UNKNOWN rather than picking a winner.
- Measurement backstop: trigger enforces same business/question/provider
  and NULL-safe requested-model equality on intent insert; single-active
  attempt per issue (typed 409); questions are insert-only so question_id
  pins the exact prompt.
- `GET /reobservations` stays a narrow diagnostic surface; `/loop` is the
  canonical product read model.
- Recheck UI lists every intervention for history but marks superseded rows
  so new evidence links the current head.

## Comparability and UNKNOWN

EXACT_MATCH/COMPARABLE/NOT_COMPARABLE/INDETERMINATE preserved; prompt digest
is authoritative (no silent substitution); UNKNOWN in critical dimensions
forces INDETERMINATE; missing evidence reads as NOT_OBSERVED/MEASUREMENT_FAILED,
never as no-change.
