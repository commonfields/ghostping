# Managed Service V1 — Ghostping Managed AI Representation

Base: `origin/main` @ `fee456d` (PR #33 merged). Status: OPERATOR-RUNNABLE ON MOCK;
LIVE MEASUREMENT BLOCKED ON CREDENTIALS (see §14). No code changes in this
document's mission; all paths below were verified against the tree at base.

## 1. Offer (one sentence)

We monitor what AI systems tell buyers about your company, investigate
important factual problems, correct what you control, and verify what changes
afterward.

## 2. First ICP (working hypothesis, do not broaden yet)

- B2B software company, roughly $1M–$50M revenue/ARR.
- Owner: founder, head of marketing, or product marketing.
- Meaningful public product documentation with buyer questions that can
  materially affect consideration.
- Preferred operational constraint (either/or): marketing/docs source is
  Git-backed, or the company team can implement approved recommendations
  rapidly.
- Out of scope for this mission: pharma, finance compliance, e-commerce
  listings, local businesses, generic agencies.

## 3. Qualification (must all hold before a pilot starts)

1. Customer names 1 brand and approves the factual truth before first check
   (Facts page; `POST /api/businesses/:id/facts`).
2. Customer supplies 10–15 buyer questions (`Checks` page; pilot may be
   narrower than the 15–30 steady-state range until cost is known).
3. At least one controlled source (docs/pricing site) the customer can change
   or approve changes to; sources inventoried CONTROLLED /
   PARTIALLY_CONTROLLED / EXTERNAL.
4. Customer accepts: mock-surface baseline first where live models are
   unconfigured; live re-observation requires a configured 9Router model
   (`NINE_ROUTER_ENABLED=true`, `NINE_ROUTER_MODELS` allowlist,
   `NINE_ROUTER_API_KEY` in env).
5. Customer accepts human-approval boundaries (§7) and explicit non-promises
   (§15).

## 4. Service loop (operator runs; customer consumes findings)

KNOW → MEASURE → REVIEW → PRIORITIZE → DIAGNOSE → ACT → VERIFY SOURCE →
RE-OBSERVE → REPORT → REPEAT (§5 maps each step to the exact surface).

Customer-facing questions, in order: What is AI telling buyers? Is anything
materially wrong? Why do we think it is wrong? What can we change? What did we
change? Was the public source updated? What did AI say afterward? What remains
uncertain?

## 5. Operator runbook (per customer, per week)

All routes business-scoped; unknown/foreign ids read 404 without leaking
existence.

1. **KNOW.** Intake facts on the Truth page; resolve `conflicts[]` before
   first check. (`GET/POST /api/businesses/:id/facts`.)
2. **MEASURE.** On Checks, pick provider Mock (tests/plumbing) or 9Router
   with a configured model, and run each buyer question once.
   (`POST /api/businesses/:id/check-runs` — one CheckRun per
   question/model; there is deliberately no batch endpoint, so a 15-question
   pilot means 15 runs. Progress and `PROVIDER_UNSUPPORTED` failures are
   visible in `GET .../check-runs`.)
3. **REVIEW.** Open each answer (`/observations/:observationId`), transcribe
   material claims by hand (`POST /api/claims`, origin always
   `MANUAL_TRANSCRIPTION` — no automatic extraction exists), record a verdict
   per claim (`POST /api/judgments`: CONTRADICTED / PARTIAL /
   INSUFFICIENT_EVIDENCE / SUPPORTED). Supported claims leave the inbox.
4. **PRIORITIZE.** Work the Issues inbox (`GET /api/businesses/:id/issues`,
   states WRONG / PARTIAL / UNKNOWN / NEEDS_REVIEW; RESOLVED filtered).
   Triage rubric (qualitative, no score): buyer-relevant × materially
   incorrect × strong approved truth × controllable source exists. Human
   judgment decides; fix only the shortlist.
5. **DIAGNOSE.** Per issue (`/businesses/:id/issues/:claimId`): AI-said card,
   approved-truth card, source-evidence card, reviewer decision. Track the
   controlled source first if not yet tracked: Representations → create
   target (URL + control) → create binding (fact + extractor + comparator).
   (`POST .../representations/targets`, `POST
   .../representations/targets/:targetId/bindings`.)
6. **ACT.** Prepare the correction outside Ghostping (manual edit or a Git PR
   the customer approves — Ghostping never writes to customer sources and
   owns no GitHub write access). Then **Record action** on the issue:
   type (`SOURCE_UPDATED` / `SOURCE_PUBLISHED` /
   `THIRD_PARTY_CORRECTION_REQUESTED` / `KNOWLEDGE_BASE_UPDATED` /
   `STRUCTURED_DATA_UPDATED` / `OTHER`), target, performed-at, notes.
   Append-only; corrections supersede, never rewrite.
   (`POST .../issues/:claimId/interventions`; actor is always HUMAN from the
   session, never request JSON.)
7. **VERIFY SOURCE.** On the issue timeline, **Verify source** re-fetches the
   linked tracked representation with the same safe collector
   (`POST .../representations/:bindingId/check`). If the issue has no linked
   binding, the card says so and verification is manual (open the URL, keep
   a note). Source verification and the before/after comparison are
   recomputed on every read; nothing is stored.
8. **RE-OBSERVE.** On the issue timeline, **Recheck AI** with optional linked
   action (`POST .../issues/:claimId/reobservations`). Question, provider,
   and requested model are derived server-side from the issue lineage; the
   body carries at most an optional `interventionId`, so substitution is
   impossible by construction. One active recheck per issue (409 while
   QUEUED/RUNNING). The fresh answer lands as a new observation that **waits
   for review** — transcribe + verdict it exactly as in step 3 before any
   comparison counts.
9. **REPORT.** Read the Issue timeline (8 chronological stages, append-only)
   and the sealed evidence packet (`GET .../issues/:claimId/packet` →
   `{packet, digest, rendered}`; pin `generatedAt` to reproduce the digest).
   Outcome vocabulary is fixed: `OBSERVED_CORRECTION` / `OBSERVED_REGRESSION`
   / `OBSERVED_DIFFERENCE` / `NO_OBSERVED_CHANGE` / `INDETERMINATE` /
   `NOT_OBSERVED`, and `causalAttribution` is always UNKNOWN. Allowed:
   "AI answer changed afterward." / "Source was corrected." / "The incorrect
   representation was no longer observed in these later measurements."
10. **REPEAT.** Next justified action per issue is read off the timeline
    (no-baseline → RUN BASELINE; unreviewed claims → REVIEW CLAIMS; wrong
    issue + no source evidence → DIAGNOSE SOURCE; action recorded + no after
    observation → VERIFY SOURCE; source verified + no AI re-observation →
    RECHECK AI; re-observation complete + no judgment → REVIEW AFTER STATE;
    completed comparison → REPORT OUTCOME; no material issue → NO ACTION).
    Across 3 customers there is no cross-business queue: keep one browser tab
    per customer on its Overview/Issues, and use the per-business agent chat
    for attention questions inside each business.

## 6. Playbooks

- **A — Wrong fact + stale controlled source.** §5 steps 1–10 straight
  through. Fully supported.
- **B — Wrong AI + controlled sources already correct.** Legitimate outcome;
  do NOT force an intervention. Record nothing; report approved-truth-correct
  / known-controlled-sources-correct / provider-representation-incorrect /
  retrieval-cause-UNKNOWN. There is no `NO_CONTROLLABLE_SOURCE_FOUND`
  primitive — the weekly report prose carries this outcome until pilot
  volume proves a dedicated record type is needed.
- **C — Capability under-documented.** Prepare a narrow source improvement
  (text the customer approves), customer publishes or merges the PR,
  continue at §5 step 6. Never auto-publish; never auto-generate PRs.

## 7. Approval boundaries (human approves; agent never mutates)

The evidence agent (`POST .../agent/messages`, read-only handler in
`apps/api/src/agent.ts`) summarizes evidence, proposes next actions, drafts
fixes/reports, and points at packet downloads. It cannot edit facts, create
judgments, publish sources, merge PRs, mark outcomes, or claim causality —
write paths stay behind human clicks. Customer approvals required: facts
before first check; which shortlisted issues to act on; every source change
before publish; packet review call before delivery counts as delivered.

## 8. Deliverables (per pilot, per issue + weekly)

- Per issue: sealed V1 evidence packet (facts, observations with citations +
  digests, claims/judgments, candidate evidence locator + snippet,
  intervention + correction chain, verification + re-observation history,
  outcome sentences with causal-UNKNOWN disclaimer) + controlled-language
  rendering. Validates via `validatePacket` self-check before delivery.
- Weekly (manual assembly, Markdown/HTML export suffices — no reporting
  infrastructure): what we checked; problems found; actions taken; source
  verification; AI re-observations; current unresolved issues; next actions;
  explicit UNKNOWNs. No vanity KPIs; no universal accuracy score.

## 9. Pilot success criteria (behavioral, hypotheses)

- ≥3 buyer-relevant representation problems found.
- ≥1 actionable controlled-source issue.
- ≥1 source intervention verified.
- Customer returns/engages with weekly findings.
- Customer wants continuation or pays again.

## 10. Kill criteria

No actionable issues; customer ignores reports; customer does not value
corrections; interventions cannot be tied to controllable work; operator
workload destroys economics (§13).

## 11. Pricing hypothesis (do NOT encode as proven; no billing build)

Pilot: ~$750–$1,000 for first 4 weeks. Managed hypothesis after pilot:
~$1,000–$2,500/month. Success/kill decides; economics (§13) constrains.

## 12. What we explicitly do NOT promise

No rankings; no guaranteed AI inclusion/citation/recommendation/propagation;
no traffic growth; no pipeline/revenue attribution. We sell monitoring,
diagnosis, bounded action, verification, evidence. Never: "We fixed ChatGPT"
/ "We made Gemini update" / "This source change caused the model to change"
/ guarantees of AI rankings or representation correction. Causal attribution
remains UNKNOWN unless future evidence supports otherwise.

## 13. Operating economics (modelled estimates until pilot data exists)

Assumptions per customer: onboarding (facts + questions + source inventory)
3–5h once; baseline week 3–4h (15 checks + review + triage); steady week
2–4h (re-checks, 1–3 diagnoses, verification, weekly report ~1h, comms
~0.5h); remediation prep 1–3h per intervention month. Steady-state total
≈ **10–18 h/customer/month** (year-1 operator, no automation beyond current
read models; agent-labor time counted, not hidden).

| Price/mo | Gross $/operator-hour @10h | @18h |
|---|---|---|
| $750 | $75 | $42 |
| $1,000 | $100 | $56 |
| $1,500 | $150 | $83 |
| $2,500 | $250 | $139 |

Likely load: 3–5 customers per full-time operator at current workflow
(context-switching dominates past ~4). Biggest leverage opportunity, if
pilots confirm: bounded measurement-wave trigger (one action per
N-questions × M-models instead of N×M clicks) — P2, build only after
repeated-evidence bottleneck. Scheduling stays operator-triggered (P2, not
P0). Communication stays manual email/Slack; record the minutes.

## 14. Readiness and blockers (as of base)

- Product loop: runnable end-to-end on mock + real-HTTP source collection
  (dogfood V1: claim→judgment→issue→intervention→correction chain exercised;
  source verification and AI re-observation plumbing proven, outcome stages
  derived at read time).
- **COMMERCIAL VALIDATION BLOCKER:** no live provider configured —
  `NINE_ROUTER_*` unset, `127.0.0.1:20128` unreachable, `/api/providers`
  would report 9router disabled. Do not solve with more product features;
  solve with credentials + the bounded stability assay (4 questions × 8
  identical measurements × 1 model) before designing recurring measurement.
- No P0/P1 code gaps found: measurement wave, cross-business queue, weekly
  report assembly, and after-state review are all POSSIBLE_BUT_MANUAL with
  acceptable manual workarounds for 3 customers. Nothing in §5 requires new
  tables, schedulers, integrations, scores, or mutation authority.
- Concurrent work: no VeeB branch/PR found; only open PR is #34 (before/after
  copy clarification — this document does not touch those strings).

## 15. Vocabulary guard (binding on operator + report prose)

Responses describe what was observed, never why. The only outcome sentences
are the `LOOP_DISPLAY_COPY` set; `causalAttribution` is always UNKNOWN.
Scores do not exist; do not invent them.
