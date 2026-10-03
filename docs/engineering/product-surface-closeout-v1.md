# Product Surface Closeout V1

Branch: `feat/product-surface-v1` (PR #16). Supplements
`docs/engineering/product-surface-assay-v1.md` with the six semantic fixes.

## 1. Effective evidence: latest attempt vs latest successful check vs value

Three explicit concepts, which may point at different `SourceObservation`
rows. `resolveEffectiveEvidence` / `resolveHistory`
(`packages/representation/src/effective.ts`) are the single canonical
resolvers used by both `buildGraph` and the API read model
(`apps/api/src/reads.ts` maps rows to domain types and delegates; no
duplicated comparison logic).

- `latest_attempt`: newest collection of any state, including FAILED.
- `latest_successful_check`: newest FETCHED / NOT_MODIFIED.
- `effective_value_observation`: newest successful check carrying an
  extracted value, walked back across value-less rows.

A 304 NOT_MODIFIED (or an unchanged-digest FETCHED with skipped
extraction) stores no value row and proves the previous representation
unchanged: finding stays IN_SYNC on the older $49 evidence while
`latest_attempt` shows the 304. A later FAILED timeout stays visible
separately; last successful verification remains the 304. History shows
per-attempt states (FETCHED→derived, NOT_MODIFIED→carried IN_SYNC,
FAILED→attempt-level UNKNOWN). No value rows are manufactured.

## 2. Verification identity follows logical manifest lineage

`source_bindings.managed_key` (migration 0008, partial unique over
business/key/target/extractor/comparator) decouples the stable logical
identity from the mutable fact-row UUID. Reconciliation finds the managed
row and advances `fact_id` in place (same binding id across v1→v2→v3 and
reactivation); pre-lineage duplicates are adopted once (oldest same-key
row); otherwise exactly one row is created. Hosted/manual bindings
(`managed_key` NULL) keep exact-match identity and are never adopted.
Old observations/values keep their original `fact_id` references untouched.

## 3. Observation citations imply no claim attribution

`aiCitations` no longer joins `candidate_claims`: one stored row yields one
result with no `claim_id`/`claim_text`. Issue detail may say an observation
returned citations and compare their URLs with tracked targets; it never
says a claim cited a source. Representation detail shows provider, model,
time, and observation links only. Duplicate provider rows are preserved
as stored, never multiplied by claim counts.

## 4. Authority history follows supersedes_id lineage

`factLineage` (cycle-safe recursive CTE both directions) plus
`assertLinearLineage` (single root, no forks/cycles/dangling/disconnects)
replace subject/predicate lookup. History works from any version, shows
every version's own provenance (never retrofitted), and malformed forks
return a typed `FactLineageForked` failure instead of a flattened lie.
