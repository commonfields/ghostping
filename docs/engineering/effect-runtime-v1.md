# Hosted Effect runtime V1

## Scope

Ghostping's hosted product now executes providers through Effect. React remains
React. The user explicitly revised the original repository-wide Rust removal:
**keep CLI and Tauri; migrate hosted runtime only**. Cargo, local SQLite, CLI
providers, research tools, installers, Tauri, and the CLI release workflow
remain supported outside hosted execution. No new providers, scores, judgment
automation, publication, Truth Delivery, candidate promotion, public API, MCP,
or visual redesign are included.

Rust originally supplied a stateless provider leaf to the hosted worker through
stdin/stdout. The migration removes that leaf and its duplicated contract so
configuration, HTTP resources, parsing, errors, retries, and worker lifetime
share one execution model. Git history preserves the former worker.

## Capability and Layer graph

```text
Effect Config → NineRouterSettings (Redacted key and endpoint)
NodeHttpClient.layer (scoped agents) → NineRouterProviderLive
MockProviderLive + NineRouterProviderLive → ProviderRegistryLive
PgClient.layer → SQL repository Layers
ProviderRegistryLive + repositories → CheckRunnerLive
Discovery / representation capabilities + repositories → DiscoveryRunnerLive
Effect parent scope → CheckRunner fiber + DiscoveryRunner fiber
```

`ProviderAdapter.observe(ProviderRequest)` returns
`Effect<ProviderObservation, ProviderError>`. ProviderRequest is an Effect
Schema. A single registry map routes the provider name and rejects unsupported
providers; adding future Layers does not require changing CheckRunner. Only
`mock` and `9router` are registered. Provider errors carry bounded evidence in
`Redacted`, never transport errors, credentials, requests, or raw error text.

Each loop owns its queue claim, provider work, and persistence. A blocked scan
cannot starve checks. Typed loop failures are contained and logged by tag.
Parent interruption stops both fibers and interrupts active HTTP execution.
No detached Promise loop or global provider singleton exists.

## Configuration and startup

Use Node 24, pnpm 10.12.1, and PostgreSQL 16. Copy `.env.example` into your
local environment without committing credentials. The processes read the
Effect ConfigProvider; they do not automatically load `.env` files.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --filter @ghostping/api dev
pnpm --filter @ghostping/worker dev
pnpm --filter @ghostping/web dev
```

Apply migrations before deploying the new worker. Migration 0011 adds immutable
provider-attempt evidence and nullable actual content type plus the configured
byte bound to successful raw evidence. Prior raw/observation rows are unchanged.
The old worker must be stopped during cutover; there is no mixed-runtime flag.

After building, API and worker `pnpm start` commands use Node with the `tsx`
loader because workspace packages export TypeScript source with `.js` import
specifiers. The loader is a production dependency; deployment must ship the
workspace packages as well as app `dist` directories. A plain Node invocation
without that resolver is not the supported start command.

| Config key | Behavior |
| --- | --- |
| `DATABASE_URL` | Required at API/worker boot, represented as Redacted |
| `APP_BASE_URL`, `PORT` | API origin and port, existing defaults |
| `WORKER_POLL_MS` | Worker poll interval, default 1000 |
| `NINE_ROUTER_ENABLED` | Default false; mock-only startup needs no provider secrets |
| `NINE_ROUTER_BASE_URL` | Default local gateway `/v1`; HTTPS or exact loopback HTTP only; no userinfo, query, fragment |
| `NINE_ROUTER_API_KEY` | Required nonempty Redacted secret when enabled; bearer header only |
| `NINE_ROUTER_MODEL` | Required nonempty pin when enabled |
| `NINE_ROUTER_TIMEOUT_MS` | Default 60000, validated 1..300000 |
| `PROVIDER_RESPONSE_MAX_BYTES` | Default 2097152, validated 1..16777216 |

Enabling NineRouter without valid required configuration fails Layer construction
before a provider request. A disabled NineRouter request fails terminally as
unsupported. Provider implementations never read `process.env` or call global
fetch. The endpoint is redacted as well as the key. HTTPS validation protects
credentials in transit; the configured gateway is a trusted operator endpoint,
separate from crawler URL/DNS/SSRF security rules.

## Gateway request and response

The gateway receives `POST {base}/chat/completions` with the pinned model, one
user message, and `stream:false`. An explicitly different requested model is
rejected before HTTP. Requested model records the actual pin sent; observed
model comes only from the response `model` field and stays null when absent.
No inference of retrieval mode is made: the adapter returns `unknown`.

Response bytes are collected through the Effect response stream with a bound
checked before retaining each chunk. The scope releases HTTP resources on
failure/interruption. Redirects are not followed. Timeout covers headers and
body acquisition and uses Effect interruption, with actual socket closure
covered by a local HTTP test. Oversized responses fail terminally, with no
truncated JSON or partial body presented as complete evidence.

```text
HTTP response stream → bounded exact bytes → SHA-256 + actual Content-Type
                                          → strict UTF-8 / JSON boundary
                                          → Schema.decodeUnknown
                                          → normalized observation
