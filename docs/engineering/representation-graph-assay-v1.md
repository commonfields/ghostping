# Representation Graph Assay V1

Scope: read-only inspection before coding Representation Graph V1.
Date: 2026-10-03. Branch base: `origin/main` @ `1907c5d`.

## 1. Evidence Protocol V1 (reusable, do not duplicate)

- Canonical TS source: `packages/protocol/src/schema.ts` (FactV1, SurfaceIdentityV1 with `account_state`/`subscription_tier`, MeasurementContextV1, ObservationV1, ClaimV1, JudgmentV1, IssueV1, InterventionV1, ReobservationV1, EvidencePacketV1, MeasurementSignatureV1).
- Derivation: `packages/protocol/src/measurement.ts` (`measurementSignature`, `compareMeasurements`, `latestJudgment`, `soleClaim`, `factsAt`), `packages/protocol/src/packet.ts` (`assembleEvidencePacket`, `validatePacket`, `checkReferences`), `packages/protocol/src/canonical.ts`, `packages/protocol/src/surface.ts` (9router/mock only), `packages/protocol/src/render.ts`.
- Fixtures: `fixtures/evidence-protocol-v1/*.json`, generator `packages/protocol/scripts/fixtures.ts`, schemas `schemas/ghostping/*.schema.json`.
- Rust mirror: `src/evidence_protocol.rs` (canonical JSON, comparison, assembly, fail-closed validation), tests `tests/evidence_protocol_fixtures.rs`.
- Phase-0 gaps fixed on this branch: `account_state`/`subscription_tier` added to `MeasurementSignatureV1` (TS+Rust, CRITICAL), linear judgment/intervention chain validation (`InvalidJudgmentSupersession` / `InvalidInterventionSupersession`) with resealed malicious fixtures.

## 2. AuthoritativeFact persistence (reuse)

- Hosted PG: `packages/db/migrations/0001_init.sql:43-59` (`authoritative_facts`), `packages/db/src/repositories.ts` (`FactRepository.supersede`, `activeOverlapping`), domain `packages/domain/src/index.ts:56-95` (`AuthoritativeFact`, `validateFactValue`, `detectAuthorityConflicts`).
- Local SQLite: `src/integrity.rs:238-255` (`authoritative_facts` in `evidence.db`).
- Rule preserved: fact value = authority; bindings never duplicate expected value.

## 3. raw_evidence / observations / citations / claims / judgments / interventions

- PG DDL: `0001_init.sql:88-94` (`raw_evidence` digest UNIQUE, append-only trigger), `:96-109` (`observations`), `:126-134` (`observation_citations` raw `uri TEXT`, no canonicalization), `:136-145` (`candidate_claims`), `:147-157` (`human_judgments` + `human_judgment_facts`), `0002_closeout.sql` (drop mutable `superseded` flag, append-only triggers), `0003_evidence_protocol_v1.sql` (interventions with `UNIQUE(supersedes_id)` linear correction, `intervention_issues`, `reobservations` lineage, tenancy triggers).
- TS persistence: `packages/db/src/repositories.ts` (facts/claims/judgments), `packages/db/src/evidence.ts` (`InterventionRepositoryLive.append`, `ReobservationRepository`, `EvidenceLineageRepositoryLive.loadIssue`, `exportIssuePacket` fail-closed).
- Local: `src/observations.rs:280-341` (`observations`, `raw_evidence(digest PK, bytes BLOB)`), `src/audit_storage.rs`, `src/storage.rs`.
- Judgment head derivation duplicated: protocol `measurement.ts:121-126` (`byTimeThenId`) vs domain `index.ts:407-417` (`createdAt desc`) vs SQL `NOT EXISTS(child.supersedes_id=j.id)`. Portable packet validation is authoritative for linearity; DB `SELECT ... FOR UPDATE` serializes creation.

## 4. Re-observation / hosted worker

- `apps/worker/src/runner.ts` (poll loop), `apps/worker/src/check-runner.ts` (QUEUED → Rust worker → observations.create, retry `MAX_WORKER_ATTEMPTS=4`), `apps/worker/src/rust-worker.ts` (spawn without shell, stdin/stdout JSON, timeout → `ProviderTimeout`).
- Rust worker `src/bin/ghostping-worker.rs` stateless; `src/worker_contract/*`.
- Representation collection must reuse this pattern (bounded Effect services, no recursive crawl) but with a separate `WebCollector` seam.

