> Historical architecture snapshot. Hosted provider execution was replaced by
> [Effect runtime V1](effect-runtime-v1.md). The IPC and configuration examples
> below describe the former implementation; use the current runtime guide.

# Hosted Effect Architecture V1

## Why Effect

Hosted OpenRecord is an orchestration-heavy product: auth, account-scoped
persistence, an async check queue, a child-process worker boundary, bounded
retries, and append-only evidence. Effect gives us:

- `Effect`/`Layer`/`Context` for explicit service wiring (repositories,
  `RustObservationWorker`, `CheckRunner`) with in-memory test Layers.
- `Schema` as the single source of truth (`packages/domain` →
  `packages/contracts` → API + web), instead of duplicated
  interface/Zod/OpenAPI/decoders.
- `Config` for environment (`DATABASE_URL`, `SESSION_SECRET`,
  `GHOSTPING_WORKER_PATH`, `APP_BASE_URL`).
- `Schedule` for bounded retries (rate-limit/5xx/transient only).
- `Cause`/tagged errors for a deterministic error taxonomy mapped to HTTP
  statuses (`NotAuthenticated`, `FactAuthorityConflict`,
  `ProviderRateLimited`, `WorkerContractMismatch`, …).

> The Rust provider engine remains intentionally retained. No decision to
> rewrite it in TypeScript has been made.

## Application boundaries

- **Effect owns:** authentication, accounts, businesses, approved facts,
  buyer questions, check lifecycle, job orchestration, hosted persistence,
  human review, issues, HTTP API, typed failures, retry policy, telemetry
  (structured logs; OpenTelemetry-ready interfaces, no backend yet).
- **React owns:** presentation, forms, navigation, issue inbox, fact
  management, check controls, human review UX. Server state comes from typed
  API calls; only UI-local state lives in React.
- **Rust owns:** provider requests, provider-specific parsing,
  grounding/citation interpretation, raw evidence, observation
  normalization, provider-specific UNKNOWN handling. The Rust engine is a
  leaf dependency of the hosted worker (`openrecord-worker`).

Rules: Rust never touches Postgres; React never invokes providers; the
Effect API never parses provider-specific payloads.

## Domain package

`packages/domain` (`Schema`): `Account`, `User`, `Business`,
`AuthoritativeFact` (+`FactValueType`, `FactStatus`, `FactSourceKind`),
`BuyerQuestion` (+`QuestionOrigin`), `CheckRun` (+`CheckRunStatus`),
`Observation` (+`ObservationCitation`), `CandidateClaim` (+`ClaimOrigin`),
`HumanJudgment` (+`JudgmentVerdict`), `IssueState`, plus pure helpers
(temporal `[start,end)` UTC normalization, conflict detection, transitions,
issue derivation). UTC is a V1 normalization convention, not the business's
local timezone.

## Effect services / Layers

- `BusinessRepository`, `FactRepository`, `QuestionRepository`,
  `CheckRunRepository`, `ObservationRepository`, `ClaimRepository`,
  `JudgmentRepository` (`packages/db`, `@effect/sql-pg` explicit SQL).
- `RustObservationWorker` (`apps/worker/rust-worker.ts`): spawn directly,
  JSON stdin, stdout=result JSON, stderr separate, timeout, run_id +
  version validation.
- `CheckRunner` (`apps/worker/check-runner.ts`): `claimOne()` →
  `RUNNING` → invoke → persist raw + observation → `SUCCEEDED|FAILED`.
- `apps/api` (`router.ts`/`server.ts`): `HttpRouter` + `NodeHttpServer`,
  pg-backed sessions, account-scoped handlers.

## Postgres ownership

PostgreSQL owns all hosted state (`packages/db/migrations/0001_init.sql`,
`0002_closeout.sql`). Local CLI mode keeps SQLite `evidence.db`; hosted
never shares it. `observations`/`raw_evidence`/`observation_citations` are
append-only (no API update/delete + defensive triggers).
`human_judgments` and `human_judgment_facts` are append-only the same way:
there is no mutable `superseded` flag. A replacement judgment carries
`supersedes_id` pointing at its predecessor; the current head is the row no
newer judgment points at (`NOT EXISTS (child.supersedes_id = j.id)`).
Judgment creation is serialized per claim (`SELECT candidate_claims ...
FOR UPDATE` inside one transaction), so concurrent reviews form one linear
chain, never two heads. Issues are derived (claim + chain-derived latest
judgment + facts + observation); there is no `issues` truth table.

## Job lifecycle

`POST check-runs` → `QUEUED` → worker claims with ONE atomic statement
(`WITH candidate ... FOR UPDATE SKIP LOCKED` + `UPDATE ... WHERE status =
'QUEUED' ... RETURNING`) → `RUNNING` → `openrecord-worker` → raw evidence
stored (exact bytes + digest + mime) → immutable `Observation` →
`SUCCEEDED`, or typed `FAILED` (`failure_class`, `failure_detail_safe`).
Exactly zero or one worker can win a given CheckRun; state transitions are
guarded in SQL (`QUEUED → RUNNING`, `RUNNING → SUCCEEDED | FAILED` only).

