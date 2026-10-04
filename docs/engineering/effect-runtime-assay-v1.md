# Effect runtime V1 reachability assay

Assayed on 2026-10-04 before migration code. The initial Phase 23 stop was
resolved by the user: **keep CLI and Tauri; revise scope to hosted runtime
only**. Rust classifications below describe the pre-cutover state.

## Approved scope revision

Hosted execution must have one Effect provider path and no Rust subprocess,
IPC schema, worker path, or Rust build requirement. The local CLI and Tauri
app remain supported Rust products. Their root Cargo manifests, library
modules, CLI/research/protocol tests, installers, formula, and release workflow
remain intentionally present. This replaces the original all-Rust-deletion
criterion and does not permit a hidden hosted Rust fallback.

Post-cutover: `ghostping-worker`, `worker_contract`, and `nine_router` Rust
modules and IPC fixtures are removed. All other listed Rust paths remain
outside the hosted dependency graph. See [runtime architecture](effect-runtime-v1.md)
for the final graph and validation evidence.

## Baseline

- Repository: `urbiens/ghostping`.
- Fetched `origin` with pruning before inspection.
- Actual `origin/main`: `d59410d37d2fd588d9d20c450d5a91da4912b242`.
- Starting checkout: `e0228b9f61f2c3776dda15207a42ec184eb9d7b9` on
  `feat/effect-edges`, one commit above main. This contains the prior Effect
  Config, SQL authentication, and row-decoding changes.
- Created `feat/effect-runtime-v1` from that checkout, preserving its history.
- Tracked working tree and index were clean. Untracked operator work
  `scripts/demo-seed.ts` was preserved without reading or changing it.
- No runtime, database, CI, release, or product code changed during this assay.

## Phase 23 stop condition

The supplied migration brief requires stopping if Rust is demonstrably needed
by a non-hosted product that is still intentionally supported. The repository
currently has that condition:

1. `README.md:11` says the local CLI features remain available;
   `README.md:265` explicitly labels the legacy workflow "Done, maintained".
2. `.github/workflows/release.yml:28-85` builds and distributes the Rust
   `ghostping` CLI for Linux, macOS, and Windows on version tags. It is an
   executable release path, not an archived document.
3. `tauri-app/src-tauri/Cargo.toml:16` depends on the root Rust crate through
   `ghostping = { path = "../.." }`. Its `src/commands.rs` imports the root
   agent, cache, configuration, GEO generation, storage, tracker, and provider
   capabilities. `src/lib.rs` registers these commands with Tauri.
4. `README.md:100` supplies a desktop development command;
   `CONTRIBUTING.md` still lists CLI, Rust provider, and Tauri contributions.
5. `Formula/ghostping.rb` and `scripts/install.sh` / `scripts/install.ps1`
   distribute the CLI. `website/app/page.tsx` also presents the CLI workflow,
   although its distribution URLs contain placeholders.

This proves repository-level non-hosted dependencies and documented support;
it does not prove current customer usage, successful recent releases, or that
the desktop skeleton builds. Those were not claimed or tested.

Deleting `src/`, root Cargo manifests, and the Rust release infrastructure now
would retire these products, not merely consolidate hosted execution. The initial
assay therefore stopped before provider migration or deletion. The now-resolved
product-scope decision was: explicitly retire the local CLI and Tauri product, or
revise the all-Rust-removal acceptance criteria. Keeping them without that
decision would violate the supplied exception and final acceptance criteria.

## Active hosted dependency graph

```text
React apps/web → Effect apps/api → Effect SQL repositories → PostgreSQL
                                      ↓ check_runs queue
apps/worker runner.ts → CheckRunner → RustObservationWorker
                                    → node:child_process spawn
                                    → ghostping-worker stdin/stdout
                                    → worker_contract::execute_job
                                      ├─ deterministic hosted mock
                                      └─ nine_router::execute_9router
                                         → reqwest + Tokio → gateway

apps/worker runner.ts → independent DiscoveryRunner fiber
                     → safe HTTP / discovery / representation capabilities
                     → Effect SQL repositories → PostgreSQL
```

