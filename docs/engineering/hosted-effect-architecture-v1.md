# Hosted Effect Architecture V1

## Why Effect

Hosted Ghostping is an orchestration-heavy product: auth, account-scoped
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
  leaf dependency of the hosted worker (`ghostping-worker`).

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

PostgreSQL owns all hosted state (`packages/db/migrations/0001_init.sql`).
Local CLI mode keeps SQLite `evidence.db`; hosted never shares it.
`observations`/`raw_evidence` are append-only (no API update/delete +
defensive triggers). Judgments append-only (supersede flag, history kept).
Issues are derived (claim + latest unsuperseded judgment + facts +
observation); there is no `issues` truth table.

## Job lifecycle

`POST check-runs` → `QUEUED` → worker `SELECT … FOR UPDATE SKIP LOCKED`
→ `RUNNING` → `ghostping-worker` → raw evidence stored (exact bytes +
digest + mime) → immutable `Observation` → `SUCCEEDED`, or typed `FAILED`
(`failure_class`, `failure_detail_safe`). Failed attempts are permanent;
retries are bounded `Schedule` for 429/5xx/transient only — never for
auth/malformed/contract mismatch, never forever.

## Rust worker contract

- Input `ghostping-worker-job-v1`: `{contract_version, run_id, provider,
  model, prompt}` — no API keys (env only).
- Output `ghostping-worker-result-v1`: `{contract_version, run_id,
  status, provider, requested_model, observed_model, collected_at,
  answer_text, retrieval_mode, citations, raw_digest, raw_response,
  failure_class, failure_detail_safe}`.
- `provider=mock` deterministic fixtures: cost → `$29` contradiction,
  salesforce → supported, cancellation → unknown, `__fail__` → typed
  failure. UNKNOWN first-class; citations never fabricated.

## Evidence immutability

Raw response preserved byte-exact (`raw_evidence`), digest-pinned by the
observation. Interpretation changes create new claims/judgments; history is
never rewritten (proof: no update/delete routes + PG triggers +
integration test asserting triggers + judgment supersede test).

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

## Local development

```bash
pnpm install
docker compose up -d postgres   # or: brew services start postgresql
pnpm db:migrate
cargo build --bin ghostping-worker
pnpm dev
```

Seed the Northstar demo via `pnpm db:seed` (fictional business, 3 facts,
3 questions; mock answers yield contradiction/supported/unknown).

## Future deployment shape

`apps/web` + `apps/api` + `apps/worker` + `ghostping-worker` + Postgres
(+ object storage later behind the raw-evidence repository). No
architecture changes needed; Dockerfiles can be added per process. No
Kubernetes in V1.

## TypeScript↔Rust friction

JSON-over-stdio keeps the boundary narrow but duplicates the v1 contract in
two languages (Effect `Schema` + serde structs) with no codegen; drift must
be caught by contract tests on both sides. Error-cause fidelity also
narrows at the boundary (typed Rust failure → safe string detail). Kept
intentionally; not solved by rewriting providers in TypeScript.
