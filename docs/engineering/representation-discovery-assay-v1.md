# Representation Discovery Assay V1

Starting main SHA: `65e939e4a3cfe9bc78d314d92fa7d6804373afbe` (HEAD == origin/main, clean).
Date: 2026-10-03. Scope: Phase 0 read-only assay, no behavior change.

Files inspected: `packages/representation/src/{collector,policy,service,extraction,evaluate,effective,url,types,comparators,graph,index}.ts`, `packages/representation/test/representation.test.ts`, `packages/truth/src/{authority,values,manifest,service,bridge}.ts`, `packages/db/src/{truth,product,repositories,representation,evidence}.ts`, `packages/db/migrations/0001-0008.sql`, `apps/worker/src/{runner,check-runner}.ts`, `apps/api/src/{router,reads}.ts`, `apps/web/app/routes/representation*.tsx`, `apps/web/app/lib/api.ts`, `apps/web/app/lib/nav.ts`, components + test stack.

## 1. Which HTTP/SSRF machinery can be reused

`NativeHttpCollector` in `packages/representation/src/collector.ts:315-572` is the sole production fetcher. Reusable as-is or via extraction:

- Transport seam: `HttpTransport` (`collector.ts:87-90`) with `fetch(url,{headers,signal,connectIp,servername})` + `lookup(host)`. Production `pinnedFetch` (`collector.ts:97-148`) pins DNS (`lookup` override to `connectIp`), sets SNI `servername`, lowercases headers, enforces timeout via `req.setTimeout` + AbortSignal.
- Defenses: DNS preflight + `isForbiddenIp` reject (`collector.ts:370-379`, `177-203`); IP pinning `connectIp=addrs[0]` (`collector.ts:380-381`); connect-time peer check `peerIp` must be in validated set (`collector.ts:400-410`); redirect re-validation per hop (`collector.ts:457-479`, max 5); `readCapped` byte ceiling (`collector.ts:221-280`, default 1MB `collector.ts:33-39`); content-type allowlist `text/html, application/xhtml+xml` (`collector.ts:480-505`); timeout 8s (`collector.ts:33-39`); validator scoping same-origin only (`collector.ts:350-369`).
- Forbidden list covers: `127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 224/4, 100.100.100.200, ::1, ::, ::ffff:127, fe80-feb, fc/fd, ff` (`collector.ts:177-203`). Tests in `packages/representation/test/representation.test.ts:335-426` prove localhost, RFC1918, link-local, metadata IP, rebind (peer mismatch), cross-hop privatization all yield `SECURITY_REJECTED`.
- Cost counters `requests/notModified/bytesDownloaded/changed/extractionsReran` (`collector.ts:41-55`) already wired for observability.

Conclusion: discovery must reuse this transport + IP logic, not reimplement.

## 2. Whether security behavior is cleanly extractable

Yes, with a small refactor. Pure/generic today: `isForbiddenIp`, `originOf`, `readCapped`, `HttpTransport/FetchInit/FetchResponse`, `CollectorLimits/DEFAULT_LIMITS`, `pinnedFetch`, `defaultTransport`. Coupled to representation domain inside `collect()` (`collector.ts:331-537`): returns `CollectorOutcome` bound to `SourceObservationV1` omission (`collector.ts:299-303`), builds `NATIVE_HTTP/FETCHED/NOT_MODIFIED/FAILED` rows, threads `PreviousValidators{etag,last_modified,body_digest,origin}` (`collector.ts:57-63`), mixes policy knobs (timeout→TIMEOUT, ceiling→RESPONSE_TOO_LARGE, accept-list→UNSUPPORTED_CONTENT_TYPE) with security.

