#!/usr/bin/env python3
"""Generate constructed adversarial assay corpora (deterministic, seeded).

Every row: label_origin = synthetic_constructed. Engineering development
only — never real-world accuracy. Output is checked in; regenerate with:
  python3 research/jev-assay/datasets/generate.py

Task A: 240 cases, 60 per label (20 categories x 12 = 3 seeds x 4 rotations).
Task B: 200 cases, 50 per label (8 subcategories x 25 = seeds x rotations).
"""
import json
import random
import sys
from pathlib import Path

OUT = Path(__file__).parent
RNG = random.Random(20260929)

NAMES = ["Ghostping", "Acme Analytics", "Northwind", "Blue Canoe", "Hexagonal", "Quartz Labs"]
CITIES = ["Austin", "Berlin", "Osaka", "Lagos", "Toronto", "Lisbon"]
PRODUCTS = ["visibility tracker", "invoice tool", "edge runtime", "notebook app", "dns monitor"]


def rot(pool, i, k=0):
    return pool[(i + k) % len(pool)]


# Each seed: (claim_template, facts_template_list, category).
# Placeholders {N},{C},{P},{D},{X} rotate CONSISTENTLY across claim+facts.
# {W} rotates INDEPENDENTLY (wrong value) — claim uses {W}, facts use {N}.
A_SEEDS = {
    "SUPPORTED": [
        ("exact agreement", "{N} costs ${P} per month.",
         ["{N} costs ${P} per month."], 12),
        ("semantic paraphrase", "{N} charges ${P} monthly for its starter plan.",
         ["The starter plan of {N} is priced at ${P}/mo."], 12),
        ("numeric formatting", "{N} has {X} active users.",
         ["{N} reports {X} active users."], 12),
        ("currency differences", "{N} costs ${P} in the US.",
         ["{N} costs USD {P} for US customers."], 12),
        ("unicode", "{N} opened an office in {C} — café Münchén 日本.",
         ["{N} opened an office in {C} — café Münchén 日本."], 12),
    ],
    "CONTRADICTED": [
        ("negation", "{N} does not offer a free plan.",
         ["{N} offers a free plan for all users."], 12),
        ("wrong price", "{N} costs ${W} per month.",
         ["{N} costs ${P} per month."], 12),
        ("wrong percentage", "{N} grew {W}% last quarter.",
         ["{N} grew {P}% last quarter."], 12),
        ("wrong date", "{N} launched v3 on {D}.",
         ["{N} launched v3 in March 2024, not {D}."], 12),
        ("wrong location", "{N} is headquartered in {C}.",
         ["{N} is headquartered in Reykjavik."], 12),
    ],
    "PARTIAL": [
        ("partial agreement", "{N} costs ${P} per month and supports SSO.",
         ["{N} costs ${P} per month."], 12),
        ("subset error", "{N} supports {C} and {D}.",
         ["{N} supports {C}."], 12),
        ("superset error", "{N} supports {C}.",
         ["{N} supports {C} and {D}."], 12),
        ("multi-fact one relevant", "{N} costs ${P} per month.",
         ["{N} was founded in 2021.", "{N} costs ${P} per month.", "{N} has a blog."], 12),
        ("outdated mixed", "{N} v3 costs ${P} and includes SSO.",
         ["{N} v3 costs ${P}.", "SSO shipped in {N} v2."], 12),
    ],
    "INSUFFICIENT_EVIDENCE": [
        ("unsupported plausible", "{N} will launch {C} region next spring.",
         ["{N} operates in {D} today."], 12),
        ("irrelevant evidence", "{N} costs ${P} per month.",
         ["The Eiffel Tower is 330 metres tall."], 12),
        ("near-name collision", "{N} costs ${P} per month.",
         ["Ghostpong (a different product) costs $9 per month."], 12),
        ("ambiguous pronoun", "It costs ${P} per month.",
         ["{N} and {C} Corp both sell tools. They updated pricing."], 12),
        ("long irrelevant context", "{N} costs ${P} per month.",
         [" ".join(["lorem ipsum dolor sit amet"] * 40)], 12),
    ],
}