The hosted Rust entrypoint is `src/bin/ghostping-worker.rs`. It imports only
`worker_contract::{execute_job, WorkerJob, JOB_CONTRACT_VERSION}`. That module
routes to hosted mock behavior or `nine_router.rs`; neither accesses a
database. Other Rust modules are exported by `src/lib.rs` and compiled with
the crate, but are not thereby reachable from hosted execution.

The live wiring is in `apps/worker/src/runner.ts`, `check-runner.ts`, and
`rust-worker.ts`. `packages/providers/src/index.ts` is currently an allowlist,
not an execution capability. `packages/contracts/src/index.ts` owns the two
IPC schemas; `packages/config/src/index.ts` still exposes the worker path.
Hosted CI builds the binary and sets its path. No hosted API or React path
directly invokes the Rust library. Discovery is a separate HTTP security
context and has no Rust execution dependency.

## Rust subsystem classification

The requested classifications below concern **hosted reachability**.
`DEAD_LEGACY` does not mean safe to delete while the documented CLI/desktop
support remains. The last column explicitly records non-hosted retention
reasons. Directory rows cover all descendant modules and embedded templates.
No hosted subsystem remains `UNKNOWN` after this source inspection.

| Subsystem | Hosted classification | Existing non-hosted use / migration note |
| --- | --- | --- |
| `src/bin/ghostping-worker.rs` | ACTIVE_HOSTED_DEPENDENCY | IPC entrypoint; remove only after cutover gates |
| `src/worker_contract.rs` | BEHAVIOR_TO_PORT | Hosted mock, dispatch, normalization, IPC; port behavior, delete IPC |
| `src/nine_router.rs` | BEHAVIOR_TO_PORT | Hosted gateway request, model pin, parsing, failures, raw bytes |
| `src/lib.rs` | ACTIVE_HOSTED_DEPENDENCY | Worker library root, also the CLI and Tauri library root |
| `src/bin/ghostping.rs` | DEAD_LEGACY | Maintained CLI entrypoint and release binary |
| `src/bin/jev-assay.rs`, `src/jev_assay.rs` | DEAD_LEGACY | Separate research executable, no hosted product path |
| `src/agent/` | DEAD_LEGACY | CLI optimize; Tauri optimize |
| `src/audit_engine.rs` | DEAD_LEGACY | CLI evidence audit |
| `src/audit_storage.rs` | DEAD_LEGACY | CLI SQLite evidence persistence |
| `src/cache.rs` | DEAD_LEGACY | CLI and Tauri cache |
| `src/config.rs` | DEAD_LEGACY | CLI and Tauri configuration |
| `src/content_generator.rs` | DEAD_LEGACY | CLI draft generation |
| `src/evidence_protocol.rs` | TEST/FIXTURE_VALUE_ONLY | Rust portable protocol validation; TypeScript protocol remains canonical for hosted product |
| `src/geo/` | DEAD_LEGACY | CLI and Tauri generation / evaluation / prompts |
| `src/gsc.rs` | DEAD_LEGACY | CLI Search Console import / observation views |
| `src/integrity.rs` | DEAD_LEGACY | CLI authority, claims, judgments in SQLite |
| `src/marketplace/` | DEAD_LEGACY | CLI prompt templates |
| `src/observation_views.rs` | DEAD_LEGACY | CLI reporting |
| `src/observations.rs` | DEAD_LEGACY | CLI observations / imports; not hosted Postgres observations |
| `src/parser.rs` | DEAD_LEGACY | CLI audit parsing |
| `src/plugins/` | DEAD_LEGACY | CLI installed prompt packs |
| `src/project_config.rs` | DEAD_LEGACY | CLI project configuration |
| `src/prompt_discovery.rs` | DEAD_LEGACY | CLI prompt discovery, distinct from hosted Representation Discovery |
| `src/providers/` | DEAD_LEGACY | CLI / Tauri providers, not the hosted mock or NineRouter dispatch |
| `src/report.rs`, `src/report_generator.rs` | DEAD_LEGACY | CLI reporting |
| `src/scheduler.rs` | DEAD_LEGACY | CLI launchd / cron scheduling |
| `src/storage.rs` | DEAD_LEGACY | CLI / Tauri SQLite storage |
| `src/tracker.rs` | DEAD_LEGACY | CLI / Tauri audit |
| `src/tui/` | DEAD_LEGACY | CLI chat interface |
| `src/types.rs` | DEAD_LEGACY | CLI model / storage / parsing types |
| `tauri-app/src-tauri/` | DEAD_LEGACY | Separate desktop crate with actual root-library dependency |
| `tests/worker_contract_fixtures.rs`, `tests/worker-contract/` | TEST/FIXTURE_VALUE_ONLY | Temporary parity inputs; delete IPC-specific artifacts after parity |
| Other root Rust tests | TEST/FIXTURE_VALUE_ONLY | CLI/research/protocol validation; shared portable JSON fixtures need independent review |

