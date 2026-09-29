# Real-business pilot — operator template pack (non-sensitive)

This pack contains **no real business data**. Every value is a placeholder
marked `EXAMPLE`. It exists so a business operator can see exactly what
inputs a pilot requires, without Ghostping inventing a business.

## Required operator inputs (all missing until supplied)

```text
1. business identifier/name + who may speak for it
2. 20–50 business-approved facts (facts.template.csv)
3. 20–30 real buyer-intent groups (intents.template.json)
4. target geography/language
5. 2–3 AI surfaces/providers + authorized credentials
6. explicit maximum paid-request budget
7. human reviewer identity
```

Facts must be approved by someone authorized to speak for the business.
Do NOT infer authority from the public website, search results, AI
answers, directories, competitors, an LLM, or operator assumptions.

## Protocol

1. Copy `pilot-manifest.template.json`, fill it, freeze it **before**
   collecting the first AI answer. Frozen afterwards: fact set, intents,
   variants, surfaces, config, sampling plan, rubric, budget.
2. Enter facts (`load-facts.sh` shells `facts add` per CSV row).
   Resolve every `FACT_AUTHORITY_CONFLICT` before using facts as ground truth.
3. Collect observations with existing Ghostping paths (mock first, then
   authorized providers only). Label API samples `CONTROLLED_API_SAMPLE`
   in notes — never "real users".
4. Manually create claims (`claims add`), prioritizing buyer-material
   propositions. No automatic extraction, ever.
5. A genuine human reviewer adjudicates (`judgments add`). Never fill
   labels from a model. Adjudication not available → `HUMAN_ADJUDICATION =
   INCOMPLETE`, stop before metrics.
6. Annotate materiality/traceability/actionability per finding
   (`annotations.template.jsonl` format, pilot-local files only).
7. Optional: 1–3 operator-approved interventions, matched-panel
   re-observation, then report. Before/after is association, not proof of
   causation unless the experiment supports it.

## Materiality rubric v1 (frozen for the pilot)

MATERIAL when a reasonable prospective customer could plausibly decide
differently because of the discrepancy (wrong price, availability,
service area, feature, eligibility, cancellation rule, current offer).
NON_MATERIAL for wording/style/abbreviation differences. UNCERTAIN when
undecidable — never force a materiality call. No monetary-loss inference.

## Data handling

Real-business pilot data stays local (e.g. `.ghostping/pilots/<id>/`,
which is Git-ignored). Never commit customer facts, raw responses with
sensitive data, keys, unpublished pricing, PII, or private reviewer notes.

## Decision gates (heuristics, not laws)

SIGNAL: ≥5 material discrepancies (or ≥10% of reviewed factual claims)
  AND ≥50% traceable AND ≥50% actionable AND operator confirms ≥1 worth fixing.
WEAK: errors trivial, untraceable, unactionable, or operator indifferent.
KILL/REFRAME: <2 material discrepancies in a broad sample, consistently
  untraceable+unactionable, or operator says it would not justify monitoring.
One business is signal only — never market validation, never PRODUCT VALIDATED.
