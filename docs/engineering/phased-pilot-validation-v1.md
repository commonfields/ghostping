# Phased Pilot Validation V1 — Program Log

Branch: `feat/phased-pilot-validation-v1`. One section per phase; each ends
with its PHASE HANDOFF. Claims here are bounded by the evidence cited.

## Phase 0 — Repository baseline (2026-10-07)

### Repository truth

| Item | Value |
|---|---|
| Repository | `commonfields/openrecord` |
| Branch at start | `main`, tracking `origin/main` |
| HEAD / origin/main | `703efb5206a2856787cf85cf7fe08ac6e3224624` (identical after fetch) |
| Working tree | clean |
| Open PRs | none |
| Recent merges | #40 rebrand protocol ids, #38 rebrand to OpenRecord, #37 SEARCH_OPERATOR_V1, #36 product-surface-v1 (auth layout fix), #35 managed-service runbook |
| Latest migration | `0017_authority_sync_rebrand.sql` |
| Migration model | `packages/db/src/migrate.ts` re-applies **every** `.sql` file on each run under an advisory lock; there is no applied-migrations table, so every migration must be idempotent (`IF NOT EXISTS`, `DROP TRIGGER IF EXISTS`, `CREATE OR REPLACE`) |
| Node | `engines: >=24 <25`, `.node-version` = 24; validated with v24.3.0 (system default v20.19.5 is out of range) |
| pnpm | 10.12.1 |
| PostgreSQL | CI and two tests require ≥16 (`SHOW server_version_num`); local Homebrew 14.18 fails exactly those two assertions. Baseline below ran on `postgres:16-alpine` (colima) |
| Rust CLI | separate `Cargo.toml` workspace (`src/`, `tests/`); fmt/clippy/test all green |

### Quality gates at baseline (Node 24, PG16)

| Gate | Command | Result |
|---|---|---|
| migrate | `pnpm db:migrate` | applied 0001–0017 |
| typecheck | `pnpm typecheck` | pass |
| lint | `pnpm lint` | pass |
| tests | `pnpm test` | pass — 609 passed, 2 skipped (db 93+2s, api 121, web 62, worker 48, discovery 99, representation 44, truth 36, providers 32, protocol 31, site-operator 22, domain 11, config 8, contracts 2) |
| build | `pnpm build` | pass |
| rust | `cargo fmt --check && cargo clippy -D warnings && cargo test --all-targets --locked` | pass — 165 tests |

No pre-existing failures under the CI-equivalent environment.

### Architecture as merged

Two product loops exist side by side, both under `businesses` tenancy:

1. **AI-answer evidence loop** (0001–0015): `authoritative_facts` (value
   content is versioned — a change inserts version n+1; lifecycle `status`
   is updated in place on supersede/retire) → `buyer_questions` → `check_runs` →
   `observations` (append-only, raw bytes in `raw_evidence`, citations) →
   `candidate_claims` (manual transcription only) → `human_judgments`
   (`SUPPORTED/CONTRADICTED/PARTIAL/INSUFFICIENT_EVIDENCE`) →
   `interventions` / `reobservations` / `reobservation_intents`.
   A check run produces at most one observation (`UNIQUE(check_run_id)`;
   failed runs produce none); there is no repeated-sampling concept.
2. **Site operator loop** (0016): `site_targets` → `site_inspection_runs` →
   `site_page_observations` (append-only) → `site_findings` (mutable status)
   + `site_finding_events` (append-only) → `site_fix_proposals` →
   `site_mutations` → `site_verifications`.

Supporting layers:

- `packages/representation/src/safe-http.ts` — `safeFetch`: DNS preflight
  + IP pinning, forbidden networks, redirect re-validation, byte/time caps
  (the timeout starts after DNS lookup; there is no total-operation deadline).
- `packages/representation/src/comparators.ts` — `compareMoney/Boolean/ExactText`
  (amount + currency only; no billing period, unit, or qualifier).
- `packages/providers` — `mock` and `9router` (OpenAI-compatible gateway,
  explicit model allowlist). `retrievalMode` is `unknown|grounded|parametric`;
  9router always reports `unknown`. No provider requests web search.
  No live provider credentials are present in this environment.
- `apps/worker` — three polling loops: check runs, discovery, site inspection.
- `packages/truth/src/apply.ts` — projection writer with its own
  `resolveInsideRoot` + `assertNoSymlinkEscape` (lexical + per-component
  `lstat`; root not `realpath`-resolved; check runs before planning, not
  immediately before the write; `mkdir -p` happens after the check).

