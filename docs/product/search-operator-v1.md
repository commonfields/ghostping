# SEARCH_OPERATOR_V1 — Keep a Business Discoverable, Then Prove It

Status: IMPLEMENTED on branch `feat/search-operator-v1` (this document).
Base: `origin/main` @ `8d54516`.

Product job: **find an important technical problem preventing a site from
being properly discoverable, fix it safely, and prove whether the fix is
actually live.** No scores, no rank promises, no autonomous copy.

## 1. Closed loop

```text
OBSERVE (inspect site)
  -> DIAGNOSE (finding + evidence + confidence)
  -> PROPOSE (smallest safe fix, before/after)
  -> AUTHORIZE (human approval, recorded)
  -> MUTATE (branch/commit/PR identity, never auto-merge)
  -> VERIFY (re-inspect the live target)
  -> MEASURE (counts by status: open / awaiting / in progress / pending / verified)
```

A fix is complete only after OpenRecord re-observes the live page.
A merged PR alone never marks anything fixed.

## 2. Vocabulary (concrete language, enforced by tests)

- Findings say what was observed: `Blocked from indexing`,
  `Canonical points elsewhere`, `Page not found`.
- `SITE_INDEXABLE` (OpenRecord-observed directives) and
  `GOOGLE_REPORTED_INDEXED` (what Search Console reports) are separate
  fields, separate UI cards, and never conflated.
- Indexability values: `INDEXABLE`, `BLOCKED_BY_META`,
  `BLOCKED_BY_HEADER`, `BLOCKED_BY_ROBOTS`, `REDIRECTED`, `NOT_FOUND`,
  `SERVER_ERROR`, `CANONICALIZED_ELSEWHERE`, `RENDERING_FAILURE`, `UNKNOWN`.
- Absent-from-sample links are `POSSIBLE_ORPHAN`, never `ORPHAN`.
- Failed inspections read `Inspection incomplete`, never `No problems found`.

## 3. Architecture

```text
packages/site-operator/      pure inspection + fix + adapter + GSC boundary
  inspect.ts                 HTML evidence extraction, classification, findings
  robots.ts / sitemap.ts     deterministic parsers (no DTD/entities, bounded)
  linkgraph.ts               broken-link + possible-orphan derivation
  identity.ts                finding identity (business + URL + kind + evidence)
  fixes.ts                   smallest-fix proposals, conservative classification
  adapter.ts                 SiteAdapter: LOCAL_FILE + GIT (WP/Shopify later)
  gsc.ts                     Search Console provider contract + fixtures

packages/db/                 0016_site_operator_v1.sql + site-operator.ts repos
  site_targets               registered website + adapter binding
  site_inspection_runs       QUEUED/RUNNING/SUCCEEDED/PARTIALLY_SUCCEEDED/FAILED
  site_page_observations     append-only per-URL evidence (never rewritten)
  site_findings              mutable status + identity_key (idempotent upsert)
  site_finding_events        append-only status history
  site_fix_proposals         fix drafts with approval gate
  site_mutations             branch/commit/PR identity (merge is observed only)
  site_verifications         live re-observation outcomes
  site_operator_events       structured ops log (no secrets, no bodies)
  site_gsc_properties        Search Console linkage (blocked without OAuth)

apps/worker/                 site-inspection-runner.ts (third loop; optional,
                             so existing two-loop fairness tests are untouched)
apps/api/                    site-operator.ts (reads) + site-routes.ts (writes)
apps/web/                    Business > Search: overview, finding detail with
                             before/after diff, verification trail, run evidence
```

Reuse: `safeFetch` (SSRF + bounds) and scope policy from the existing
representation/discovery stack; Effect + Postgres patterns unchanged.

## 4. Fix policy (conservative)

- `APPROVAL_REQUIRED`: noindex removal, canonical corrections, internal-link
  fixes. The UI always shows the exact before/after diff first.
- `MANUAL_ONLY`: titles, descriptions, schema, robots.txt, redirects,
  content. OpenRecord does not publish marketing copy.
- `SAFE_AUTOMATIC`: reserved for deterministic mechanical repairs
  (sitemap XML repair drafts it today; nothing auto-applies without a
  mutation record).
- Source mapping unknown -> `MANUAL_ONLY`, never guessed.
- GitHub without `GITHUB_TOKEN` fails closed with a blocked message.

## 5. Verification semantics

- `VERIFICATION_PENDING`: a verification run is queued; outcome unknown.
- `VERIFIED_FIXED`: a later inspection of the same URL no longer exhibits
  the finding kind. Detail: `OpenRecord verified the fix on the live site.`
- `VERIFIED_NOT_FIXED`: the live page still exhibits the issue, even though
  a mutation exists. The system does not lie about merges.
- URLs absent from a run stay pending; they are never guessed.

## 6. Acceptance demo (deterministic, no manual DB edits)

Prerequisites: Postgres running, migrations applied (`pnpm db:migrate`),
API + worker running, a business created.

