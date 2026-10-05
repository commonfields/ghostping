# Before/after compare view — SPEC DRAFT

Status: spec only, no implementation. Deferred in `product-remap-v1.md` §4/§13; roadmap item 3.

## Reality check

The compare **data** exists; the compare **view** does not. `GET /api/businesses/:id/issues/:claimId/loop` (`router.ts:1080`) already returns `latestComparison` — before/after sides, `matchClassification`, `observedChange`, `outcome`, `causalAttribution`, `measurementStatus` — all derived at read time by `buildLoopComparison`/`buildIssueLoop` (`apps/api/src/issue-loop.ts`) over protocol fns. `issue.tsx` renders only `displayCopy` + `comparabilityExplanation` in the Outcome stage of the timeline. Packet export remains the only other consumer. So this is presentation + one endpoint, not new derivation.

## Data needed

- Bound `observed_source_values` rows (one per binding, `extraction_state = OBSERVED`, non-null value) ordered around the latest intervention head — before side = that relation's captured `before_source_observation_id`; after = earliest successful observation at/after `performed_at`. Digests live on `source_observations.body_digest` (`documentChanged`, supporting only). 304-reuse walks back to the newest older OBSERVED value; failed extraction stays UNKNOWN.
- Both measurement signatures via `measurementSignature`; `compareMeasurements` → `EXACT_MATCH` / `COMPARABLE` usable, `INDETERMINATE` / `NOT_COMPARABLE` / `MEASUREMENT_FAILED` not.
- Outcome states from `deriveOutcome`: `OBSERVED_CORRECTION` / `OBSERVED_REGRESSION` / `OBSERVED_DIFFERENCE` / `NO_OBSERVED_CHANGE` / `INDETERMINATE` / `NOT_OBSERVED`.

## API

`GET /api/businesses/:id/issues/:claimId/compare` → `{ before, after, sourceVerification, matchClassification, observedChange, outcome, causalAttribution: "UNKNOWN", unknowns: [{ subjectId, field }] }`, reusing the `/loop` loader. Reuse `LOOP_DISPLAY_COPY`; never restate protocol rules.

## UI sketch

Two columns: source extracts (before/after values, comparator) above AI answers (full text, provider/model, citations, claim, verdict); a chronology rail beneath (observed → judged → action → source check → recheck → reviewed → outcome).

## Non-goals

No causality, scoring, or propagation-time claims; `causal_attribution` stays UNKNOWN.