Smallest primitive per spec Phase 1: `SafeHttpFetcher(url,{byteCeiling,acceptedContentTypes,validators,redirectPolicy,userAgent,timeout})` returning `{status,headers,body,peerIp,finalUrl,redirectChain,truncated}` with zero `SourceObservation` knowledge. `NativeHttpCollector.collect()` becomes a thin wrapper that maps fetcher evidence to observation rows. All 715-line security tests must stay green after refactor. No fetch path may bypass the primitive. Discovery adds only a stricter redirect policy on top (same-origin follow, cross-origin → `OUT_OF_SCOPE_REDIRECT`, never expand authority).

## 3. Existing HTML parser capabilities

`cheerio@1.0.0` (`packages/representation/package.json:14-17`), imported in `packages/representation/src/extraction.ts:4`.

- `extractJsonLd(html,path)` (`extraction.ts:56-83`): reads `script[type="application/ld+json"]`, JSON.parse per block (invalid ignored), dotted path + `[n]` via `getPath` (`extraction.ts:15-47`), `scalarText` accepts string/finite number/boolean (`extraction.ts:49-54`), `normalize` = NFC + newline fold + trim (`extraction.ts:13`). 0→NOT_FOUND, >1 distinct→AMBIGUOUS, else OBSERVED with `node_identity:json-ld:{path}`.
- `extractCssText` (`extraction.ts:85-105`): `$(selector).text()`, same NOT_FOUND/AMBIGUOUS/OBSERVED with `css:{selector}`.
- `extractMetaContent` (`extraction.ts:107-127`): `$(selector).attr("content")`, `meta:{selector}`.
- No dedicated visible-text extractor; closest is `CSS_TEXT`. No script/style/noscript stripping — `CSS_TEXT` uses `.text()` verbatim; JSON-LD explicitly reads script contents. Discovery's VISIBLE_TEXT surface (exclude script/style/noscript, no JS execution) is new logic but should live in `packages/discovery/matcher.ts` reusing `normalize` + `scalarText` semantics, not a second cheerio wrapper.
- Malformed JSON-LD does not crash (try/catch per block, tested `representation.test.ts:428-451`).

## 4. Truth type names and comparator mappings

Manifest layer (`packages/truth/src/values.ts:6-11`): `ManifestValueType=text|boolean|money`; `ManifestValue={text:string}|{boolean:boolean}|{money:{amount:decimal-string,currency:/^[A-Z]{3}$/}}`. Bridge (`values.ts:74-88`): `BridgedFact{value_text,value_type:TEXT|BOOLEAN|CURRENCY}`, `encodeBridge` money→`"<amount> <CURRENCY>"` (e.g. `49.00 USD`).

DB/protocol: `authoritative_facts.value_type CHECK IN (TEXT,NUMBER,CURRENCY,BOOLEAN,DATE,URL,ENUM)` (`0001_init.sql:43-58`); protocol `FactV1.value_type: string` unconstrained (`packages/protocol/src/schema.ts:134-150`); repo `FactRow` (`packages/db/src/repositories.ts:88-102`).

Representation comparators (`packages/representation/src/comparators.ts:1-76`): `EXACT_TEXT→compareExactText` (NFC equality), `BOOLEAN→compareBoolean` (TRUE_TOKENS `true,yes,1,on,enabled`, FALSE_TOKENS `false,no,0,off,disabled`, null→UNKNOWN), else `MONEY→compareMoney` (regex `pre?(num)post?`, symbol map `$:USD €:EUR £:GBP ¥:JPY`, both sides must parse + known currency, JPY 0 decimals else 2, minor-unit equality). `deriveFinding` (`evaluate.ts:14-65`): null/absent/NOT_FOUND/AMBIGUOUS/UNSUPPORTED/FAILED→UNKNOWN, never DRIFT.

Discovery matcher mapping: money → reuse `parseMoney/compareMoney` semantics (currency must be known, never infer from business locale); text → exact normalized scalar for JSON-LD/meta, Unicode+whitespace collapsed substring with token-boundary + short-value guard for visible text; boolean → structured/meta only, never visible prose `true/false/yes/no`. New: `matcher_version` persisted per run/match; structured money object-local `price/lowPrice/highPrice/amount + priceCurrency/currency` pairing is additive.

