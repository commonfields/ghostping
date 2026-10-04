# Ghostping product remap V1

Date: 2026-10-04. Branch: `feat/product-remap-dogfood-v1`. Consolidated main: `cb36210` (PR #19 merged, #18 superseded).
Companion evidence: `docs/product/ghostping-dogfood-v1.md`. Roadmap: `docs/product/roadmap.md`.

## 1. Current product (one sentence)

CURRENT: Ghostping records what a business says is true, observes what AI answers and owned web sources say about it, and tracks the evidence of mismatch through human review.

## 2. Target product (one sentence)

TARGET: An AI Representation Integrity loop — know what AI tells customers about your company, trace important problems to evidence, correct what you control, and verify what changes afterward.

## 3. Coherence gaps

- The hosted loop (know→observe→diagnose→act→verify→re-observe→record) is one coherent idea; the repository is not: a full legacy GEO CLI, Tauri shell, and marketing site ship alongside it with zero shared runtime.
- ACT and RECORD OUTCOME had no product surface (interventions existed only as a DB table); fixed this mission by exposing them, not by adding automation.
- Candidate matches can coincide without semantic relation (boolean META tags); evidence transparency added instead of precision heuristics.
- Verdict: hosted product coherent; repository dual-product. No PRODUCT_COHERENCE_FAILURE for hosted.

## 4. Customer jobs

| Job | Status |
|---|---|
| Know what AI says about my company | EXISTS_AND_WORKS (mock + 9router plumbing proven; live surfaces need credentials) |
| Find important factual errors | EXISTS_AND_WORKS (claims + judgments + issues inbox) |
| Find stale owned representations | EXISTS_AND_WORKS (discovery candidates, real-HTTP proven) |
| Understand why AI may repeat stale info | EXISTS_BUT_WEAK (citations + source graph; retrieval path honestly UNKNOWN) |
| Correct a source I control | PARTIAL (intervention record added; execution stays manual, correctly) |
| Verify the source changed | EXISTS_AND_WORKS (re-observation via bindings; 304 reuse) |
| Recheck the same AI question | EXISTS_AND_WORKS (check-runs) |
| Determine whether AI representation changed afterward | EXISTS_BUT_WEAK (no before/after compare view; history tables suffice for now) |
| Buyer-facing positioning errors | EXISTS_BUT_WEAK (no positioning model; TEXT facts cover it crudely) |
| Monitor important buyer questions | EXISTS_AND_WORKS (worker poll loops) |
| Defensible evidence for a report | EXISTS_AND_WORKS (evidence packets, citations, append-only history) |

First-sale requirements: signup → company → facts → question → check → issue → intervention record → re-check, all demonstrated locally. Manual execution acceptable; automation explicitly out.

## 5. Subsystem map (classification)

- CORE_VALUE_LOOP: AuthoritativeFact, BuyerQuestion, CheckRun, Observation, CandidateClaim, HumanJudgment, Issues, SourceTarget/Binding (configured), Representation Graph evaluation, Discovery candidates, provider execution (mock/9router), evidence packets.
- PRODUCT_SUPPORT: Effect runtime/layers, Postgres + 11 migrations, auth/tenancy, API read models, worker durability (leases/frontier/304 reuse), React shell + design system.
- VALIDATION_ASSET: protocol fixtures + schemas, parity/contract tests, no-score/no-causality/no-publication guards, demo seed (5 companies).
- DISTRIBUTION_ASSET: none proven (no shareable artifact loop yet; evidence packets are the candidate).
- EXPERIMENTAL: agent foundations (CLI optimize loop), Jev assay (research-only by contract), GSC import (CLI-only).
- SUPPORTED_SEPARATE_PRODUCT: Rust CLI (release pipeline live), Tauri desktop (stale, excluded from workspaces).
- LEGACY: `audit-legacy/report-legacy/generate-legacy`, marketplace/plugins, TUI chat, Rust providers (superseded by TS), website placeholders.
- DELETE_CANDIDATE: website as-shipped (placeholder links), `agent-chat.tsx` mock UI (no backend), Rust audit engine for hosted purposes.
- UNKNOWN: Truth Projection repository-manifest mode (works, undogfooded), Truth Delivery (name exists, scope unclear — freeze).

Dispositions: keep loop + support; freeze experimental/delivery/Tauri-expansion/CLI-expansion; delete website placeholders or the site; leave CLI/Tauri supported separately.

## 6. Tech vs moat (explicit)

- Effect architecture: technically good, indirectly valuable, moat none.
- Crawler/safeFetch: technically difficult, valuable, moat low (reproducible; history could compound).
- Evidence model (append-only, UNKNOWN-preserving, no-causality): technically good, valuable for trust, moat low alone.
- Nothing receives moat credit for complexity.

## 7. Dengso scores (0–3; winner must not win on totals with Moat/Risk at 0)

Framings: A GEO visibility monitor; B AI factual accuracy checker; C AI Representation Integrity issue tracker; D intervention→verification closed loop; E agency audit/remediation workflow.

| Dim | A | B | C | D | E |
|---|---|---|---|---|---|
| Market | 3 | 2 | 2 | 1 | 2 |
| Feasibility | 3 | 2 | 2 | 2 | 1 |
| Profitability | 1 | 2 | 2 | 2 | 2 |
| Monetisation | 2 | 1 | 2 | 1 | 2 |
| Promotability | 2 | 1 | 1 | 1 | 2 |
| Competition | 0 | 1 | 1 | 2 | 0 |
| Risk | 1 | 1 | 1 | 1 | 1 |
| Moat | 0 | 0 | 0 | 1 | 0 |
| Passion | 2 | 2 | 2 | 2 | 1 |

- A is disqualified on Competition (Profound/Scrunch/Peec + suite incumbents) and Moat 0 despite the highest total — totals did not decide.
- E is disqualified: multi-brand/agency UI, billing, and portfolio workflows are absent and forbidden this mission;ahm distribution story is unproven.
- Winner: D (with C as its present-tense description). D is the only framing with a non-zero moat hypothesis and a falsifiable corpus test. Strongest assumption: customers will record interventions and return for re-observation. Fastest falsification: 3–5 companies × 20–30 problems (Phase 49 target).

## 8. Segments

- B2B SaaS ($1–50M, founder/marketing-led, AI-answerable buying questions): buyer = founder/head of marketing; trigger = wrong AI answer seen in a deal or review; frequency weekly; workaround = manual prompting. Selected ICP — lowest integration burden, fastest comprehension, plausible $99–599/mo.
- Agency: scalable in theory, but requires portfolio UI/billing/teams (all absent) and proof agencies pay for remediation evidence rather than reports. Not selected; revisit only with a design partner.
- Enterprise brand: severity highest, but needs SOC2/compliance (Profound certified; we are not), 3–6-week sales, custom everything. Not first.
- Budget hypothesis: $99–299/mo self-serve SaaS; $599+ for audit-led pilot with evidence deliverable.

## 9. Economics

- Value ≈ hours not spent manually re-prompting × problems/month × severity (wrong pricing/capability in a deal = high).
- Provider cost per check is cents (mock) to ~$0.05–0.30 (live multi-provider); crawling is bandwidth-trivial at owned-site scale. Gross margin supports SaaS pricing if check volume stays bounded (worker budgets already bound it).
- $10k MRR ≈ 100×$99 or 34×$299 or 17×$599; $50k ≈ 5× those; $100k ≈ 10×. Conclusion: reachable only with the SaaS ICP at volume or agency/enterprise later — first sale matters more than the model now.
- Paid pilot hypothesis: $750 one-time, 4 weeks, 1 brand, ≤15 buyer questions, representation audit + remediation evidence + one re-observation cycle, manually operated.

## 10. Competition (summary; detail in research notes)

Profound (enterprise standard, $99+), Scrunch (closed-loop edge delivery, acquired by Sitecore), Bluefish (Brand Vault source-of-truth, $150k+ ACV), Goodie (mid-market action layer), Peec (lightweight truth + agency ergonomics, ~$95+), Adobe (suite bundling), plus Otterly/AthenaHQ/ suite add-ons. Table stakes: monitoring dashboards, citation tracking, recommendations, reports. Differentiated (ours): append-only evidence with UNKNOWN preservation, human-judgment separation, candidate-not-verdict discovery semantics, no-score honesty. 60-day-copy verdict: everything except the Vault-grade truth pipeline, edge delivery, and scaled drift controls is reproducible — our edge is evidence discipline, not features.

## 11. Platform risk

AI APIs/pricing/terms, model-behavior drift, citation availability, scraping tolerance, robots compliance. Mitigations: mock-first plumbing, pinned single live model (9router), bounded budgets, robots-strict crawling, provider-independent stored evidence (answers+citations+digests survive provider churn). Separated: provider-dependent measurement vs provider-independent accumulated evidence (the latter is the durable asset).

## 12. Moat: intervention→propagation corpus

Candidates considered: corpus, longitudinal graph, propagation-time data, workflow lock-in, truth integration, provenance archive, distribution effects, collection difficulty, eval corpus. Selected hypothesis: intervention→propagation corpus. Stress test: generated naturally (partially — only with the new record surface + re-observation discipline); customer value before scale (yes — the loop itself); improves with history (unproven); hard to reproduce history (true per-customer, but every customer starts at zero — cold start is the weak point); cross-provider durable (yes — chronology, not model internals); no fake causality (enforced by outcome semantics); economical (yes). Falsification: pilot corpus test; kill if customers don't act or return.

## 13. Chosen loop

KNOW (facts) → OBSERVE (checks + discovery) → DIAGNOSE (claims/judgments/issues + candidate evidence) → ACT (manual fix, recorded) → VERIFY SOURCE (bindings/discovery) → RE-OBSERVE AI (same question) → RECORD OUTCOME (chronology states, never causal). Gaps closed this mission: record-action surface, candidate evidence transparency. Remaining gap: no before/after compare view (deferred — history suffices).

## 14. Feature dispositions

Kept: everything in the loop table §4 marked EXISTS. Frozen: agent expansion, Jev, new providers, desktop parity, CLI expansion, crawler breadth, browser crawling, review connectors, scoring, Truth Delivery expansion. Deleted: website placeholders (site either fixed or removed — left standing pending owner call), agent-chat mock. Supported separately: CLI, Tauri (regression/build only).

## 15. Pilot readiness

ICP: B2B SaaS founder-led. Offer: $750, 1 brand, ≤15 questions, audit + remediation evidence + one re-observation, 4 weeks, manually operated. Success: ≥3 material problems found, ≥1 intervention recorded + verified, customer returns for re-observation. Kill: no action taken, no return, or no willingness to pay. Corpus target: 3–5 companies, 20–30 problems. Channel: founder communities + design-partner outreach (no paid acquisition yet). Gate result: see §16.

## 16. Commercial discipline

Sellable loop demonstrable now (locally, mock). Time-to-first-sale: pilot can be sold before automation exists. Two-month rule applies from first outreach. Pivot/kill triggers: no severe problem found across pilots, no corrective action taken, no payment, no return usage, provider instability destroys measurement, corpus shows no learning value, CAC incompatible with ARPU.

## 17. Decision input

READY_FOR_PILOT requires the gate in §15; the blocker ledger is: (a) live-AI validation blocked on credentials (plumbing proven on mock + real-HTTP discovery, value unproven on live surfaces); (b) the two loop-surface builds in this branch must land green. Moat remains a hypothesis until the corpus test runs — pilots are the test, not the reward.
