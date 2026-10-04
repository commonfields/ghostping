# Loop Foundation V1 — Phase B0 Reachability Assay

Scope: read-only assay of the closed-loop path
KNOW → OBSERVE AI → DIAGNOSE → ACT → VERIFY SOURCE → RE-OBSERVE → RECORD OUTCOME.
Branch: `feat/loop-foundation-v1`. No code changed; this doc is the only artifact.

## 0. Vocabulary used below

- **Durable object**: a row that persists intent or evidence (append-only or guarded-mutable job state).
- **Derived object**: computed at export/read time from durable rows; never stored as truth.
- **Comparability entry point**: code that decides whether a before/after pair may be compared.
- **Causality boundary**: the line across which the system must not claim "X caused Y".

## 1. KNOW (authoritative truth)

Durable objects:

- `authoritative_facts` — one row per fact version: `subject/predicate/value_text/value_type/status/version/supersedes_id/valid_from/valid_until/source_kind` (`packages/db/migrations/0001_init.sql`). `supersede` inserts v+1 and marks prior SUPERSEDED; `retire` marks RETIRED; no in-place value mutation (`packages/db/src/repositories.ts`, `FactRepositoryLive`).
- `business_authority_mode` + `repository_fact_provenance` — single-writer rule per business (HOSTED vs REPOSITORY_MANIFEST), per-version provenance (`packages/db/migrations/0005_truth_projection_v1.sql`, `0006_truth_closeout_v1.sql`, `0007_truth_source_url_v1.sql`).
- `buyer_questions.prompt` — immutable Hosted V1 prompt; `hostedQuestionVersion` derives `question_version = sha256(prompt)` so the exact-prompt digest is the version (`packages/db/src/evidence.ts`).

Derived objects:

- Authority conflicts: computed, never auto-resolved — `detectAuthorityConflicts` (`packages/domain/src/index.ts`), surfaced as `conflicts` in `GET /api/businesses/:id/facts` (`apps/api/src/router.ts`).
- Fact lineage/history: `factLineage` recursive CTE (`packages/db/src/product.ts`) + `assertLinearLineage` fail-closed on fork/cycle/disconnect (`apps/api/src/reads.ts`); discovery freezes its own snapshot via `buildAuthoritySnapshot` (`packages/discovery/src/service.ts`).
- `factsAt` (`packages/protocol/src/measurement.ts`): authority versions valid at an instant, `[from, until)`; overlaps stay explicit.

Code paths:

- Writes: `POST /facts`, `POST /facts/:factId/supersede`, `POST /facts/:factId/retire` (`apps/api/src/router.ts`) → `FactRepository`.
- Reads: `GET /facts` (+provenance map), `GET /facts/:factId/history` (+per-version provenance), web `TruthPage` (`apps/web/app/routes/truth.tsx`).

Ownership / transactions / failure / crash:

- Ownership: API (`FactRepository`) for HOSTED; manifest sync (with `SET LOCAL ghostping.authority_sync`) for REPOSITORY_MANIFEST; direct hosted mutation on managed businesses fails closed as typed `AuthorityError` defect → HTTP 409 (`packages/db/src/repositories.ts`, `apps/api/src/router.ts`).
- Transactions: single-row INSERT/UPDATE per op; mode transition immutable once facts exist (trigger `check_authority_mode_transition`); single-ACTIVE-per-manifest-key backstop trigger.
- Failure semantics: overlapping ACTIVE validity → 422 `FactAuthorityConflict` on create; supersede/retire on managed business → 409; lineage fork → `FactLineageForked` → 500 (fail closed, never flattened).
- UNKNOWN handling: absent mode row = HOSTED; absent provenance = null (unknown, not fabricated).
- Crash: each fact row is self-contained; no multi-step fact transaction to strand.

Causality boundary: KNOW asserts "the business stands behind version N over [from,until)"; it never claims what an AI or source said.

## 2. OBSERVE AI (collect AI answers as evidence)

Durable objects:

