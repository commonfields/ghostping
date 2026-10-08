# Agency record V1 verification

Verdict: **BLOCKED_FOR_ONE_AGENCY_PILOT** until a configured live provider and
an authorized retrieval-backed dogfood record are verified. Local fixture
verification is not customer validation or production deployment proof.

## Repository truth

- Repository: `commonfields/openrecord`.
- Branch: `feat/agency-record-v1`; no merge to main.
- Starting HEAD: `b4bf3b63e2bd9851fed7048b706862d390bc278c`; clean worktree.
- Starting fetched origin/main: `1d4d9b8c8e87845dfdd130fcb622d409889640c5`.
- PR #42 (Phase 2 assay) was verified merged. No open PR existed at takeover.
- Claude's nine commits were preserved. The branch already contained
  worker lease recovery, Gemini grounding, the record domain, API, operator
  workspace and homepage; this continuation completed review, fixes and gates.
- Final commit identifiers, PR and remote check status are supplied in the
  completion message and Git history, rather than embedding a self-referential
  final documentation commit SHA here.

## Delivered workflow

Account/agency → three clients → three approved facts per client → one question
per fact → initial check → human review → share → agency action → manual weekly
check → human review → derived outcome.

Normal operation uses the workspace/API, with no SQL edits. The complete
[operator runbook](agency-record-v1-runbook.md) covers setup through revocation.
The UI supports three slots; the repository can observe fewer approved slots,
so the operator must finish all three before commercial delivery.

## Evidence, provider and public access

- Account and Business are reused as agency and client. Record rows bind to
  existing facts, questions, check runs, observations, citations and actions.
- Exact answer text, raw provider bytes/digest, citations, requested and
  observed model, request parameters, timestamps and grounding metadata remain
  persisted. Facts/questions and judgment corrections preserve versions.
- Approvals and reviews use the authenticated session user and server time.
  Client labels are MATCHES, CONTRADICTS and UNKNOWN.
- Commercial surface: Gemini `generateContent`, configured model default
  `gemini-2.5-flash`, tool `google_search`. Model identities are preserved;
  there is no silent fallback. No live credentials were available in the
  execution environment or repository configuration.
- Grounding counts only with a nonblank reported search query or a usable
  HTTP(S) grounding source. Enabling the tool alone is insufficient; title-only
  chunks and blank metadata remain NONE. Provider-default sampling values
  are recorded as defaults, not invented effective settings.
- Google Search suggestions are preserved separately and displayed in an
  opaque iframe sandbox with restrictive CSP. Only markup/configuration was
  verified locally; browser layout and enforcement still need a live check.
- Comparisons require matching fact/question identity, comparable measurement
  contexts, observed retrieval, ordered timestamps, human judgments and complete
  runs. CONTRADICTS→MATCHES is OBSERVED_CORRECTION; CONTRADICTS→CONTRADICTS is
  NO_OBSERVED_CHANGE; weak evidence is INDETERMINATE with its reason.
- The public route is `/open/<43-character-base64url-id>`; the API is
  `/api/public/records/<id>`. Identifiers contain 256 random bits. Revocation
  returns the same 404 as unknown/malformed IDs. Re-sharing rotates the token;
  revoked tokens cannot reactivate.
- Public projection excludes account/user/business/run/observation IDs,
  provider payloads, credentials, private review notes, unreviewed answers and
  safe/internal error details. Action notes are deliberately public.
- Public API responses have no-store, noindex and no-referrer headers.
  Operator browser writes enforce the configured application origin; all
  operator reads/writes retain agency session scoping.
- Every public page shows the visible causality disclosure. UNKNOWN and
  INDETERMINATE are not hidden. No scores, dashboards or causal claims were added.

## Adversarial checks and repairs

- Cross-tenant reads/writes, forged reviewer fields, foreign observations:
  rejected; session attribution and tenant IDs checked in integration tests.
- Token format/enumeration, unknown/revoked IDs, reactivation/deletion:
  non-disclosing responses or database refusal. Random guessing was tested
  as negative tokens; this is not an exhaustive brute-force exercise.
- Revocation/rotation during public evidence loading: additional snapshot
  binding and final access check; three race regressions return 404.
- Concurrent snapshot appends: record reads now use one repeatable-read,
  read-only transaction, preventing a mix of independently loaded revisions.
- Newly approved wording with old evidence: reproduced, then fixed. A previous
  judgment is not assigned to a new slot version; each answer keeps its own
  fact and question. Retired facts are excluded from current public information.
- Direct mutation of record-linked fact/question/check identity: database
  refusal plus regression tests. Status/active transitions remain compatible
  with existing supersession/deactivation behavior.
