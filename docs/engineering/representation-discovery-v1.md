# Representation Discovery V1

Date: 2026-10-03. Branch: `feat/representation-discovery-v1`.
Parent assay: `docs/engineering/representation-discovery-assay-v1.md` (read-only input, not overwritten).

Discovery answers one question: **which pages on an explicitly configured,
operator-owned site appear to contain known fact values?** It never verifies,
never binds, and never judges. This doc records the V1 architecture, the
hard boundaries, and the UI contract. Backend implementation lives in the
sibling workstreams (`packages/discovery`, migration `0009_discovery_v1`,
`packages/representation/src/safe-http.ts`); the web UI in this workstream
targets the contract below and renders honest empty states until it lands.

## 1. Architecture

```
operator ──POST /discovery/scopes {root_url}──▶ API ──▶ discovery_scopes
operator ──POST /discovery/runs {scope_id}───▶ API ──▶ discovery_runs (QUEUED)
                                                    │
DiscoveryRunner (worker, alongside CheckRunner) ◀──┘ claim via SKIP LOCKED
  │  1. snapshot authority lineages (digest on run)
  │  2. seed frontier: ROOT → robots → sitemaps → link fallback
  │  3. fetch pages through SafeHttpFetcher (bounded, ≤2/origin)
  │  4. match page text against lineage values → discovery_matches
  │  5. mark run SUCCEEDED / PARTIAL / FAILED with concrete counters
  │
web ──GET /discovery/scopes|runs|candidates──▶ API ──▶ DiscoveryPage
```

- One active run per scope. `POST /discovery/runs` while a run is
  QUEUED/RUNNING returns 409; the UI disables the Scan button while active
  and explains the 409 in words.
- The network fetch always happens outside DB transactions; each fetched
  page persists its observation row, match rows, and frontier-DONE marker
  atomically after the fetch.
- No Redis, no Kafka, no second queue system: the same SKIP-LOCKED claim
  template as `check_runs`, with guarded `WHERE status=` transitions.

## 2. Boundaries (what discovery is not)

These are load-bearing distinctions. The UI encodes them in labels and copy;
reviews must hold them:

- **Candidate != Binding.** Discovery never creates `SourceTargetV1` or
  `SourceBindingV1`. A candidate is not a tracked representation until it
  is explicitly configured. UI copy: "A candidate is not a tracked
  representation until it is explicitly configured."
- **Historical != DRIFT.** `HISTORICAL_VALUE_FOUND` means the page contains
  an older approved value. It is discovery-local match evidence, never a
  representation finding. The candidate table never says Drift.
- **Current != IN_SYNC.** `CURRENT_VALUE_FOUND` means the page contains the
  current approved value. It is not an IN_SYNC finding and the table never
  says In sync.
- **No-candidate != absence.** An empty candidate list reflects what one
  bounded scan reached (robots denials, fetch failures, JS-only shells, and
  budget stops are all non-evidence). It is not proof a value is absent.
- **Bounded != exhaustive.** Every scan stops at budgets (below). The UI
  says "Ghostping found N candidate pages in this scan." Never "all pages",
  never full-site or complete-scan language.
- **Discovery != verification, authority != observation.** Matching compares
  observed page text against frozen authority snapshots; it never edits
  truth, never scores, never claims a page caused anything.

## 3. Site scope

- Operator posts one `root_url`. The backend canonicalizes it to
  `(canonical_origin, path_prefix)` with the same `normalizeUrl` semantics
  as representations: scheme+host lowercase, default ports stripped,
  trailing slash trimmed except root, query preserved, fragment dropped.
- Unique `(business_id, canonical_origin, path_prefix)`; fetching never
  leaves scheme+host+port equality post-normalization, and never crosses
  into subdomains (`www.acme` != `docs.acme`). Cross-origin redirects end
  the hop as `OUT_OF_SCOPE_REDIRECT`, never expand authority.
- Ownership is operator-asserted (`OPERATOR_ASSERTED_OWNED`). UI copy is
  "Marked as owned by the operator." and "Ghostping scans only this
  explicitly configured site scope." The UI never says "Ownership verified".

## 4. Robots