- `check_runs` — QUEUED → RUNNING → SUCCEEDED|FAILED queue with `attempt_count`; atomic `claimOne` via `FOR UPDATE SKIP LOCKED` CTE (`packages/db/src/repositories.ts`).
- `raw_evidence` — content-addressed by digest (`digest UNIQUE`, immutable trigger); `raw_bytes_hex/received_at/provider_metadata` added in 0003; failed-attempt bytes live separately in `provider_attempt_evidence` (composite FK to `(check_run_id, business_id)`, RUNNING-scoped insert) (`migrations/0001_init.sql`, `0011_provider_attempt_evidence.sql`, `packages/db/src/provider-evidence.ts`).
- `observations` — append-only (trigger), one row per check_run (`check_run_id UNIQUE`), carries `surface_identity/measurement_context/synthetic/citations` (`migrations/0001_init.sql`, `0003_evidence_protocol_v1.sql`).
- `observation_citations` — provider-returned citations exactly as stored (uri/title/position/attributed), immutable.
- `hostedMeasurementContext` / `surfaceForWorker` (`packages/db/src/evidence.ts`, protocol surface helpers): per-observation measurement context with `question/question_id/question_version/business_id/surface/observed_at/measurement_configuration/sample_number/repeat_id`.

Derived objects: none at this stage (raw capture only). `repeat_id = checkRunId`, `sample_number = 1`.

Code paths:

- Enqueue: `POST /api/businesses/:id/check-runs` → `CheckRunRepository.enqueue` (QUEUED).
- Execute: `CheckRunner.runOnce` (`apps/worker/src/check-runner.ts`): `claimOne` → load question → bounded retries (`MAX_PROVIDER_ATTEMPTS=4`, retryable = rate-limited/unavailable/timeout only) → `ObservationRepository.create(..., completeRun: true)` which atomically inserts raw (get-or-insert, digest-mismatch fails closed), observation, citations, and completes the run SUCCEEDED in one transaction.
- Failure path: provider error evidence recorded per attempt (`ProviderAttemptEvidenceRepository.record`); terminal `markFinished(FAILED, failureClass, safeDetail)`; two independent loops (check + discovery) in `apps/worker/src/runner.ts` so a long discovery scan never blocks checks.
- Reads: `GET /api/observations/:observationId` (account-scoped join, claim list, citation evidence), web `ObservationPage`, `ChecksPage` run history (`apps/web/app/routes/observation.tsx`, `checks.tsx`).

Ownership / transactions / failure / crash:

- Ownership: worker owns RUNNING rows only; `ObservationRepository.create` with `completeRun` requires `status='RUNNING'` + business scope or raises `SqlError` ("scoped RUNNING ownership required").
- Transaction boundary: provider execution happens **outside** any transaction; the store step (raw + observation + citations + run completion) is one `sql.withTransaction`.
- Failure semantics: `RawDigestMismatch` (wire bytes ≠ digest, or digest collision with different bytes) fails closed, keeps original raw; unsupported legacy provider → export-time `UnsupportedLegacyProvider`; terminal FAILED rows immutable (`markFinished` guarded `WHERE status='RUNNING'`).
- UNKNOWN handling: pre-protocol rows (NULL `measurement_context`) rebuild context at export with `measurement_configuration = UNKNOWN`; legacy surface rebuilt via `surfaceForWorker`; MOCK kind forces `synthetic=true` (DB check + export throw `MockObservationNotSynthetic` otherwise).
- Crash behavior: crash before store leaves QUEUED/RUNNING row with `attempt_count`; no lease reclaim on check runs (unlike discovery) — a crashed RUNNING check run stays RUNNING until operator/worker intervention; crash after provider success but before store loses that attempt (only per-attempt failure evidence may exist for failed attempts).

Comparability entry point: `hostedMeasurementContext` is the producer — comparability later depends on these fields being populated (exact prompt bytes, surface identity, request config). Pre-protocol gaps permanently cap later matches at COMPARABLE/INDETERMINATE (see §7).

Causality boundary: an observation records "provider P returned bytes B at T"; it never asserts the source that caused the answer.

