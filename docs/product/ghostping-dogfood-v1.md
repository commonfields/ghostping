# Ghostping dogfood V1 (evidence, not marketing)

Environment: local staging (API :3001, web :3000, worker, PostgreSQL 14 local; CI covers PG16).
Dates: 2026-10-04. Business: "Ghostping" (demo account, local DB only — never production).
LIVE_AI_DOGFOOD = BLOCKED (no provider credentials present or authorized; all AI observations below are mock plumbing).

## Approved assertions (10, all supported by implementation)

- Ghostping is not a GEO visibility/ranking tool (no rank tracking exists).
- Ghostping does not guarantee AI answer changes (no mechanism exists).
- Ghostping uses no accuracy/visibility scores (none exist; guards tested).
- Ghostping does not auto-fix sources (no writers exist).
- Ghostping observes AI answers, tracks owned sources, requires human judgment, preserves raw evidence, supports mock + one pinned live model.
- Primary loop: know-observe-diagnose-act-verify-reobserve-record.

## Intended positioning (thesis, not fact)

"Ghostping is an AI Representation Integrity system: know what AI tells customers, trace problems to evidence, correct what you control, verify afterward."

## Buyer questions (12, asked via API)

What is Ghostping? / problem solved? / another GEO tool? / guarantee ChatGPT changes? / only pricing? / stale info on my site? / how is correctness known? / auto-fix third-party? / visibility score? / who should use it? / difference vs Profound/Scrunch? / evidence preserved?

## Controlled source inventory

- CONTROLLED: README.md, docs/, GitHub repo (public, description set, no homepage).
- PARTIALLY_CONTROLLED: github.com/urbiens/ghostping (platform chrome + robots policy not ours).
- EXTERNAL: model outputs, third-party pages.
- Not real: website/ (placeholder links), ghostping.dev (nonexistent).

## Baseline observations (mock, plumbing only)

4 checks SUCCEEDED with observations on the Effect-native runtime (post-#19, no Rust). Mock answers are Northstar-flavored regardless of business — mock proves execution/storage, nothing about value.

## Issues (real, from dogfood flow)

1. WRONG: "Ghostping guarantees that ChatGPT will change its answer" CONTRADICTED by `guarantees_ai_answers=false`. Genuine loop output (claim→judgment→issue works).
2. SERIOUS tool finding: real discovery against github.com/urbiens/ghostping SUCCEEDED (1 page) with 9 CURRENT/META candidates — all coincidental boolean matches (`octolytics-*=true/false`, `react-profiling=0` parsed as false) with no semantic relation to the asserted facts. Recorded as matcher-precision limitation; mitigated with candidate evidence transparency (locator+snippet display) rather than precision heuristics. Text/money assertions (the severe commercial cases) do not share this coincidence rate.

## UNKNOWNs

- Whether any live surface misrepresents Ghostping (no credentials → untested).
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

## Did Ghostping materially help Ghostping?

Partially. It executed the full loop on plumbing, caught no live misrepresentation (couldn't look), but genuinely exposed a precision weakness in its own matcher plus two missing loop surfaces (since built). That is a legitimate assay result: useful, not yet pilot-proving.