Retries are actually executed by `CheckRunner` (`Effect.retry` composing
`RetrySchedule`): initial attempt + at most 3 retries = at most 4 worker
invocations (`MAX_WORKER_ATTEMPTS = 4`). Retryable, by typed failure class
only: `PROVIDER_RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`.
Never retried: `PROVIDER_AUTH`, `PROVIDER_MALFORMED`,
`WORKER_CONTRACT_MISMATCH`, `WORKER_FAILED`, unsupported providers, invalid
contracts. Every real invocation increments `check_runs.attempt_count`, so
the number of provider attempts per CheckRun is always recoverable.

## Rust worker contract

- Input `openrecord-worker-job-v1`: `{contract_version, run_id, provider,
  model, prompt}` — no API keys (env only).
- Output `openrecord-worker-result-v1`: `{contract_version, run_id,
  status, provider, requested_model, observed_model, collected_at,
  answer_text, retrieval_mode, citations, raw_digest, raw_response,
  failure_class, failure_detail_safe}`.
- `provider=mock` deterministic fixtures: cost → `$29` contradiction,
  salesforce → supported, cancellation → unknown, `__fail__` → typed
  failure. UNKNOWN first-class; citations never fabricated.

## Evidence immutability

Raw response preserved byte-exact (`raw_evidence`), digest-pinned by the
observation. Repeated identical provider payloads (the normal monitoring
case) share ONE content-addressed row via immutable get-or-insert
(`INSERT ... ON CONFLICT DO NOTHING`, then `SELECT` by digest — never
`UPDATE`): two observations, one evidence object, zero mutation errors. If
an existing digest maps to different bytes, creation fails closed with a
typed `RawDigestMismatch` error and the original row is untouched.
Interpretation changes create new claims/judgments; history is never
rewritten (proof: no update/delete routes + PG triggers + integration
tests for dedupe, mismatch, and judgment chains).

## Typed error taxonomy

`packages/domain/src/errors.ts` → HTTP mapping: 401 `NotAuthenticated`,
403 `Forbidden`, 404 `*NotFound`, 422 `FactAuthorityConflict | Invalid*`,
429 `ProviderRateLimited`, 502 provider/worker failures. Provider/runtime
failures stay distinguishable in `check_runs.failure_class`.

## Security boundary

Account scoping on every customer query (tested), parameterized SQL
everywhere, HttpOnly `SameSite=Lax` server sessions + Origin check on
writes, scrypt password hashing, no provider secrets in frontend/DB/job
payload (env-only), direct-spawn worker invocation (no shell), strict
`Schema` validation of the worker contract.

## HTTP write boundaries

External JSON is untrusted. Every write endpoint (`signup`, `signin`,
`create business`, `create/supersede fact`, `create question`, `run check`,
`create claim`, `create judgment`) decodes its body through an Effect
Schema request contract (`packages/contracts`: `SignUpRequest`,
`CreateBusinessRequest`, `CreateFactRequest`, `SupersedeFactRequest`,
`CreateQuestionRequest`, `RunCheckRequest`, `CreateClaimRequest`,
`CreateJudgmentRequest`) via `Schema.decodeUnknown` — never an `as` cast.
Malformed payloads (bad enums, wrong types, non-array `factIds`, missing
fields, unparseable timestamps, unexpected nulls) return deterministic
422 before any persistence. Route identifiers are validated as UUIDs before
any repository call, so malformed ids become 4xx, never opaque SQL errors.

## Runtime baseline

Hosted V1 runs on **Node 24 LTS** (`.node-version` = `24`,
`engines: >=24 <25` in every workspace package, Node 24 in CI). Effect
stays at `3.22.2` stable (no v4 migration). If Dockerfiles are added later,
they must use the same Node 24 major.

## Local development

```bash
pnpm install
docker compose up -d postgres   # or: brew services start postgresql
pnpm db:migrate
cargo build --bin openrecord-worker
pnpm dev
```
(requires Node 24; see `.node-version`)

## Future deployment shape

`apps/web` + `apps/api` + `apps/worker` + `openrecord-worker` + Postgres
(+ object storage later behind the raw-evidence repository). No
architecture changes needed; Dockerfiles can be added per process (Node 24
major, matching `.node-version`). No Kubernetes in V1.

## TypeScript↔Rust friction

JSON-over-stdio keeps the boundary narrow but duplicates the v1 contract in
two languages (Effect `Schema` + serde structs) with no codegen; drift is
caught by shared golden fixtures (`tests/worker-contract/`: `job-v1`,
`result-v1` success + failure) decoded on BOTH sides — Rust integration
test `tests/worker_contract_fixtures.rs` and the TypeScript fixture suite in
`packages/contracts` — plus negative cases (unknown version, wrong type,
missing field) rejected by both. Error-cause fidelity also narrows at the
boundary (typed Rust failure → safe string detail). Kept intentionally; not
solved by rewriting providers in TypeScript.
