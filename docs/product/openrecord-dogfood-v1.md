# OpenRecord dogfood V1 (evidence, not marketing)

Environment: local staging (API :3001, web :3000, worker, PostgreSQL 14 local; CI covers PG16).
Dates: 2026-10-04. Business: "OpenRecord" (demo account, local DB only — never production).
LIVE_AI_DOGFOOD = BLOCKED (no provider credentials present or authorized; all AI observations below are mock plumbing).

## Approved assertions (10, all supported by implementation)

- OpenRecord is not a GEO visibility/ranking tool (no rank tracking exists).
- OpenRecord does not guarantee AI answer changes (no mechanism exists).
- OpenRecord uses no accuracy/visibility scores (none exist; guards tested).
- OpenRecord does not auto-fix sources (no writers exist).
- OpenRecord observes AI answers, tracks owned sources, requires human judgment, preserves raw evidence, supports mock + one pinned live model.
- Primary loop: know-observe-diagnose-act-verify-reobserve-record.

## Intended positioning (thesis, not fact)

"OpenRecord is an AI Representation Integrity system: know what AI tells customers, trace problems to evidence, correct what you control, verify afterward."

## Buyer questions (12, asked via API)

What is OpenRecord? / problem solved? / another GEO tool? / guarantee ChatGPT changes? / only pricing? / stale info on my site? / how is correctness known? / auto-fix third-party? / visibility score? / who should use it? / difference vs Profound/Scrunch? / evidence preserved?

## Controlled source inventory

- CONTROLLED: README.md, docs/, GitHub repo (public, description set, no homepage).
- PARTIALLY_CONTROLLED: github.com/urbiens/openrecord (platform chrome + robots policy not ours).
- EXTERNAL: model outputs, third-party pages.
- Not real: website/ (placeholder links), ghostping.dev (nonexistent).

## Baseline observations (mock, plumbing only)