## 5. Authority-lineage query capabilities

Lineage key: `version INT + supersedes_id UUID NULL` (`0001_init.sql:51-52`). Writes: `supersede` (prev→SUPERSEDED + INSERT version+1), `reactivate` (retired→new ACTIVE version+1, old RETIRED untouched), `retire` (`packages/db/src/truth.ts:88-127`, `repositories.ts:193-207`).

Reads today:
- `ProductReadRepository.factHistory(business,subject,predicate)` subject/predicate scan ordered by version (`product.ts:129-132`).
- `ProductReadRepository.factLineage(business,factId)` root-first full-component CTE (up via `supersedes_id`, down to all descendants, cycle-safe `path + depth<1000`) — any starting version returns same component (`product.ts:133-162`).
- Sync helpers: `activeFacts`, `provenanceKeys`, `latestLineage DISTINCT ON (manifest_key) version DESC` (`truth.ts:51-73`).
- API `GET .../facts/:factId/history` → `factLineage + assertLinearLineage` + per-version provenance (`router.ts:948-990`).

Fail-closed: `assertLinearLineage` (`reads.ts:278-307`) rejects self-supersession, dangling id, fork (children>1), heads≠1, cycles, disconnected → `FactLineageForked` → HTTP 500 (`router.ts:977-979`). DB backstop `check_single_active_manifest_fact` for repository-managed keys (`0006_truth_closeout_v1.sql:9-28`); per-business serialization via `businesses FOR UPDATE` (`truth.ts:139-164`). No DB linearity constraint — forks storable, rejected at read.

Discovery needs: frozen `FactLineageSnapshotV1` per lineage (root id, active id/version, value type, current canonical value, distinct historical values + ids/versions), deterministic SHA-256 `authority_snapshot_digest` on run, root = `supersedes_id` chain (never mutable subject/predicate). Malformed (fork/cycle/no-head) → `UNSUPPORTED_AUTHORITY_STATE`, skip lineage conservatively. Metadata-only same-value versions classify as CURRENT, not historical.

## 6. Worker queue/claim architecture

`apps/worker/src/runner.ts:1-41`: single-threaded sequential `while(true){runOnce→sleep only if idle}`, poll `WORKER_POLL_MS` default 1000ms (`runner.ts:24`), one `runOnce` at a time per process. `CheckRunner.runOnce` → `runs.claimOne()` (`check-runner.ts:122`): atomic CTE `QUEUED ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED + UPDATE→RUNNING` (`repositories.ts:387-409`), safe for N concurrent processes (proven `integration.test.ts:115-147`). Separate statements thereafter (claim→question→recordAttempt→spawn `openrecord-worker` 60s timeout→observation→markFinished); no encompassing transaction. Retry `MAX_WORKER_ATTEMPTS=4` (`check-runner.ts:33`), exponential 500ms×2 (`rust-worker.ts:152-155`), retryable only rate/unavailable/timeout.

Gaps for discovery: states are `QUEUED|RUNNING|SUCCEEDED|FAILED` (`0001_init.sql:78`) — no PARTIAL; no heartbeat/lease/reaper columns; crash between claim and `markFinished` strands ROW in RUNNING forever (no recovery today). No second job type — `claimOne` hard-filters `check_runs`, `runOnce` hard-codes question→Rust flow.

Discovery needs new `DiscoveryRunner` alongside `CheckRunner` (concurrent loops, bounded page concurrency 2/origin, no unbounded fanout, no Redis/Kafka). Reuse SKIP-LOCKED claim template + guarded transitions + `attempt_count` observability, but add `heartbeat_at/lease` + reaper for multi-minute scans. Network fetch outside DB transactions; persist observation+matches+frontier-DONE atomically after fetch.

## 7. Whether existing DB primitives can support durable discovery jobs