B_SEEDS = {
    "SUPPORTS": [
        ("exact entailment", "{N} costs ${P} per month.",
         "According to the pricing page, {N} costs ${P} per month, billed annually.", 25),
        ("paraphrase entailment", "{N} has an office in {C}.",
         "{N} expanded its footprint with a new {C} location this year.", 25),
    ],
    "CONTRADICTS": [
        ("direct conflict", "{N} has no free plan.",
         "Yes — {N} offers a generous free plan with no credit card required.", 25),
        ("numeric conflict", "{N} uptime is {P}%.",
         "Status page: {N} uptime this quarter is 97.2%.", 25),
    ],
    "AMBIGUOUS": [
        ("ambiguous pronoun", "It supports SSO.",
         "{N} and Okta are compared. It supports SSO, the other does SAML.", 25),
        ("partial overlap", "{N} costs ${P} and includes SSO.",
         "The review confirms {N} costs ${P}; SSO support is not mentioned.", 25),
    ],
    "INSUFFICIENT": [
        ("off-topic excerpt", "{N} costs ${P} per month.",
         "Sourdough starters double in size roughly every 12 hours at room temperature.", 25),
        ("too-short excerpt", "{N} launched in {D} with {X} users.",
         "{N} exists.", 25),
    ],
}


def fill(template, i, wrong=False):
    n, c, p, d, x = i, i + 1, 20 + (i * 7) % 180, 1 + (i % 27), 1000 + (i * 37) % 9000
    w = (p + 13) % 180 + 20
    return template.format(
        N=rot(NAMES, n), C=rot(CITIES, c), P=p, D=f"2026-{(d % 12) + 1:02d}-{(d % 27) + 1:02d}",
        X=f"{x:,}", W=w,
    )


# Frozen per-question binary truth (mirrors question-set-v1; see PROTOCOL.md).
# Derived deterministically from the multiclass label — labels unchanged,
# so case IDs and the frozen split stay equivalent. No dataset v2 needed.
TRUTH_A = {
    "SUPPORTED": {"fully_supported": True, "contains_contradiction": False,
                  "partially_supported": False, "enough_evidence": True},
    "CONTRADICTED": {"fully_supported": False, "contains_contradiction": True,
                     "partially_supported": False, "enough_evidence": True},
    "PARTIAL": {"fully_supported": False, "contains_contradiction": False,
                "partially_supported": True, "enough_evidence": True},
    "INSUFFICIENT_EVIDENCE": {"fully_supported": False, "contains_contradiction": False,
                              "partially_supported": False, "enough_evidence": False},
}
TRUTH_B = {
    "SUPPORTS": {"source_entails_claim": True, "source_conflicts_with_claim": False,
                 "source_has_enough_information": True},
    "CONTRADICTS": {"source_entails_claim": False, "source_conflicts_with_claim": True,
                    "source_has_enough_information": True},
    "AMBIGUOUS": None,  # excluded from per-question calibration, counted separately
    "INSUFFICIENT": {"source_entails_claim": False, "source_conflicts_with_claim": False,
                     "source_has_enough_information": False},
}


def build(seeds, task, per_label):
    truth = TRUTH_A if task == "fact_relationship" else TRUTH_B
    cases, idx = [], 0
    for label, items in seeds.items():
        made = 0
        for category, claim_t, facts_t, count in items:
            for r in range(count):
                i = idx
                claim = fill(claim_t, i)
                facts = [fill(f, i) for f in facts_t] if isinstance(facts_t, list) else [fill(facts_t, i)]
                cases.append({
                    "case_id": f"{task}-{idx:04d}",
                    "task": task,
                    "claim": claim,
                    "evidence": facts if task == "fact_relationship" else facts[0],
                    "label": label,
                    "label_origin": "synthetic_constructed",
                    "category": category,
                    "noul_truth": truth[label],
                })
                idx += 1
                made += 1
        assert made == per_label, (label, made, per_label)
    return cases


def main():
    a = build(A_SEEDS, "fact_relationship", 60)
    b = build(B_SEEDS, "citation_support", 50)
    assert len(a) == 240, len(a)
    assert len(b) == 200, len(b)
    (OUT / "task_a_synthetic.jsonl").write_text("\n".join(json.dumps(c) for c in a) + "\n")
    (OUT / "task_b_synthetic.jsonl").write_text("\n".join(json.dumps(c) for c in b) + "\n")
    # Real-evidence labeling format: schema present, zero human labels.
    (OUT / "task_b_real.jsonl").write_text(
        "# One JSON object per line. human_label MUST be filled by a human adjudicator.\n"
        "# Never auto-populate human_label. Never use an LLM to create human labels.\n"
    )
    print(f"wrote {len(a)} task-A and {len(b)} task-B synthetic cases")


if __name__ == "__main__":
    sys.exit(main())