```

Malformed JSON/UTF-8 is ProviderMalformed. Valid JSON with missing/wrong required
fields is ProviderContractMismatch. `choices[0].message.content` must be a string
and at least one choice is required. Optional model, citations, and metadata
remain optional. Decoded metadata is allowlisted to returned `id`, `object`,
`created`, `model`, `usage`, and `system_fingerprint`. Native extra fields remain
in raw evidence rather than being erased. String/object citations preserve
URI/title, explicit integer position or returned order, and returned attribution
or false. They never establish a citation-to-claim causal relationship.

## Typed failure and retry policy

| Condition / tag | Stored class | Retry |
| --- | --- | --- |
| HTTP 401/403 / ProviderAuth | PROVIDER_AUTH | No |
| HTTP 429 / ProviderRateLimited | PROVIDER_RATE_LIMITED | Yes |
| Effect timeout / ProviderTimeout | PROVIDER_TIMEOUT | Yes |
| Network/read failure or HTTP 5xx / ProviderUnavailable | PROVIDER_UNAVAILABLE | Yes |
| Invalid/oversized bytes / ProviderMalformed | PROVIDER_MALFORMED | No |
| Invalid required JSON contract / ProviderContractMismatch | PROVIDER_CONTRACT_MISMATCH | No |
| Disabled/unknown provider, pin mismatch, other non-2xx / ProviderUnsupported | PROVIDER_UNSUPPORTED | No |

CheckRunner owns `Schedule.exponential("500 millis", 2)` intersected with
`Schedule.recurs(3)`, filtered by tagged errors. A hard ceiling preserves the
initial attempt plus at most three retries even with a broader supplied schedule.
The counter increments just before each provider invocation, not each queue
claim. No retry classification uses body text or error-message matching.
SQL failures propagate to the loop; they cannot trigger more provider attempts
or a false success. Safe persisted failure details are fixed curated messages.

## Evidence and persistence

`raw_digest = SHA256(exact response bytes)`. JSON parsing/re-serialization never
determines the provider digest. Actual response content type is recorded; an
absent header remains null. Mock evidence uses deterministic synthetic JSON,
`mock-v1`, explicit synthetic=true, and no invented citations. Real gateway
observations explicitly carry synthetic=false.

Successful raw evidence, observation, citations, and RUNNING→SUCCEEDED completion
share a bounded SQL transaction. Network calls occur beforehand. Digest mismatch
or a failed citation insertion rolls the transaction back. Raw evidence and
observations retain existing append-only guards and content-addressed dedupe.

Each complete bounded HTTP failure body is stored in `provider_attempt_evidence`
before retry, with run/business, actual attempt, HTTP status, safe class, exact
bytes/digest, content type, and configured bound. Composite ownership and
RUNNING checks prevent cross-business writes. UPDATE/DELETE are rejected. There
is no API exposing this operator evidence, and no failed response creates a
successful observation. Timeout, network failure, and oversize can have no
complete body; no raw body is fabricated in those cases.

Atomic claim gives one owner of a queued run at a time. Upstream execution is
**not exactly once** across a crash boundary: the counter is written before the
request, and a crash can leave RUNNING work stranded. This milestone does not
add leases/recovery or replay completed actions. The preexisting counter can
therefore overcount an invocation in the narrow crash gap before transmission.

## Parity and regression strategy

Before deleting the worker, a temporary suite compared Rust and Effect for eight
mock prompts (wrong, supported, unknown, cost, Salesforce, cancel, generic,
failure) and seven local gateway responses (success, auth, rate limit, 5xx,
malformed JSON, missing content, timeout). Both suites passed. Successful gateway
bytes/digests, model identity, citations, and metadata matched. Intentional
changes: wrong required schema gets its own terminal tag; complete failure
responses retain actual bytes; missing key is a startup error when enabled.
Original Rust adapter tests also passed (13 gateway + 9 worker tests).
The temporary harness and Rust hosted implementation were then deleted.

Permanent tests cover Schema contracts, config validation/redaction, mock
semantics, typed failures, four-attempt retry ceiling, exact digests, bounded
chunked HTTP, redirect refusal, timeout cancellation, registry routing,
Postgres transactional success/rollback, failure evidence, ownership,
immutability, independent worker progress, and shutdown. Existing protocol,
representation, truth, discovery, Product Surface, API/web, tenancy, no-score,
no-causality, and no-publication regressions remain required.

Architecture guards scan active hosted source paths for subprocess execution,
Rust worker references, IPC schemas, direct provider environment reads/global
fetch, and misplaced retry ownership. Hosted CI has its own Node/PG16 job with
no Rust steps; a separate Rust job still validates the supported CLI.
The built-process smoke gate boots API/worker with Node and the production
loader, checks cookie signup/signin, submits and reads a persisted synthetic
observation, and verifies cross-account denial. It requires explicit
`HOSTED_SMOKE_ALLOWED=1` and a disposable loopback database; test fixtures are
removed by discarding that database. Child processes stop in a `finally` block.

Live validation is optional and never part of normal tests/CI:
`GHOSTPING_LIVE_PROVIDER=1 pnpm provider:live:9router` performs one bounded
request with enabled/configured NineRouter and prints only safe contract metadata.
No public-provider live call is claimed by local fixture validation.

## Local verification evidence

Validated under Node 24.3.0 / pnpm 10.12.1 with an owned PostgreSQL 16.15
container, isolated from the operator's existing PostgreSQL 14 database.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | All 12 workspace packages passed |
| `pnpm test` with both database test environment keys | 407 tests passed, none skipped |
| Provider/config/transport/architecture tests | 30 provider + 5 config tests passed |
| Worker tests, including cutover persistence and shutdown | 33 passed |
| Database regression tests, including migration re-runs and JSON-order dedupe | 53 passed |
| Temporary parity tests, before removal | 15 semantic fixtures passed |
| Built API/worker smoke command | Passed auth, persistence, reads, tenant denial |
| Supported CLI `cargo fmt`, `cargo clippy`, `cargo test --all-targets --locked` | Passed; 163 Rust tests |
| Supported CLI build / exit-contract checks | Passed; 73 CLI checks |
| Release-script / installer regression checks | 4 / 7 passed |

Live upstream NineRouter credentials were not used. Tauri was retained with its
root-library dependency verified; the desktop application was not rebuilt.
Existing Vite bundle-size and workspace db/truth cycle warnings remain. Worker
crash recovery/leases and external telemetry infrastructure remain separate
future work. No production or operator database was migrated or mutated.
