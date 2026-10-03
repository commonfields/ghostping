# Product Surface Assay V1

Base: `origin/main` @ `ebf745a` (PR #15 merged). Branch: `feat/product-surface-v1`.

## 1. Current web IA

Router `apps/web/app/main.tsx:20-55`: public `/signin|signup`; gated tree
`RequireAuth > WorkspaceProvider > SettingsProvider > AppShell` with `/`
(Home), `/businesses/:id/(overview|facts|checks|issues)` + index→overview
(`business.tsx:40-46`), `/observations/:observationId`. No `/today` route:
`Today` is an Overview-internal view via `?view=today|agent` + floating
Tabs (`business.tsx:37-74`).
Sidebar (`app-shell.tsx:152-184`): Workspace group Overview / Issues
(+attention count) / Checks / Approved facts; Account group All businesses.
Breadcrumbs (`app-shell.tsx:374-418`): business name + section; observations
show BusinessName › Checks › "AI answer".

## 2. Design patterns preserved (do not redesign)

Inset shell (`bg-sidebar` + rounded `bg-background` panel), `max-w-6xl`,
compact `PageHeader` (`page.tsx:4-14`), `EmptyState` (dashed, centered icon),
`Card` + edge-bleed `Table`, `Tabs` filters, `Alert`, `Dialog`,
`DropdownMenu`, `Tooltip`, `Skeleton`, `Separator`, Inter, deep-green
accent, dark mode via CSS vars. Status tokens `--wrong/--partial/--unknown/
--review/--supported` with fixed stack order; `IssueStateBadge`,
`RunStatusBadge`, `FactStatusBadge`, `VerdictBar` (`status.tsx`, `charts.tsx`,
`globals.css:36-56,92-109`).

## 3. UI primitives to reuse

`PageHeader, EmptyState, Card, Badge, Alert, Button, Tabs, Table, Skeleton,
Tooltip, Dialog, DropdownMenu, Separator` — all exist. Data via
`useApi(key, fetcher, {pollMs})` (`lib/use-api.ts:7-39`); mutations in
`lib/api.ts` + toast + `reload()`; `WorkspaceProvider` holds businesses +
`Issues.overview` counts (`lib/workspace.tsx`).

## 4. Status-color semantics

wrong=#d03b3b, partial=#e09a12, unknown=#8277c9, review (needs review),
supported=#1f9d6a; blue for unreviewed/checks volume. Mapping for new
states: In sync→supported, Drift→wrong, Unknown→unknown (text, never color
alone).

## 5. Current API capabilities (`apps/api/src/router.ts`)

Session auth (`sessionOf/getSession/requireSession/withSession`),
business scoping (`getScoped` else 404), child re-join tenancy. Routes:
auth, businesses, facts (list + overlap `conflicts[]`, create w/
`activeOverlapping`→422, supersede, retire), questions, check-runs (mock|
9router), observations (`{observation+raw_text, claims[]}` — no citations),
claims, judgments, issues (joined claim/answer/judgment/facts + derived
state, RESOLVED filtered), analytics, overview (counts only). Errors:
401/404/409-email/422/500 via `Effect.catchAll` (defects unmapped → 500).

## 6. Representation read capabilities

Almost none over HTTP: `db/representation.ts` has only
`SourceTargetRepository{create,listByBusiness}` and
`SourceObservationRepository{create,latestByTarget,historyByTarget}` — no
binding repository, and the router wires neither. Raw tables exist
(`0004`: targets/bindings/observations/values + tenancy/append-only).

## 7. Truth/authority read capabilities

Facts list returns rows + conflicts; no authority mode, no provenance, no
history endpoint. `FactRepository` mutations die with `AuthorityError` on
repository-managed businesses (defect → currently 500 through the router).
Mode/provenance tables exist (`0005`/`0007`) with zero HTTP exposure.

## 8. Issue/citation data

Issues SQL returns claim/answer/provider/model/time/question/judgment/facts
(`router.ts:768-783`); citations are stored (`observation_citations`,
`WorkerResult.citations`) but never returned by issues/observation reads.

## 9. Empty states

Established `EmptyState` everywhere (no questions/runs/facts/inbox-clear/
not-found). New surfaces need: no representations ≠ healthy; not observed
≠ drift; failed check ≠ absent; no citation ≠ UNKNOWN citation.

## 10. Analytics behavior

`today.tsx` KPI strip + stacked charts + provider/question/fact tables +
CSV export + period tabs. Keep all of it; move below operational content.
`contracts` Routes table lacks the analytics entry (drift, out of scope to
fix beyond adding the missing typed entry alongside new reads).

## 11. Missing hosted read paths (to build, minimal + authenticated)

`Truth.get` (mode + facts + provenance + history), `Representations.list/
get` (binding + fact + target + finding + effective observation + latest
attempt + history + citation edges), `Issues.get` (claim detail + citations
+ matched representation state + reviewer decision), observation citations.
Compose overview counts client-side from existing typed reads.

## 12. Truth verify persistence status

NOT wired: `compileVerificationBindings`/`syncVerificationBindings` are
only exercised by truth unit tests with an in-memory store; production
`syncManifestFacts` (service + cli + pgSyncStore) never touches
SourceTarget/SourceBinding, and the API router has zero truth/representation
imports. This milestone wires the existing bridge into the cli sync flow
with a PG-backed `BridgeStore` (canonical-URL dedupe, logical lineage, no
value copying).

## 13. Latest attempt vs effective evidence

`buildGraph` (`representation/src/graph.ts:52`) derives findings from
`latestObservationByTarget` — the newest attempt INCLUDING failures. A
FAILED hop has no value, so `deriveFinding` yields UNKNOWN and a later
timeout erases prior IN_SYNC. `latestSuccessfulByTarget` already exists
(`graph.ts:44-49`) but is unused. Fix domain semantics first (findings from
latest successful), keep full history, and have the API return BOTH
effective observation and latest attempt explicitly. Regression tests
required here, not in React.

## 14. Already exists (reuse, do not rebuild)

`deriveFinding`, money/boolean/text comparators, JSON-LD/CSS/META
extractors, canonical URL rules, CITED-only edges, `collectAndEvaluate`,
`shouldReuseExtraction`, `RepresentationStore` interface, receipt/lock
semantics, `deriveIssueState`, issue-state badges, guard-phrase test
pattern (`acceptance.test.ts` file scan), SSRF-pinned collector. No
Firecrawl/Playwright/MCP/feeds/scores/causality anywhere in the new paths.