### Defects found (input to later phases)

Phase 1 (mandatory security):

- `packages/site-operator/src/adapter.ts` builds every read/write path with
  `join(rootDir, filePath)` and **no containment**. `filePath` comes from the
  request body (`ApplyFixRequest.filePath`) or the site's `repoRef.fileMap`,
  both caller-controlled. `../../x` writes outside the checkout; symlinks
  inside the checkout are followed.
- `apps/api/src/site-routes.ts` `allowedRoot` is a string-prefix test with
  no normalisation or `realpath`: `${tmpdir()}/../../etc` and any path
  beginning `/private/var/folders/` pass.
- `LocalFileSiteAdapter.applyMutation` writes without comparing the current
  file to the inspected `before`; neither adapter re-checks immediately before
  the write; no before/after/approved-patch hashes or idempotency key exist on
  `site_mutations`; approval is not bound to patch content (the patch is
  recomputed at apply time from whatever the file contains then).
- One partial containment implementation (truth apply) and none in
  site-operator — the program requires one shared primitive.
- (Added after independent review) checkout roots had no tenant binding:
  any business could set `repoRef.rootDir` to another business's checkout
  inside the global allowlist; `GITHUB` sites fell through to the local-file
  adapter; truth's lock/receipt metadata writes bypassed its output checks.

Phase 6 (recorded now, not fixed now):

- `site_findings.identity_key` includes the evidence digest, so
  `noindex` → `noindex,nofollow` creates a second finding.
- Status transitions are improvised in routes and the worker
  (`findings.setStatus` with no shared transition function).
- Tenancy triggers on all `site_*` tables fire `BEFORE INSERT` only.
- `site_verifications` stores no before/after observation ids or live-state
  signal; the verify route accepts `OPEN` findings; worker verification does
  not require the observing run to be later than the mutation.

### Phase 0 handoff

```text
PHASE 0 HANDOFF

Objective:
Establish repository truth before changing anything.

Starting SHA:
703efb5206a2856787cf85cf7fe08ac6e3224624

Ending SHA:
(commit adding this note)

Commits:
docs(engineering): phased pilot validation V1 baseline

Implemented:
Baseline note only. No product code changed.

Not implemented:
Nothing beyond scope.

Tests:
typecheck, lint, 609 TS tests, build, migrations, 165 Rust tests — all pass
on Node 24 + PG16. On PG14 exactly two PG≥16 version assertions fail
(environment, not code).

Adversarial checks:
Confirmed by reading that the site-operator mutation path has no path
containment and allowedRoot is a prefix check (Phase 1 targets).

Known limitations:
No live AI provider credentials in this environment (affects Phase 3).
Docker Desktop absent; PG16 provided via colima.

Gate result:
PASS

Reason:
HEAD understood, tree clean, no pre-existing failures under CI-equivalent
environment, architecture and defects mapped.

Next authorized phase:
Phase 1 — mandatory filesystem security hardening.
```

## Phase 2 — Prospect assay tooling (2026-10-08)

Read-only tooling: approved public source → proposed facts held for human
confirmation → N repeated retrieval-aware samples → deterministic claim
judgments over CONFIRMED facts only → candidate findings → human review
queue. No mutation, outreach, scoring or CRM surface was added.

### What exists

| Piece | Where |
|---|---|
| Schema (0019 foundation, 0020 execution) | `packages/db/migrations/0019_*`, `0020_*` |
| Money normalization, comparison, thresholds | `packages/representation/src/assay.ts` |
| Page fact proposals, answer judgments | `packages/representation/src/assay-extraction.ts` |
| Sources, sampling, derivation, review repos | `packages/db/src/assay.ts` |
| Worker loop (fetch via `safeFetch`, derive) | `apps/worker/src/assay-runner.ts` |
| API + operator page | `apps/api/src/assay-routes.ts`, `apps/web/app/routes/assay.tsx` |

Behaviour that matters for interpreting results:

- **Sampling:** N defaults to 5 (1..20). Each sample is its own `check_run` and
  observation. Group status is recomputed: all ok `SUCCEEDED`, some failed
  `PARTIALLY_SUCCEEDED` (missing samples + failure class recorded), none
  `FAILED`. Thresholds use the *successful* denominator.