## Hosted behavior requiring migration

- Mock: marker and natural-language selection precedence, exact answer text
  for wrong/supported/unknown fixtures, simulated unavailable failure,
  requested model echo, observed `mock-v1`, unknown retrieval, empty citations,
  explicit synthetic classification. Mock evidence bytes are synthetic JSON.
- NineRouter: one model pin; `POST {base}/chat/completions` with
  `{model, messages:[{role:"user",content:prompt}], stream:false}`; bearer
  credentials supplied out of band; response `choices[0].message.content`;
  positively reported observed model; unknown retrieval; top-level citations
  and allowlisted response metadata; exact successful response byte digest.
- Existing citation normalization accepts strings or objects, preserves
  returned URI/title, uses explicit integer position or response order, and
  defaults attribution to false. It creates no citation-to-claim relation.
- CheckRunner: atomic claim, scoped question lookup, actual invocation attempt
  count, initial attempt plus at most three retries, typed retry classes,
  raw evidence / immutable observation persistence, lifecycle completion,
  measurement provenance, and account/business boundaries.
- Worker: independently progressing check and discovery fibers, per-loop
  failure containment, shutdown interruption, scoped Postgres resources.

Important intentional corrections required by the brief: the old gateway key
is optional, response allocation is unbounded, content type is hardcoded,
HTTP failure bodies are reconstructed, and the URL loopback test is a prefix
test. The Effect implementation must use validated Config/Redacted, a precise
endpoint policy, bounded exact bytes, actual content type, curated safe errors,
Schema parsing, and typed startup failure for missing required credentials.
These improvements need tests rather than blind byte-for-byte porting.

## Validation and remaining work

Performed: Git baseline/fetch inspection, tracked/index diff inspection,
worker dispatch and imports, API/server wiring, package manifests, Rust
entrypoints/library imports, desktop commands/manifests, CI/release workflows,
installer/formula/landing references, and current architecture documentation.

At the initial stop, only this assay document was added. Runtime tests, parity, provider tests,
PostgreSQL 16 integration, builds, and migration CI were **not run** because
execution stopped at the explicit product-support exception. The shell's
current Node is 20.19.5; the hosted manifests require Node 24, which must be
selected before eventual validation. No credentials, provider requests, or
database mutations were needed for the assay.

At the initial stop, no migration PR was opened, no commit was created, and no Rust was deleted.
After the support-scope decision, proceed with provider capability and typed
errors, Config/Redacted, injectable Effect HttpClient, bounded raw evidence,
Schema parsing, fixture parity, CheckRunner cutover, PG16/concurrency gates,
then deletion and CI/documentation cleanup. Preserve shared portable protocol
fixtures and current product behavior; do not port CLI or research features.

Historical initial stop: GHOSTPING_EFFECT_RUNTIME_V1 = NOT_READY