No — new tables + migration required. `check_runs` forbids PARTIAL, lacks kind/payload/progress/lease columns, requires `question_id FK`, and `observations.check_run_id UNIQUE` enforces 1:1 (`0001_init.sql:72-99`). Representation tables (`0004_representation_graph_v1.sql:9-72`) are append-only evidence, not queues. Zero `discovery/frontier` tables exist. Rust `prompt_discovery` is CLI-local, not hosted.

Reuse patterns: guarded `WHERE status=` transitions (`repositories.ts:410-427`), `recordAttempt`, Effect retry, `withSession+getScoped→404` tenancy, `HttpRouter.concat` second-chain for `/discovery` routes (`router.ts:992`), `ProductReadRepository` read-model separation.

Required additions (additive, PG16, append-only raw + mutable orchestration, FK tenancy `business→scope→run→frontier→observation→match`, same-business fact refs, DB tenancy triggers mirroring `check_representation_tenancy`):
- `discovery_scopes(id,business_id,root_url,canonical_origin,path_prefix,enabled,ownership_assertion=OPERATOR_ASSERTED_OWNED,created_at)` + unique `(business_id,canonical_origin,path_prefix)`.
- `discovery_runs(id,business_id,scope_id,authority_snapshot_digest,matcher_version,policy_version,budget_snapshot,state QUEUED|RUNNING|SUCCEEDED|PARTIAL|FAILED,queued_at,started_at,completed_at,heartbeat_at,attempt_count,failure_class,failure_detail,requests,bytes,pages_fetched/not_modified/failed/skipped_robots,candidates_found)` + partial index one active per scope.
- `discovery_frontier(id,run_id,business_id,canonical_url,requested_url,discovered_via ROOT|ROBOTS_SITEMAP|DEFAULT_SITEMAP|SITEMAP|LINK,parent_url,depth,state PENDING|IN_PROGRESS|DONE|SKIPPED,skip_reason,lease_at,attempts,order_key)` + unique `(run_id,canonical_url)`.
- `discovery_observations` (≈ spec `DiscoveryFetchObservationV1`: resource_kind ROBOTS|SITEMAP|PAGE, requested/canonical/final URLs, via/parent/depth, http_status/content_type/etag/last_modified/body_digest/body_bytes, collection_state/failure) append-only.
- `discovery_matches` (≈ `DiscoveryMatchV1`: run/page_observation/lineage_root/matched_fact/version/matched_value/surface JSON_LD|META|VISIBLE_TEXT/locator/snippet≤512/relation CURRENT|HISTORICAL/matcher_version) append-only.

## 8. URL canonicalization

`normalizeUrl` + `sameCanonicalUrl` (`packages/representation/src/url.ts:6-32`): http/https only else null; scheme+host lowercase; strip default ports; path `/` preserved else trailing slash trimmed; `search` preserved exactly; fragment dropped. Tested (`representation.test.ts:503-511`).

Discovery inherits exactly: fragment irrelevant, query significant (no collapsing). Consequences per spec: sitemap/explicit-root query URLs allowed as distinct identities; link-discovered query URLs → `QUERY_LINK_SKIPPED` (record, do not strip-and-crawl). Same-origin = scheme+host+port equality post-normalization; V1 no subdomain traversal (`www.acme` ≠ `docs.acme`); path-prefix subtree enforced unless exact root. Deterministic frontier order (stable sort, no unordered Set/Map from input). Dedupe one frontier row per exact canonical identity per run.

## 9. What MUST remain distinct (discovery vs Representation Graph)