4 checks SUCCEEDED with observations on the Effect-native runtime (post-#19, no Rust). Mock answers are Northstar-flavored regardless of business — mock proves execution/storage, nothing about value.

## Issues (real, from dogfood flow)

1. WRONG: "OpenRecord guarantees that ChatGPT will change its answer" CONTRADICTED by `guarantees_ai_answers=false`. Genuine loop output (claim→judgment→issue works).
2. SERIOUS tool finding: real discovery against github.com/urbiens/openrecord SUCCEEDED (1 page) with 9 CURRENT/META candidates — all coincidental boolean matches (`octolytics-*=true/false`, `react-profiling=0` parsed as false) with no semantic relation to the asserted facts. Recorded as matcher-precision limitation; mitigated with candidate evidence transparency (locator+snippet display) rather than precision heuristics. Text/money assertions (the severe commercial cases) do not share this coincidence rate.

## UNKNOWNs

- Whether any live surface misrepresents OpenRecord (no credentials → untested).
- Actual model retrieval paths (citations only where providers give them).
- Whether the GitHub page content would match TEXT assertions (only booleans asserted; page fetched once).

## Source diagnosis

- Issue 1: source = mock answer text (citable, preserved). No owned-source staleness involved.
- Issue 2: source = GitHub platform chrome meta tags (partially controlled page, uncontrolled chrome). Diagnosis: value-only boolean matching cannot see subject semantics — limitation documented, not patched with heuristics.

## Intervention selected

One low-risk controlled change is available (e.g. README wording clarification) but deliberately NOT performed: no genuine mismatch against a controlled source was found that an edit would fix, and edits solely to trigger AI behavior are forbidden. During API verification a test intervention was recorded against the dogfood issue in error (no README change accompanied it); because interventions are append-only, it was corrected product-natively with a superseding `OTHER` correction referencing the same issue and stating no action was taken. Both rows list on the issue. This accidentally but genuinely exercised the correction chain live.

## Source verification / AI re-observation / outcome

Not executed: nothing was changed, and live re-observation is BLOCKED on credentials. The plumbing for both (bindings/discovery re-checks, same-question check-runs with preserved measurement context) is proven working above.

## Remaining follow-up (FOLLOWUP_REQUIRED)

1. Live-surface baseline once credentials are authorized (then: real issues → real intervention → verify → re-observe).
2. Before/after compare view (deferred; history tables suffice).
3. Matcher key-relevance study for boolean META candidates (roadmap candidate, needs evidence first).

## Did OpenRecord materially help OpenRecord?

Partially. It executed the full loop on plumbing, caught no live misrepresentation (couldn't look), but genuinely exposed a precision weakness in its own matcher plus two missing loop surfaces (since built). That is a legitimate assay result: useful, not yet pilot-proving.

---

## LIVE section — 2026-10-04 (this mission)

- Canonical repo: `commonfields/openrecord` (urbiens 301-redirects; origin updated). Main: `60bda0c`.
- Environment: local staging (API :3001, web :3000, worker, local PG; CI PG16 green).
- Public sources: README.md + docs/ CONTROLLED (content via public repo); github.com/commonfields/openrecord PARTIALLY_CONTROLLED (chrome/robots uncontrolled); website/ local-only placeholder; ghostping.dev nonexistent (verified).
- Facts: 10 implementation-verified assertions (retained) + 1 honest TEXT fact (`github_description`).
- Buyer questions: 12 retained.
- Source observations: real fetch of github.com page (og:description) → OBSERVED → finding DRIFT (platform suffix vs approved text — informative, no action warranted).
- Discovery: canonical scope SUCCEEDED, 1 page, 9 candidates — same boolean-META coincidence class as before.
- Provider config: mock + pinned 9router supported; NINE_ROUTER_API_KEY and all other provider keys ABSENT (names only, no values present anywhere).
- Live AI: zero calls executed → LIVE_AI_DOGFOOD = BLOCKED_BY_CREDENTIALS. No mock output presented as live evidence.
- Issues: pre-existing WRONG guarantee-claim (mock lineage) stands; no live misrepresentation found (could not look).
- Intervention: none warranted; none performed.
- Product friction BLOCKER found and fixed in this mission: no product path could create a tracked SourceBinding (VERIFY SOURCE unreachable for every new business) → `fix/live-dogfood-blocker-v1` (target+binding creation, candidate Track dialog, idempotent, no auto-promotion). Corroborating SERIOUS: candidate rows showed no path forward.
- Value answers: (1) no new misrepresentation beyond the known mock one; (2) nothing to be obvious about without looking — live surfaces untested; (3) source-side evidence trustworthy (full fetch/extract/compare trail); (4) controllable place identified (tracked binding, now creatable); (5) operator acted (fact+binding+verify via product); (6) verified afterward with full evidence; (7) AI recheck not performed (no credentials); (8) before/after source evidence understandable; (9) UNKNOWN held (no live claims made); (10) repeat usage plausible for source monitoring, unproven for AI loop.
- Moat: no new evidence (no live loop completed). Corpus record: NOT generated (would be synthetic).
- Commercial: no dimension updates warranted beyond prior remap; pilot gate unchanged (false).
- Decision for this mission: PRODUCT_GAP_FOUND (blocker PR #23 open, unmerged).

---

## LIVE RESUME section — 2026-10-04 (PR #23 merged, main f5ea719)

- Canonical repo re-verified: `commonfields/openrecord`; urbiens URL 301-redirects (transfer, not a fork). Origin updated.
- PR #23 MERGED (had been the blocker fix: deliberate target+binding creation + candidate Track dialog, exact-head CI green). Boundary invariants re-confirmed by inspection: no auto-promotion path in discovery/worker, tenant-scoped creation, 404s on unknown/cross-tenant, no intervention/truth/check side effects in tracking code.
- Product-path acceptance on merged main, zero SQL: discovery candidate (META `octolytics-dimension-repository_public`) → Track → target (idempotent re-track returned existing row) → binding (META_CONTENT/BOOLEAN) → detail (UNKNOWN, never observed) → Verify source → FETCHED, OBSERVED `true`, finding IN_SYNC. Representations list holds exactly the 2 deliberate bindings — no auto-promotion.
- Discovery re-run on canonical scope: SUCCEEDED, 1 page, 9 candidates — same boolean-chrome coincidence class (octolytics/react-profiling true/false). BOOLEAN precision finding stands, still mitigated by evidence transparency, not heuristics.
- Provider config from current code: only `mock` + `9router` exist as hosted providers; no hosted code reads OPENAI/ANTHROPIC/GEMINI keys. Live gate needs `NINE_ROUTER_ENABLED=true` + `NINE_ROUTER_API_KEY` + `NINE_ROUTER_MODEL`; all ABSENT, loopback default endpoint unreachable. Result: LIVE_AI_DOGFOOD = BLOCKED_BY_CREDENTIALS (again). No mock output presented as live; no credentials created.
- Friction this run: none new (BLOCKER class empty). SERIOUS carried over: boolean-candidate noise (documented, tolerated). MINOR: mock answers Northstar-flavored for any business.
- Corpus: no real record (correctly absent — nothing live happened).
- Value: source-side loop now completable end-to-end by an operator (track → verify → evidence); AI-side loop remains unproven for lack of credentials, not for lack of product path.