- `User-Agent: GhostpingDiscovery/1.0` for robots and page fetches. No
  spoofing, no cookies, no auth, no browser/Playwright, no external crawler.
- robots.txt outcomes: 200 parses; 404/410 means no file; 401/403 means
  `ROBOTS_DENIED` and nothing under that path is crawled; 5xx/timeout means
  `ROBOTS_UNAVAILABLE` and the run fails closed (never crawls blind).
- `crawl-delay` honored with a 200ms floor. Disallowed URLs are recorded as
  skipped, never fetched.

## 5. Sitemap seeding

- Order: robots-declared sitemaps, then `/sitemap.xml`, then sitemap
  indexes, then urlsets. `.xml.gz` is accepted inside the same caps.
- Caps per run: 20 sitemap documents, 10k entries, 5MB decompressed total.
- No XXE/DTD/external-entity fetching. Cross-origin sitemap URLs are
  recorded, never fetched. Only same-origin, in-prefix, robots-allowed URLs
  enter the frontier.

## 6. Link fallback

- Used only when sitemaps yield zero usable URLs. Parses `<a href>` with
  the same HTML reader as matching, depth ≤ 2 from the root.
- Same-origin + path-prefix + http/https + robots-allowed only. Query-bearing
  link URLs are recorded as `QUERY_LINK_SKIPPED`, never stripped-and-crawled.
  No mailto/tel/javascript/data links, no off-origin expansion.

## 7. Budgets (persisted per-run snapshot)

- Pages: 250 soft target, 1000 hard ceiling. Concurrency ≤ 2 per origin.
- Page body 1MB (shared default), robots 256KB. Wall clock 10 minutes.
- Hitting any budget ends the run as PARTIAL with reason
  `BUDGET_EXHAUSTED` (or the specific limiter). The UI shows the PARTIAL
  badge plus the stored reason, and concrete Pages checked / Pages skipped /
  Candidates found counts. No progress percentages anywhere: a scan reports
  states (Queued/Running/Completed/Partial/Failed), never a completion
  fraction.

## 8. Crash recovery

- Runs carry `heartbeat_at` plus a lease column. A reaper returns runs whose
  heartbeat is older than the lease to QUEUED (attempts incremented), so a
  worker crash between claim and finish never strands a scope in RUNNING.
- Frontier rows are `PENDING | IN_PROGRESS | DONE | SKIPPED` with per-URL
  leases, unique `(run_id, canonical_url)`, deterministic order key. A
  reclaimed run resumes from remaining PENDING rows; DONE rows are never
  re-fetched within the run.

## 9. Authority snapshots

- At run start the runner freezes one `FactLineageSnapshotV1` per lineage:
  root id (follow `supersedes_id`, never mutable subject/predicate),
  active id/version, value type, current canonical value, and the distinct
  historical values with their ids/versions. A SHA-256
  `authority_snapshot_digest` is stored on the run.
- Malformed lineages (fork, cycle, no head) fail closed as
  `UNSUPPORTED_AUTHORITY_STATE` and that lineage is skipped conservatively.
  Metadata-only same-value versions classify as CURRENT, never historical.

## 10. Matching and CURRENT / HISTORICAL / MIXED

- Surfaces: JSON-LD (exact normalized scalar, structured money
  price/lowPrice/highPrice/amount paired with priceCurrency/currency),
  META (same exact semantics), VISIBLE_TEXT (script/style/noscript
  excluded, no JS execution; Unicode+whitespace collapsed substring with
  token-boundary and short-value guards).
- Type mapping reuses representation comparator semantics: money requires a
  known currency on both sides (never inferred from locale); booleans match
  structured/meta surfaces only, never visible prose.
- Per page per lineage the relation is CURRENT (only the current value
  matched), HISTORICAL (only older values matched), or MIXED (more than one
  known value matched). UI labels, with no other vocabulary: "Current value
  found", "Historical value found" (warning color), "Multiple known values".
- Every match row stores `matcher_version`; the run stores the matcher and
  policy versions alongside the authority digest.

## 11. 304 / revalidation policy

- Conditional re-fetch with stored validators (etag, last-modified,
  body digest, origin) is allowed only when the run's authority digest AND
  matcher version both equal the stored ones. Otherwise the body is
  re-fetched in full; matches are never guessed from prior runs.