- `SourceTargetV1{url,control:OWNED|THIRD_PARTY|UNKNOWN}` (`types.ts:16-23`) + `SourceBindingV1{fact, target, extractor{JSON_LD|CSS_TEXT|META_CONTENT}, comparator}` (`types.ts:31-43`) are deliberate operator/citation constructs. Creation today only from `OPERATOR|FACT_SOURCE|AI_CITATION` (`policy.ts:9-15`), never crawl (`policy.ts:7`). Discovery must NOT auto-create either per candidate — especially no brittle CSS selectors for visible text.
- `SourceObservationV1` (`types.ts:55-74`) + `ObservedSourceValueV1` (`types.ts:78-94`) + `RepresentationFindingV1{IN_SYNC|DRIFT|UNKNOWN}` (`types.ts:98-105`) + `AiCitationEdge{CITED never CAUSED_BY}` (`types.ts:107-114`) remain the only path to IN_SYNC/DRIFT. Candidate states `CURRENT_VALUE_FOUND|HISTORICAL_VALUE_FOUND|MIXED_KNOWN_VALUES` are discovery-local, derived from match rows, never mixed into finding counts/filters.
- `collectAndEvaluate` (`service.ts:38-98`) + `buildGraph` (`graph.ts:51-81`) + `resolveEffectiveEvidence` (`effective.ts:34-67`) + `latestSuccessfulByTarget` (failures never erase valid evidence, `graph.ts:43-49`) stay untouched for bindings. Discovery gets parallel `DiscoveryFetchObservation + DiscoveryMatch + candidate read model` with its own 304/authority-change reuse rules (Phase 12): reuse only when authority digest + matcher version same; else force body re-fetch, never guess from old matches.
- Laws preserved: authority≠observation, discovery≠verification, candidate≠binding, candidate≠DRIFT/IN_SYNC, no-match≠absent, fetch-failure/robots-denial/JS-shell≠absent, bounded scan≠exhaustive coverage, no scores.

## 10. Exact schema additions required

See §7 table list. Budgets persisted per run snapshot: pages 250 (hard 1000), sitemap docs 20 / entries 10k / decompressed 5MB, robots 256KB, page 1MB (existing default), concurrency 2/origin, crawl-delay ≥200ms, wall-clock 10min → PARTIAL + `BUDGET_EXHAUSTED` (never "scan complete"). Robots: 200→parse, 404/410→no file, 401/403→ROBOTS_DENIED no crawl, 5xx/timeout→ROBOTS_UNAVAILABLE fail-closed. Sitemap order robots→/sitemap.xml→indexes→urlsets, `.xml.gz` capped both sides, no XXE/DTD/fetch-external, cross-origin sitemap recorded-not-fetched. Link fallback only when zero usable sitemap URLs: `<a href>` via cheerio, same-origin+prefix+http/https+robots-allowed, depth≤2, no mailto/tel/js/data/off-origin. User-Agent `OpenRecordDiscovery/1.0` for robots+pages, no spoofing; no cookies/auth/browser/Playwright/external crawler/LLM/scores/delivery in V1. API: `GET|POST .../discovery/scopes`, `GET|POST .../discovery/runs` (409 on duplicate active), `GET .../discovery/candidates` — all `withSession+getScoped→404`, POST run returns QUEUED immediately. UI: nested `/businesses/:id/representations/discovery` under Representations with `Discover sources/Scan site` action, scopes + run status (Queued/Running/Completed/Partial/Failed) + candidate table (Approved fact/value, Found value, Page, Match, Found via, Last scan; labels Current/Historical/Multiple only) + `authority_changed_since_scan` rescan warning; no sidebar change, no finding-filter change, reuse `PageHeader/Card/Table/Badge/Alert/Button/Skeleton/EmptyState/Dialog` (`@/components/...`), no auto Track/Fix/Rewrite.

Acceptance dependency: local fixture server (no internet) proving Acme $49→$59 lineage across /pricing (CURRENT), /docs/billing (HISTORICAL), /compare (MIXED), /private (NOT FETCHED robots), /dynamic shell (no candidate), off-origin/query-link skips, second-run 304 reuse, $59→$69 truth-change invalidation, sitemap/robots/SSRF/matcher/authority/durability/tenancy/UI suites per spec Phases 27-37.
