# $750 pilot runbook (DRAFT)

Grounds: `product-remap-v1.md` §15, `roadmap.md` milestone 2, `ghostping-dogfood-v1.md`. One brand, ≤15 buyer questions, 4 weeks, manually operated. Per-brand deploy: own API/web/worker + Postgres, `NINE_ROUTER_API_KEY` in env (pinned live model; mock fallback forbidden for customer evidence).

## Weekly wave (facts → checks → judgments → interventions → verify → re-observe → exportEvidencePacket)

- **W1 — KNOW + OBSERVE.** Intake facts (implementation-verified assertions only), ≤15 buyer questions, controlled-source inventory (CONTROLLED / PARTIALLY_CONTROLLED / EXTERNAL). Run checks; judgment review; open issues.
- **W2 — DIAGNOSE + ACT.** Trace issues to evidence; customer picks fixes on sources they control. Record interventions (append-only; execution stays manual).
- **W3 — VERIFY + RE-OBSERVE.** Re-check bindings/discovery for source change; re-run same questions with preserved measurement context.
- **W4 — RECORD + EXPORT.** Record outcomes (chronology states, never causal). `exportEvidencePacket` + `renderEvidencePacket`; review call.

## Operator checklist

- [ ] Env: `NINE_ROUTER_API_KEY`, `NINE_ROUTER_MODEL` set; worker budgets bounded
- [ ] Facts approved by customer before first check
- [ ] Every issue has claim → judgment → citation trail
- [ ] No mock output presented as live evidence; UNKNOWN preserved
- [ ] Intervention rows reference issue + actual change made
- [ ] Packet validates (`validatePacket` self-check) before delivery

## Evidence deliverable contents

Validated packet per issue: facts, observations (answers + citations + digests), claims/judgments, candidate evidence (locator + snippet), intervention + correction chain, verification and re-observation history, outcome sentences with causal-UNKNOWN disclaimer.

## Gates

Success: ≥3 material problems, ≥1 intervention recorded + verified, customer returns for re-observation. Kill: no action taken, no return, or no willingness to pay. Corpus target: 3–5 companies × 20–30 problems.