## 3. DIAGNOSE (claim → judgment → derived issue)

Durable objects:

- `candidate_claims` — manual transcription only (`MANUAL_TRANSCRIPTION` / `MANUAL_EXACT_SPAN`); API hard-codes `MANUAL_TRANSCRIPTION` (`POST /api/claims`).
- `human_judgments` + `human_judgment_facts` — append-only verdicts (`SUPPORTED/CONTRADICTED/PARTIAL/INSUFFICIENT_EVIDENCE`) with fact links; supersession via `supersedes_id` chain; head = row no child points at (`JudgmentRepository.create` serializes per claim with `SELECT ... FOR UPDATE`; triggers forbid UPDATE/DELETE).
- Issue identity: **the candidate claim id is the issue id** — there is no separate `issues` table. `intervention_issues.issue_id → candidate_claims.id`; `reobservations.issue_id → candidate_claims.id`.

Derived objects:

- Issue state: `latestJudgment` head → `issueStateFor`/`deriveIssueState`/`issueStateOf` (CONTRADICTED→WRONG, PARTIAL→PARTIAL, INSUFFICIENT_EVIDENCE→UNKNOWN, SUPPORTED→RESOLVED, none→NEEDS_REVIEW) — implemented in three places that must agree: protocol `packet.ts`, domain `index.ts`, API `reads.ts`.
- Inbox: `issueList`/`issueDetailRow` (`packages/db/src/product.ts`) join claim + observation + head judgment; API filters RESOLVED out of the inbox; `loadIssueDetail` adds `citation_evidence` via `assembleCitationEvidence` (canonical-URL match to tracked representations).
- Packet-level issue: `IssueV1` assembled by `assembleEvidencePacket` (`packages/protocol/src/packet.ts`).

Code paths:

- `POST /api/claims` → `ClaimRepository.create`; `POST /api/judgments` → `JudgmentRepository.create` (account-scoped claim ownership check first).
- `GET /api/businesses/:id/issues` (batched citation evidence), `GET /api/businesses/:id/issues/:claimId` → `loadIssueDetail`; web `IssuesPage`, `IssueDetailPage` (verdict form, facts touched, citation cards).

Ownership / transactions / failure / crash:

- Ownership: HTTP boundary owns identity (account scoping via `getScoped`/joins; cross-account reads → 404, never existence leak). Judgment creation serializes per claim (row lock) so concurrent reviews form one linear chain.
- Transactions: judgment create (lock claim → insert judgment → insert fact links → read back) is one transaction; claim create is a single INSERT.
- Failure semantics: unknown/foreign claim → 404 `ClaimNotFound`; verdict chain forks/multiple heads → packet `InvalidJudgmentSupersession` at export (fail closed); dangling fact links → `DanglingReference`.
- UNKNOWN handling: unjudged claim → NEEDS_REVIEW (+ packet `explicit_unknowns: verdict`); INSUFFICIENT_EVIDENCE → UNKNOWN state (distinct from NEEDS_REVIEW); empty fact_ids allowed.
- Crash: single-INSERT granularity; no stranded multi-step state.

Causality boundary: judgment records "reviewer R compared claim C against fact versions F at time T"; citation cards explicitly state citation ≠ causation ("Citation shows the source was referenced; it does not prove the source caused the answer").

## 4. ACT (recorded intervention)

Durable objects:

- `interventions` — append-only action events: `type/target/performed_at/actor/actor_id/notes/evidence_before_digest/evidence_after_digest/supersedes_id/correction_reason` with `CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL))`, self-supersession forbidden, one-correction-per-intervention unique index (`uq_interventions_supersedes`), append-only triggers (`0003_evidence_protocol_v1.sql`).
- `intervention_issues` — (intervention, issue=claim) links with cross-business trigger.

Derived objects: none (no "corrected" flag stored; correction is a superseding row; `checkInterventionChainLinear` at packet validation enforces one linear chain per packet).

Code paths:

- `POST /api/businesses/:id/issues/:claimId/interventions` → `recordIntervention` (`apps/api/src/interventions.ts`): verifies scoped claim, hard-codes `actor=HUMAN`, `actorId=session.userId`, `issueIds=[claimId]`, `supersedesId=null`; `InterventionRepository.append` runs in a transaction (empty-issue guard, correction-pair guard, same-issues-as-superseded guard).
- `GET .../interventions` → `loadInterventions` → `listByIssue` (ordered by performed_at/created_at/id).
- Web `RecordedActionsCard` (`apps/web/app/routes/issue.tsx`): form posts `{type, target, notes}` only; copy states "Recording an action keeps a log; it changes no verdict and no observation."

Ownership / transactions / failure / crash:

- Ownership: HTTP route owns actor identity (never from request JSON; contract schema has no actor fields). Repository is the only writer.
- Transaction boundary: intervention INSERT + N `intervention_issues` INSERTs in one `sql.withTransaction`.
- Failure semantics: zero issues → `InterventionCorrectionInvalid` → 422; mismatched correction issue-set → 422; cross-tenant supersede/link → DB trigger exception. **Corrections are out of scope on the HTTP helper** (`recordIntervention` always sends `supersedesId=null`) — corrections exist only at repository/protocol level.
- UNKNOWN handling: `actor=UNKNOWN` → packet unknown `actor`; NULL `actor_id`/digests → UNKNOWN entries (never fabricated).
- Crash: atomic append; no partial intervention visible (transactional).

Causality boundary: interventions record "operator did X at T"; the protocol hard-codes `causal_attribution: UNKNOWN` and renders "Ghostping does not know whether any intervention caused a later response."

What is missing (ACT): no link from an intervention to a source-observation digest pair in the UI (form posts only type/target/notes; `evidenceBeforeDigest/AfterDigest` accepted by the contract but never populated by web — always NULL → UNKNOWN); no correction UI; no "intent to re-observe" captured at ACT time (see §7 gap 1).

## 5. VERIFY SOURCE (representation binding → collector → effective finding)

Durable objects:

- `source_targets` (url/control/enabled), `source_bindings` (fact ↔ target + extractor kind/selector + comparator; `managed_key` for repository lineage in 0008), `source_observations` (collector run: FETCHED/NOT_MODIFIED/FAILED + validators + digests), `observed_source_values` (extracted value + extraction_state + evidence locator + extractor_version) — tenancy triggers + append-only triggers on observations/values (`0004_representation_graph_v1.sql`, `0008_binding_lineage_v1.sql`).
- Bindings are editable config; observations/values are evidence.

Derived objects (never stored as truth):

- `resolveEffectiveEvidence` (`packages/representation/src/effective.ts`): three distinct pointers — `latestAttempt` (any state), `latestSuccessfulCheck` (newest FETCHED/NOT_MODIFIED), `effectiveValueObservation` (walk back across 304s/unchanged-digest skips to newest successful check carrying a value); `deriveFinding` (`evaluate.ts`): IN_SYNC / DRIFT / UNKNOWN with explicit reasons; absence never becomes contradiction.
- `resolveHistory` per-observation findings; `buildGraph` (`graph.ts`); canonical citation match `sameCanonicalUrl` (`url.ts`).
- Collector cache rule `shouldReuseExtraction` (`policy.ts`): 304 or unchanged digest + same extractor/comparator → skip re-extraction, store **no** new value row (proves previous representation unchanged without erasing it); collection targets only explicit origins (OPERATOR/FACT_SOURCE/AI_CITATION), no crawl (`TARGET_ORIGIN`).

Code paths:

- Collection orchestration: `collectAndEvaluate` (`packages/representation/src/service.ts`) — fetch previous validators → `NativeHttpCollector.collect` (via `safeFetch`) → insert observation → per binding maybe-skip → run extractor (JSON_LD/CSS_TEXT/META_CONTENT) → insert values. (No hosted cron/scheduler wires this in the assayed tree — reads assume rows exist.)
- Reads: `loadRepresentations`/`loadRepresentationDetail` (`apps/api/src/reads.ts`) assemble `RepresentationRowDto` with `finding + effective_observation + latest_attempt + latest_successful_check` distinctly; `GET /representations`, `GET /representations/:bindingId` (+ `findingHistoryForBinding`, citation matches); web `RepresentationsPage`, `RepresentationDetailPage` (shows effective vs latest vs latest-successful separately, incl. `failedLatest` case).

Ownership / transactions / failure / crash:

- Ownership: representation store injected (`RepresentationStore`); persistence split from orchestration.
- Transactions: observation insert then value inserts (no single stated transaction in `collectAndEvaluate`; store-dependent).
- Failure semantics: FAILED collections yield finding UNKNOWN for that attempt only ("collection did not produce evidence"); UNSUPPORTED extraction/comparison → UNKNOWN with reason; FAILED never replaces prior valid evidence (`latestSuccessfulByTarget`).
- UNKNOWN handling: first-class (`NOT_FOUND/AMBIGUOUS/UNSUPPORTED/FAILED` extraction states; money/boolean comparison uncertainty → UNKNOWN).
- Crash: observation without values is a legal state (means "no extraction"); walk-back logic tolerates it.

Causality boundary: findings state "observed value at URL equals/differs-from authority (or unknown)"; graph creates only CITED edges, never CAUSED_BY.

## 6. RE-OBSERVE (AI re-measurement linked to an issue)

Durable objects:

- `reobservations` — pure lineage links: `(business_id, original_observation_id, issue_id, intervention_id NULLABLE, observation_id)` with `UNIQUE (issue_id, observation_id)` and `CHECK (original <> observation)` (`0003_evidence_protocol_v1.sql`).
- DB trigger `check_reobservation_lineage` enforces: issue claim belongs to business + original observation; both observations belong to business; **after.collected_at > before.collected_at**; optional intervention must already link to the issue via `intervention_issues`.
- Repositories: `ReobservationRepository.append/listByIssue`; `EvidenceLineageRepository.loadIssue` loads the full lineage in one `REPEATABLE READ READ ONLY` transaction (claim + original + re-observation chain + claims on after-observations + judgments + referenced facts + ancestors + interventions + links).

Derived objects (protocol only, never stored):

- `measurementSignature` (exact prompt bytes digest + surface + config), `compareMeasurements` (EXACT_MATCH/COMPARABLE/NOT_COMPARABLE/INDETERMINATE with critical vs supporting UNKNOWN rules), `deriveObservedChange`, `deriveOutcome` (needs usable match + non-null before/after verdicts), `latestJudgment`/`soleClaim`, `ReobservationV1` assembly, `observed_outcome` (latest re-observation outcome or NOT_OBSERVED), `packetDigest`/seal, fail-closed `validatePacket` (schema → digest → references → linearity → full re-derivation `DerivationMismatch`).

Code paths (all exist at the **storage + export** layer; none at the **intent/scheduling** layer):

- Link: `ReobservationRepository.append` (direct DB/Effect use; integration test builds PART-11 lineage this way).
- Export: `exportIssuePacket({accountId, businessId, issueId, generatedAt})` → `exportEvidencePacket` → `validatePacket` (self-check); `renderEvidencePacket` controlled-language view; `EvidencePacketInvalid` reasons (`DigestMismatch/DanglingReference/DerivationMismatch/…`).
- **No HTTP route creates or lists re-observations** (grep for `reobserv|Recheck|recheck` in `apps/api/src` returns nothing; router has no re-observation endpoint).
- **No worker path creates re-observation links** (`CheckRunner` stores plain observations; never links them to issues).
- **No web affordance**: issue page has no "Recheck AI" button; checks page runs ad-hoc checks with no issue linkage; observation page has no "link as re-observation of issue X".

Ownership / transactions / failure / crash:

