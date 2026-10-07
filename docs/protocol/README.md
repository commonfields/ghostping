# OpenRecord Evidence Protocol

OpenRecord's emerging core is **evidence-backed AI representation integrity**: measuring how AI systems represent an organization, and keeping every conclusion tied to the evidence behind it.

The central law:

> **Observation is not interpretation. Interpretation is not authority. Correlation is not causality. Unknown is not false.**

## Lineage

```
authoritative fact → observation → candidate claim → judgment → issue
    → intervention → matched re-observation → evidence packet
```

Every field in the protocol is exactly one of: **evidence** (raw response bytes, observation), **authority** (fact versions), **interpretation** (claims, judgments), **action** (interventions), or a **derived view** (issue state, match classification, outcome, unknowns). No representation does two of these jobs.

## Where things live

| What | Where |
| --- | --- |
| Canonical schemas and rules (Effect Schema, TypeScript) | [`packages/protocol/src`](../../packages/protocol/src) |
| Generated JSON Schemas (do not edit) | [`schemas/openrecord`](../../schemas/openrecord) |
| Golden cross-language fixtures (do not edit) | [`fixtures/evidence-protocol-v1`](../../fixtures/evidence-protocol-v1) |
| Rust reader (independent re-derivation) | [`src/evidence_protocol.rs`](../../src/evidence_protocol.rs) |
| Hosted persistence + packet export | [`packages/db/src/evidence.ts`](../../packages/db/src/evidence.ts), migration `0003_evidence_protocol_v1.sql` |

Regenerate artifacts with `pnpm --filter @openrecord/protocol schemas` and `pnpm --filter @openrecord/protocol fixtures`. Tests fail if the committed files drift from the generators.

## Documents

- [surface-v1.md](surface-v1.md): surface identity, measurement context, UNKNOWN states, and current 9Router and mock mappings.
- [evidence-v1.md](evidence-v1.md): protocol objects, the evidence packet, canonical JSON, digests, validation, and the text renderer.
- [intervention-v1.md](intervention-v1.md): append-only interventions and corrections.
- [reobservation-v1.md](reobservation-v1.md): measurement signatures, match classification, and outcomes.
- [versioning.md](versioning.md): compatibility rules.

## Not in V1

V1 has no MCP server, public developer API, hosted-packet CLI, signing, automatic claim extraction, LLM judging, scores, or causal inference. Future consumers must call this protocol instead of reimplementing it.