## 5. URL / crawl / diagnose utilities (Rust)

- Only `src/bin/ghostping.rs:426-434,4918-4990` `diagnose <url>`: `reqwest::Client::new()` GET homepage + `robots.txt`/`sitemap.xml`/`llms.txt`, prints only. No HTML parsing, no crawl frontier, no sitemap recursion. Docs explicitly "never scrapes" (`docs/protocol/intervention-v1.md`, `docs/engineering/observation-kernel.md`).
- No crawler farm to reuse. New collector must be greenfield with hard limits.

## 6. HTTP clients (reuse pattern, new seam)

- Rust: `Cargo.toml:54` `reqwest 0.12 + rustls-tls`, used in `src/nine_router.rs`, `src/providers/*`, `src/jev_assay.rs`.
- TS: native `fetch` only (`apps/web/app/lib/api.ts:17`), `pg 8.13.1` + `@effect/sql(-pg)`. No axios/ky/got.
- Representation TS collector uses native `fetch` with `redirect: manual` + `dns.promises.lookup` pre-validation (documented TOCTOU limit), never blind-follows redirects.

## 7. HTML parsing dependencies (none — add minimal)

- `Cargo.toml` has no scraper/selectors/html5ever/tl/lol-html. `packages/*` + `apps/web` have no cheerio/jsdom/parse5/hast/rehype (only transitive jsdom via vitest in `pnpm-lock.yaml`).
- Decision: add `cheerio` (htmlparser2, deterministic, no browser) to new `@ghostping/representation` only. No Playwright, no Firecrawl, no jsdom at runtime.

## 8. Local-first storage

- `rusqlite 0.32 bundled` (`Cargo.toml:62`), `dirs 5`, `~/.ghostping/evidence.db` (`src/config.rs`, `src/bin/ghostping.rs`), `tauri-app` reuses local crate.
- Hosted PG is sole hosted store; local CLI never touches PG (`src/evidence_protocol.rs:11`).
- Representation PG tables follow hosted pattern (append-only observations/values, editable targets/bindings); tests use deterministic local HTTP fixtures, no internet.

## 9. Current URL identity semantics

- Citations store raw provider `uri TEXT` (`observation_citations`, `CitationV1.uri`). No canonicalization, no equivalence rules, no fragment/query policy.
- New `canonicalUrl` rules (scheme/host lowercase, default-port strip, fragment drop, trailing-slash policy, query preserved) live in representation package only; AI citation association is conservative and never infers causality.

## 10. Current evidence-storage semantics

- `raw_evidence`: exact bytes + SHA-256, digest-deduped, append-only (PG trigger + SQLite PK).
- `observations`: immutable (no UPDATE/DELETE API + trigger).
- Derived state (match, change, outcome, issue state, findings) never stored as mutable truth; recomputed at export/query time.
- Representation follows same law: `SourceObservation`/`ObservedSourceValue` append-only, `RepresentationFinding` derived.

## 11. Security constraints

- No SSRF protection exists yet. New `NativeHttpCollector` must reject localhost/loopback/RFC1918/link-local/multicast/metadata IPs, non-http(s), resolve+validate DNS pre-connect and every redirect, typed `SECURITY_REJECTED`.
- Tests inject a transport/test resolver; production policy never weakened for tests.

## 12. Cheapest architecture (chosen)

- New `packages/representation`: pure domain + `NativeHttpCollector` (fetch) + deterministic extractors (JSON-LD path, CSS text, META) + comparators (EXACT_TEXT/BOOLEAN/MONEY) + graph query over relational rows + Effect services + cost counters. No Neo4j (graph = query model), no browser, no Firecrawl, no MCP/public API, no LLM.
- PG migration `0004_representation_graph_v1.sql`: `source_targets`, `source_bindings`, `source_observations`, `observed_source_values`, indexes, tenancy, append-only triggers. Findings derived.
- Evidence Protocol V1 stays frozen; source objects are separate (see `docs/representation-graph/*` and protocol-integration note).

## 13. Requested-but-already-existing (do not rebuild)

- AuthoritativeFact model/persistence, raw_evidence digest store, observation immutability, judgment append-only chain pattern, intervention correction pattern, re-observation lineage, worker poll/retry/timeout pattern, canonical JSON/SHA-256 helpers, Effect service patterns.
- New work is: source targets/bindings/observations/values, native collector + SSRF, deterministic extraction, small comparators, graph query + citation edges, bounded policy, cost counters.