- Ownership: whoever holds a DB handle can append a link (no API ownership seam exists yet); tenancy enforced by trigger.
- Transaction boundary: single-row INSERT (trigger checks run inside it).
- Failure semantics: cross-tenant/lineage-violating/earlier-collected links raise trigger exceptions; duplicate (issue, observation) rejected; export of unformable lineage fails closed (`EvidenceExportError`, `PacketAssemblyFailed`) instead of exporting.
- UNKNOWN handling: `soleClaim` null (zero/ambiguous claims on after-observation) → `after_claim` unknown; null after-verdict → `after_verdict` unknown; any critical UNKNOWN → INDETERMINATE; interventions with zero re-observations → `outcome_after_intervention` unknown.
- Crash: link INSERT atomic; the after-observation must already exist (created by the normal check path first).

## 7. RECORD OUTCOME (before/after compare read model + issue timeline)

What exists:

- Packet export (`exportIssuePacket`) computes outcome (`OBSERVED_CORRECTION/OBSERVED_REGRESSION/OBSERVED_DIFFERENCE/NO_OBSERVED_CHANGE/INDETERMINATE/NOT_OBSERVED`) **at export time only**; `observed_outcome` = latest re-observation outcome.
- `renderEvidencePacket` narrates interventions + each re-observation (match class, later claim/verdict, outcome sentence, causal-UNKNOWN disclaimer).
- API issue reads expose current-state only: `issueList`/`issueDetailRow` (claim + head verdict + linked fact versions + citation evidence); representation detail exposes per-observation finding history (`findingHistoryForBinding`).
- Golden fixtures re-derived in both TS and Rust (`measurement.ts` header; `src/evidence_protocol.rs` mirror).

What is missing (the loop does not close in product):

1. **Re-observation intent before async completion.** There is no durable "requested recheck" object. `POST /check-runs` enqueues a bare check (no `issue_id`, no `intervention_id`, no expected comparability envelope). A later observation therefore cannot be attributed to an intent; linkage can only be reconstructed after the fact by hand-inserting a `reobservations` row. Required: intent row (issue + intervention? + requested measurement envelope + QUEUED→RUNNING→SUCCEEDED/FAILED state) claimed by the worker, with crash/lease semantics like discovery runs.
2. **Before/after compare read model.** No API or web view shows before-signature vs after-signature, `match_classification`, `observed_change`, or `outcome` for an issue. `loadIssueDetail` returns no re-observation list, no signatures, no outcome. The only consumer of `compareMeasurements/deriveOutcome` is packet export (plus tests).
3. **Issue timeline.** No chronological view interleaving claim → judgments → interventions (+corrections) → re-observation requests → after-observations → outcomes. `GET .../issues/:claimId` returns the head row; `GET .../interventions` returns actions alone; judgments history is reachable only via observation claims; re-observations are unreachable via HTTP at all.
4. **Recheck AI action.** No button/route that, from an issue, enqueues a comparable re-measurement (same question bytes, same surface kind/product/adapter, same generation config) and records the intent from gap 1. The checks page "Run check" is unlinked labor.
5. **Comparability pre-check.** No endpoint that, given an issue, previews whether a fresh run would be EXACT_MATCH/COMPARABLE (e.g., prompt edited since? adapter version drifted? critical dimensions UNKNOWN on the original?). Operators discover INDETERMINATE only after export.
6. **Packet surfacing.** `exportIssuePacket` has no HTTP route; packets, digests, and the controlled-language rendering are not viewable/downloadable from API or web. `validatePacket` is export-self-check + tests only.

## 8. Cross-cutting properties (for the implementer)