- **Retrieval honesty:** an observation stores the mode the provider
  *reports*. 9router reports `unknown` and refuses retrieval-enabled requests;
  the mock always reports `unknown` + `synthetic` (gated to tests or
  `ASSAY_ALLOW_SYNTHETIC=1`). Findings are classed `RETRIEVAL_ENABLED`,
  `STALE_PARAMETRIC_KNOWLEDGE`, `MANUAL_CAPTURE`, `SYNTHETIC_FIXTURE` or
  `UNKNOWN`; only `RETRIEVAL_ENABLED` is verification-eligible. The §49
  limitation text shows for everything else.
- **Human gates:** fact review (CONFIRMED / INCORRECT_EXTRACTION / AMBIGUOUS),
  fact retraction, and finding review are session-attributed, write-once, with
  server-forced timestamps. No worker/seed/script path can write them
  (architecture test). A fact is a snapshot from its source's `fetched_at`;
  answers collected earlier are never judged.
- **Comparison rule:** CONTRADICTS only on the same disclosed basis (period,
  qualifier, unit stated identically or both unstated). Hedges, negations,
  other entities, past/future/regional/segment scoping, per-unit language,
  ranges, magnitude suffixes and ambiguous currency/number syntax are UNCLEAR.
  Diagnosis is `LIKELY_SOURCE` evidence only, never a root-cause claim.

### Adversarial review log

1. Opus 5.5 round 1: 2 blockers + 6 majors (other-company/conditional
   credit; incomparable prices; mock fakes retrieval; no time binding; no
   retraction; findings not DB-enforced; ReDoS; missing §49 text). All fixed
   with regression tests.
2. Orchestrator attack round: stated-basis / negation / hedge / trial false
   contradictions; "a month" unrecognised; an over-strict unit rule that made
   natural answers incomparable (fixtures only passed because they said "flat").
3. Muse Spark 1.3 round 2 (63 price phrasings, boolean + plan-card probes):
   zero false price contradictions after (2); found adverb-interrupted
   denials, questions, "Slack-like" and segment prices ("for students") — all
   fixed with regression tests. Frontier-model reviewers were unavailable
   (usage limits) for rounds 2–3, so the last fixes have regression tests for
   every reproduced case but no further independent pass.

### Phase 2 handoff

```text
PHASE 2 HANDOFF

Objective:
Minimal read-only prospect assay tooling sufficient to run the 10-company assay.

Starting SHA:
3e7ad74 (main after PR #41)

Ending SHA:
(HEAD of feat/phased-pilot-phase2-assay; see PR)

Commits:
4374db7 foundation; 4a76a36 extraction/providers; 25a2fe9 schema 0020;
2400660 worker; b7562f2 API+UI; cde2685 + final fix commit (review rounds)

Implemented:
Sources, proposed facts, human fact review/retraction, N-sampling with
PARTIALLY_SUCCEEDED, retrieval-aware provenance, deterministic judgments,
finding derivation (CONFIRMED facts only), source diagnosis (LIKELY_SOURCE),
finding review queue + UI, DB-level tenancy/immutability.

Not implemented:
Live provider adapter with retrieval; LLM claim extraction; corroboration
engine; UI retract button (API only); lease reclaim for stuck RUNNING samples;
free-text/worded prices ("79 dollars"); non-English answers.

Tests:
typecheck, lint, build pass; migrations replay; 900 TS tests pass x2 (Node 24,
PG16, test DB unpinned). Fixture gate: fetched page -> proposed facts ->
TEST-reviewer confirm -> 5 samples -> 4/5 CONFIRMED finding -> review.

Adversarial checks:
See log above. Held: only-CONFIRMED, UNCLEAR-never-contradicts, no engineering
review path, cross-tenant INSERT/UPDATE, sample integrity, retrieval honesty.

Known limitations:
Guards are conservative: many real answers will be UNCLEAR, so yield may
understate the true problem rate. Capability phrasing coverage is narrow
("supports", "integrates with", "includes"). Plan-price proposals need
operator-supplied plan names and a single price per card. No live retrieval
provider exists in this environment, so the fixture gate does NOT show the
assay works against real engines.

Gate result:
PASS (machine-verifiable fixture gate). Not a product result.

Reason:
Gate path proven on deterministic fixtures; every reproduced adversarial
break has a regression test.

Next authorized phase:
Phase 3 is blocked on human inputs: provider credentials with retrieval, and
a human-frozen 10-company cohort. Phase 5/6 per owner instruction.
```