- A truth change (new fact version) after a scan sets
  `truth_changed_since_scan` on affected candidates. The UI shows an
  "Approved truth changed since this scan" alert with a rescan action.
  Rescanning compares against current approved truth; old matches stay
  readable as history.

## 12. Security

- All fetching goes through the shared safe fetcher (see
  `packages/representation/src/safe-http.ts`): DNS preflight with forbidden
  IP rejection, IP pinning, connect-time peer check, per-hop redirect
  re-validation, hard byte ceilings, 8s timeout, HTML-only allowlist.
- The discovery redirect policy is strictly narrower than the collector's:
  same-origin follows, cross-origin stops. No fetch path bypasses the
  primitive.

## 13. Limitations (stated, not footnoted)

- JS-rendered shells with no server-rendered text yield no candidates; that
  is a tool limit, not evidence of absence.
- Robots-denied and fetch-failed pages are counted as skipped, never as
  clean.
- Boolean and short-text values are deliberately conservative to avoid
  matching prose that merely mentions true/false or fragments.
- V1 has no subdomain traversal, no authentication, no form interaction,
  no LLM judgment, and no scores of any kind.

## 14. UI contract (this workstream)

- Route `/businesses/:id/representations/discovery`, child of
  `BusinessLayout`; breadcrumb special-cased to Business > Representations
  > Discovery. No new sidebar section; the Representations page links out
  with a modest "Discover sources" button. Finding filters and counts are
  untouched.
- Built only from `PageHeader/Card/Table/Badge/Alert/Button/Skeleton/
  EmptyState/Dialog`. Sections: owned site scopes (Add owned site dialog),
  latest scan (Scan site button, Completed label for SUCCEEDED, concrete
  counts, PARTIAL reason, duplicate-trigger guard), candidate table with the
  seven required columns and the two row actions (Open page external,
  View truth link).
- Contracts asserted in `apps/web/tests/discovery.test.ts` (route, labels,
  no Drift/In-sync on candidates, bounded-claim copy, truth-changed
  warning, client surface, language guards). `typecheck`, `lint`, and
  `vitest` all pass for `@ghostping/web`.

## 15. Closeout amendments (review fixes, 2026-10-04)

- 304 carry-forward: a compatible 304 (same scope+URL+digest+matcher,
  value-bearing prior from a terminal run) writes current-run match rows
  with `reused_from_match_id` pointing at the immediate prior match
  (migration `0010_discovery_reuse_v1`). Chained 304s resolve hop by hop.
  Authority/matcher change or missing prior evidence yields no candidate.
  Candidate reads need no change: reuse rows carry the new observation id.
- Worker fairness: `apps/worker/src/runner.ts` runs two independent bounded
  loops (`startRunnerLoops`, Effect fibers, per-iteration error containment)
  so multi-minute scans never starve CheckRunner polling. Shutdown
  interrupts both via structured concurrency; no detached loops.
- Gzip: `decodeSitemapBytes` in `packages/discovery/src/sitemap.ts` is the
  single canonical path (magic bytes decide; bounded `maxOutputLength`
  during inflation; per-document 5MB cap). The runner performs no gunzip.
- Robots: fetches are scope-bound at two layers (fetcher
  `allowCrossOrigin:false` + parser `scopeOrigin` option); cross-origin
  robots content is never applied (UNAVAILABLE, fail closed). Rule matching
  supports Allow, `*`, `$`, longest-wins, Allow-ties, and
  most-specific-GhostpingDiscovery-group selection.
- Counters: `candidates_found` counts distinct page+lineage groups
  (`countCandidateGroups`), never raw match events; 304-reused groups count
  identically. Counter equals candidate read-model row count for the run.
- Comparators: discovery money/boolean/text parsing reuses
  `@ghostping/representation` primitives (`parseMoney`, `parseBoolean`,
  `normalizeExactText`, `compareMoney`); contract tests in
  `packages/discovery/test/comparator-parity.test.ts`.
- Failure handling: a caught deterministic runner error marks the run
  FAILED with typed `RUNNER_ERROR` (best effort); lease recovery remains
  the fallback when the DB itself is unreachable or the process dies.