- **Ownership summary.** KNOW: API vs manifest sync (mode-guarded). OBSERVE AI: worker (queue claim) + provider adapters. DIAGNOSE: humans (claims/judgments via API). ACT: humans via API (actor forced HUMAN/session user). VERIFY SOURCE: collector orchestration + store injection. RE-OBSERVE/OUTCOME: **unowned** — DB triggers + protocol pure functions exist, but no service owns intent→execution→linkage→read-model.
- **Transaction boundaries.** Check success store (raw+obs+citations+run-finish) is one transaction; judgment create is one transaction; intervention append (+links) is one transaction; issue lineage load is one REPEATABLE READ transaction; discovery page persist (observation+matches+frontier-DONE) is one transaction (`frontier.persistPageFetch`). Network I/O always outside transactions (check-runner, discovery-runner headers).
- **Failure semantics.** Typed, fail-closed throughout: `RawDigestMismatch`, `InterventionCorrectionInvalid`, `DiscoveryActiveRunConflict`, `AuthorityError` (defect→409), `EvidenceExportError`/`EvidencePacketInvalid`, `FactLineageForked`, trigger exceptions. HTTP mapping: 401/404 (scoped, non-leaking) / 409 (conflict, duplicate scope/run) / 422 (validation, authority conflict) / 500 only for real defects.
- **Comparability entry points.** Producers: `hostedMeasurementContext`/`surfaceForWorker` (+ `requestConfigurationForWorker`). Rules: `compareMeasurements` (identity → established-difference → critical-UNKNOWN → supporting-UNKNOWN/adapter-version → EXACT). Consumers: packet assembly only. Representation has its own separate comparator family (`EXACT_TEXT/BOOLEAN/MONEY` + discovery matcher reuse) — do not conflate AI-answer comparability with source-value comparison.
- **Causality boundaries (must survive implementation).** Citations never imply causation (UI copy + graph CITED-only edges). `causal_attribution` is always UNKNOWN in V1 (schema literal). Interventions never mutate verdicts/observations. Discovery candidates are derived read-time groupings, never verification state, never IN_SYNC/DRIFT. Authority conflicts never auto-resolve.
- **UNKNOWN handling.** Explicit `UNKNOWN`/`NOT_APPLICABLE` Knowledge states; UNKNOWN never proves equality (EXACT_MATCH requires zero UNKNOWN on either side). Key UNKNOWN sources today: pre-protocol `measurement_configuration`, unreported provider metadata, unjudged claims, NULL intervention digests/actor identity, failed source collections, unsupported comparisons, missing authority digest at candidate grouping (warns, never silent).
- **Crash behavior.** Check runs: no lease reclaim (RUNNING can strand — needs attention if recheck intents build on it). Discovery runs: lease reclaim (5 min) + heartbeat (30 s) + `requeueStale` + resumable IN_PROGRESS frontier + DONE-never-refetch. Interventions/judgments/links: atomic single-transaction appends. Lineage reads: snapshot-isolated.

## 9. Gap list (implementation must close; in suggested order)

1. Durable re-observation intent (recheck request) with queue state, worker claim, and crash/lease semantics; `POST .../issues/:claimId/rechecks` + `GET` list.
2. Worker execution of intents: run the same question envelope, store observation via the existing transactional path, then append the `reobservations` link (issue + optional intervention) — or record intent FAILED with reason.
3. Before/after compare read model per issue: signatures, `match_classification`, `observed_change`, before/after verdicts, `outcome`, explicit unknowns — API DTO + web section.
4. Issue timeline API + UI: claim versions, judgment chain, interventions (+corrections), recheck intents, after-observations, outcomes, in time order.
5. Recheck AI action in web (from issue detail), wired to gap 1; disable or warn when comparability pre-check (gap 6) predicts worse than COMPARABLE.
6. Comparability pre-check endpoint against the frozen before-signature (prompt digest, surface, adapter version, critical UNKNOWNs).
7. Packet surfacing: `GET .../issues/:claimId/packet` (JSON + digest + rendered text), reusing `exportIssuePacket`/`renderEvidencePacket`/`validatePacket` without new derivation logic.
8. Decide fate of `intervention.correction_reason` UI (currently write-only at repo level) and `evidence_before/after_digest` population (currently always NULL from web) — either wire them or explicitly defer.
9. Reconcile the three issue-state derivations (protocol/domain/API) behind one import or a contract test so they cannot drift.
10. Check-run lease reclaim (or documented decision not to) once rechecks depend on check-run completion; today a crashed RUNNING check strands silently while discovery has full recovery.
