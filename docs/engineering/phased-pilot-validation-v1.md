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
| Recent merges | #40 rebrand protocol ids, #38 rebrand Ghostping→OpenRecord, #37 SEARCH_OPERATOR_V1, #36 auth layout, #35 managed-service runbook |
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

1. **AI-answer evidence loop** (0001–0015): `authoritative_facts` (versioned,
   superseded never edited) → `buyer_questions` → `check_runs` →
   `observations` (append-only, raw bytes in `raw_evidence`, citations) →
   `candidate_claims` (manual transcription only) → `human_judgments`
   (`SUPPORTED/CONTRADICTED/PARTIAL/INSUFFICIENT_EVIDENCE`) →
   `interventions` / `reobservations` / `reobservation_intents`.
   One check run produces exactly one observation (`UNIQUE(check_run_id)`);
   there is no repeated-sampling concept.
2. **Site operator loop** (0016): `site_targets` → `site_inspection_runs` →
   `site_page_observations` (append-only) → `site_findings` (mutable status)
   + `site_finding_events` (append-only) → `site_fix_proposals` →
   `site_mutations` → `site_verifications`.

Supporting layers:

- `packages/representation/src/safe-http.ts` — `safeFetch`: DNS preflight
  + IP pinning, forbidden networks, redirect re-validation, byte/time caps.
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
- Two independent containment implementations (truth apply, none in
  site-operator) — the program requires one primitive.

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