### Demo 1 — noindex found, fixed, verified live

1. Prepare a fixture checkout (local dir or git repo) with an important
   page containing `<meta name="robots" content="noindex">`.
2. Business > Search > Register website (`POST .../search/sites`
   `{ rootUrl }`). For a local checkout, store
   `repoRef: { rootDir, fileMap: { "<page-url>": "index.html" } }`
   (`rootDir` must resolve inside `SITE_OPERATOR_ROOTS`; the OS temp dir is
   accepted only under test or with `SITE_OPERATOR_ALLOW_TMPDIR=1` for a
   local demo).
3. Inspect site (`POST .../sites/:siteId/runs`). The worker discovers the
   URL via robots/sitemap, records the raw observation, and creates a
   `BLOCKED_BY_META` finding with the exact meta tag as evidence.
4. Open the finding: problem, affected URL, observed evidence, why it
   matters, recommended fix, confidence, history.
5. Prepare the exact change (`POST .../fixes/:proposalId/prepare`): reads
   the mapped source file and stores its path, before/after sha256 and the
   patch hash; the UI shows the exact file diff.
6. Approve (`POST .../fixes/:proposalId/approve { approved: true }`): the
   approval binds to that patch hash. Re-preparing a different change
   returns the proposal to PROPOSED (approval invalidated).
7. Apply (`POST .../fixes/:proposalId/apply`, optional `idempotencyKey`):
   refuses with `PreconditionFailed` if the file changed since preparation,
   `ApprovalInvalidated` if the change differs from the approved one, and
   `MutationFailed` if the bytes read back differ; the same key returns the
   original result. On success the file change is staged
   in the site checkout (local adapter writes it; git adapter stages it
   inside the existing checkout and names the branch). Hosted code never
   shells out: commit and open the PR with normal git tooling, then record
   the observed identity on the finding page (`Record branch` ->
   `Record pull request`; `POST .../mutations/:id/identity`).
   OpenRecord does not merge; merge the PR by hand and record the merge.
8. Deploy the merged change to the inspected target.
9. Verify (`POST .../findings/:findingId/verify`): queues a fresh run;
   the worker re-inspects the live page. With noindex gone the finding
   becomes `VERIFIED_FIXED`; the UI shows Before -> Change -> After.

Covered automatically by
`apps/worker/src/site-inspection.integration.test.ts` (tests 1 and 3)
plus `packages/site-operator/test/adapter.test.ts` for the git path.

### Demo 2 — the system does not lie

1-7 as above, but do not deploy the change (production still serves
noindex).
8. Run verification: the finding becomes `VERIFIED_NOT_FIXED` with the
   detail `Live re-inspection still exhibits the issue.`
Covered by `site-inspection.integration.test.ts` (test 2).

## 7. Security

- All fetching goes through `safeFetch`: DNS preflight + IP pinning,
  forbidden networks (`127/8`, RFC1918, link-local, `::1`, metadata IP),
  redirect re-validation, byte ceilings, timeouts, safe XML (no DOCTYPE).
- Redirects to private destinations fail closed (`TARGET_BLOCKED`).
- Crawl bounds: 50 URLs/run, 1MB/page, 5 redirects, same-origin +
  path-prefix scope, 2-minute wall clock.
- Every filesystem read/write goes through `@openrecord/fs-containment`
  (`resolveContainedPath`: lexical rejection, realpath'd root, no symlink
  or hardlink ever followed, containment re-proved immediately before an
  atomic rename). `repoRef.rootDir` must resolve inside `SITE_OPERATOR_ROOTS`
  (OS temp dir only under test or `SITE_OPERATOR_ALLOW_TMPDIR=1`); unknown
  source mappings refuse to guess. An architecture test forbids fs imports
  elsewhere.
- Approval binds to exact bytes (target path + before/after sha256); apply
  is idempotent per key and records failures (`site_mutations.failure_code`).
- Account isolation preserved end to end (tenancy triggers + scoped
  queries); cross-account reads are 404. Negative tests included.

## 8. Known limitations (explicit, not roadmap fluff)

- Rendered (JS) inspection is discrepancy detection only; V1 fetches static
  HTML and flags when a rendered document would differ. No headless browser
  in the worker.
- Only `BLOCKED_BY_META` has an automated apply path; every other kind is
  propose-and-approve or manual in V1.
- GitHub PR creation records identity from a local git checkout; there is
  no hosted GitHub App / OAuth flow yet (`GITHUB_TOKEN` gate documents the
  boundary), and hosted code never shells out to git (architecture guard):
  commits and merges are performed with normal tooling and observed via
  the mutation identity endpoint. WordPress/Shopify/Webflow adapters are
  interfaces only.
- Live Search Console is contract + fixtures; without OAuth credentials the
  UI says so honestly and keeps serving site-observed state.
- Sitemap discovery is bounded (10 docs, 5000 entries, depth 3); larger
  estates inspect the head of the sitemap, visibly (`PARTIALLY_SUCCEEDED`
  when URL caps bite).
