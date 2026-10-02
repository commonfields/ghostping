# Re-observation V1

A re-observation is a later, immutable observation linked to an issue (and therefore to the original observation), and optionally to an intervention. It never implies causality.

## Storage vs derivation

PostgreSQL stores only the link `reobservations(business_id, original_observation_id, issue_id, intervention_id?, observation_id, created_at)`. The table is append-only. It is unique on `(issue_id, observation_id)`. An insert trigger enforces:

- the issue is a claim on the original observation in the same business
- both observations belong to that business
- the later observation was collected after the original
- a cited intervention is linked to the issue

Signatures, match classification, observed change, verdicts, and outcomes are **derived at export** by `@ghostping/protocol`, with the same rules mirrored in Rust. No `corrected`, `outcome`, or `match_classification` column exists.

## `MeasurementSignatureV1`

Derived from a measurement context. It contains no timestamps.

`business_id`, `question_id`, `question_version`, `exact_question_digest` (SHA-256 of the exact prompt), `surface_kind`, `product`, `adapter`, `adapter_version`, `gateway`, `requested_provider`, `requested_model`, `observed_provider`, `observed_model`, `search_mode`, `locale`, `region`, `personalization_state`, `generation_configuration` (the requested `measurement_configuration`).

## Match classification

`compareMeasurements(before, after)`:

1. **Identity.** If business, question id, exact-prompt digest, surface kind, product, or adapter differ → `NOT_COMPARABLE`.
2. **Established conflict.** If any Knowledge dimension is established on both sides (`KNOWN` or `NOT_APPLICABLE`) but differs → `NOT_COMPARABLE`. Examples: a different provider, model, locale, search mode, or configuration, or `KNOWN` on one side against `NOT_APPLICABLE` on the other.
3. **Critical unknown.** If `gateway`, `requested_provider`, `requested_model`, `search_mode`, `personalization_state`, or `generation_configuration` is `UNKNOWN` on either side → `INDETERMINATE`.
4. **Supporting unknown.** If `question_version`, `observed_provider`, `observed_model`, `locale`, or `region` is `UNKNOWN` on either side, or `adapter_version` differs → `COMPARABLE`.
5. Otherwise → `EXACT_MATCH`.

**Hidden-variable proof.** Step 3 or step 4 catches every `UNKNOWN` before step 5 can run. So `EXACT_MATCH` requires every dimension to be `KNOWN` or `NOT_APPLICABLE` on both sides and equal. Two `UNKNOWN` values never prove equality. A test checks every dimension in both languages: `UNKNOWN` on both sides of an otherwise identical pair never yields `EXACT_MATCH`.

## Outcome

`observed_change`: `INDETERMINATE` unless the match is `EXACT_MATCH` or `COMPARABLE`. Otherwise `NO_CHANGE` or `CHANGED` by exact normalized answer text.

`before_verdict` is the head of the issue claim's judgment chain. `after_verdict` is the head of the chain for the single claim on the later observation. With zero claims, or more than one, `after_verdict` is `null` and the claim is listed as unknown.

| Condition | Outcome |
| --- | --- |
| match not `EXACT_MATCH`/`COMPARABLE`, or a verdict missing | `INDETERMINATE` |
| `CONTRADICTED` → `SUPPORTED` | `OBSERVED_CORRECTION` |
| `SUPPORTED` → `CONTRADICTED` | `OBSERVED_REGRESSION` |
| other verdict change, or same verdict with changed answer | `OBSERVED_DIFFERENCE` |
| same verdict, same answer | `NO_OBSERVED_CHANGE` |
| intervention or issue with no re-observation (packet level) | `NOT_OBSERVED` |

`causal_attribution` is always `UNKNOWN`. The strongest statement V1 permits is: *"After intervention X, a comparable re-observation changed from CONTRADICTED to SUPPORTED."*

## Authority over time

Each judgment names the exact fact versions it used. Packets carry every referenced version and its ancestors. The renderer states when the two judgments used different fact versions, and when a fact version was not valid at the time the AI responded. A historical answer is never silently compared to a later fact. The `superseded-fact` fixture shows the case.