- Repeated saves and question-only edits: stable fact identity and preserved
  validity dates, requiring new approval only for a new slot version.
- Future/expired facts and malformed run JSON: rejected without queuing calls.
- Missing/blank grounding, changed model/fact/question, partial/provider
  failure, UNKNOWN and synthetic evidence: cannot claim observed correction.
- Credential-bearing and unsafe citation URLs: rejected in public/operator
  links. Raw answer HTML is escaped by React; suggestion HTML stays sandboxed.
- Cross-origin writes with valid cookies, including a sibling-site browser
  request lacking Origin: refused before writes/provider queuing.
- Failed saves preserve entered identity/action/review data; client-list errors
  no longer appear as an empty successful list. These UI paths were reviewed
  in source and checked by type/lint/build; browser interaction was unavailable.

## Reliability

The existing branch's 15-minute heartbeat lease recovers abandoned RUNNING
checks as FAILED / WORKER_LOST in bounded batches. Recovery never requeues work
or creates another provider request. Old owners are fenced from new attempts
and terminal completion. Assay groups terminate honestly as partial/failed;
an explicit rerun remains available. Integration tests cover crash-after-claim,
lease expiry, group recomputation, zero implicit requests and explicit rerun.
Observation completion is transactional and terminal finalization is idempotent.
The provider retry ceiling remains four attempts.

## Verification commands

Executed with Node 24.3.0, pnpm 10.12.1 and PostgreSQL 16.15 in two new,
disposable local databases. Existing pilot data was not used or changed.

- `pnpm db:migrate` twice, including migration `0023`: passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: passed; changed API and DB
  were checked again after final edits.
- `pnpm -r --workspace-concurrency=1 test`, with both TEST_DATABASE_URL and
  OPENRECORD_SCRATCH_URL configured: **950 passed across 78 files, no skips**.
- Final `vitest run src/record-view.test.ts`: 11 passed, including the final
  retired-fact regression; DB typecheck/lint/build were rerun afterwards.
- `npm run build` in `website`: passed.
- `HOSTED_SMOKE_ALLOWED=1 python3 scripts/hosted-runtime-smoke.py`: passed.
- `HOSTED_SMOKE_ALLOWED=1 python3 scripts/agency-record-runtime-smoke.py`:
  passed through built API/worker, three TEST clients, nine approved facts,
  initial/follow-up checks, TEST reviews, raw answers, indeterminate outcomes,
  stable shares and revocation. It never called a live provider.
- Rust fmt/clippy/tests/debug and release builds, protocol fixtures and offline
  CLI/release/installer scripts: passed (exact commands and counts below).
- `git diff --check`: passed.

The first simultaneous test/typecheck/lint run exceeded three existing assay
timing thresholds. The full sequential workspace run passed without changing
thresholds or extraction code. The web build retains a non-blocking bundle-size
warning. No gate was weakened or replaced with a fabricated success.

The final retired-fact projection case was added after the full DB suite had
loaded. Its module was then rerun with all 11 cases, followed by DB
typecheck/lint/build; the full workspace count above does not include that
additional case.

Rust/offline commands:

```text
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --locked             # 165 passed, none ignored
cargo build --locked --bin openrecord
cargo build --release --locked
cargo test --locked --test evidence_protocol_fixtures  # 4 passed
OPENRECORD_BIN=/Users/wira/openrecord/target/debug/openrecord bash scripts/check-cli-contracts.sh  # 73 passed
bash scripts/test-validate-release.sh         # 4 passed
bash scripts/test-install.sh                  # 7 passed
```

The release build completed in 16 minutes on this Intel Mac. GitHub CI is a
separate remote gate; its status is reported with the PR rather than inferred
from these local results.

## Boundaries and commercial handoff

T3 preview opened a tab but navigation, snapshots and evaluation timed out,
despite local HTTP reachability. No alternative browser was used, and no
browser interaction or visual-validation claim is made.

No live dogfood ran. No real agency/client identity, approved business fact,
publication permission, invoice, payment, renewal or customer quote was
fabricated. Their actual availability outside this workspace is unknown.
Credentials and a controlled target are required for the live handoff.

No deployment, DNS/domain redirect or merge was performed. The Rust CLI,
general assay extraction, frozen analytics/SEO/automation features and existing
account onboarding were intentionally left unchanged in this continuation.

Engineering capability answers: manual delivery without SQL **YES** after
deployment/provider setup; stable revocable URL **YES**; raw answers/citations
**YES**; all three human decisions **YES**; all three weekly outcomes **YES**;
visible causality limitation **YES**. Live operational readiness remains
blocked by credentials and live dogfood/browser/deployment verification.
