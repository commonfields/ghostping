# Evidence Protocol V1 repository assay

Baseline: `ca4f314610d99373944b0553f9d1001c413227f3` (`origin/main`, 2026-10-02, PR #10 merged). The worktree was clean at task start, and no commits followed the prompt baseline.

## Existing canonical representations

| Concept | Hosted (TypeScript / PostgreSQL) | Local (Rust / SQLite) |
| --- | --- | --- |
| AuthoritativeFact | `packages/domain` `AuthoritativeFact`; `authoritative_facts` (versioned, `supersedes_id`, `[valid_from, valid_until)`) | `src/integrity.rs` |
| Observation / raw evidence | `observations` + digest-deduplicated `raw_evidence` (stored as normalized JSON text), immutable by trigger | `src/observations.rs`: content-addressed raw files plus `ObservationEnvelope` |
| CandidateClaim | `candidate_claims` (manual only) | `src/integrity.rs` |
| HumanJudgment | `human_judgments` + `human_judgment_facts`, append-only `supersedes_id` chain, serialized per claim | `src/integrity.rs` |
| Issue | Derived (`deriveIssue`). Identity is the claim id, and no table exists. | Derived |
| CheckRun / worker contract | `check_runs` (atomic `FOR UPDATE SKIP LOCKED` claim, bounded retries); `openrecord-worker-{job,result}-v1` with shared Rust/TS fixtures | n/a |
| Provider metadata | `provider`, `requested_model`, `observed_model`, `retrieval_mode` columns | free-string `surface`, `provider`, `model` |
| 9Router | Pins the requested model, records `observed_model` only when returned, `retrieval_mode=unknown`, no invented citations, hashes wire bytes | same binary |

## Overloaded or ambiguous fields found

- `observations.provider` mixed three things: gateway (`9router`), upstream provider, and surface identity. `openrecord/surface-v1` now separates `kind`, `product`, `gateway`, and requested and observed provider and model.
- `retrieval_mode = 'unknown'` could not tell "unknown" from "not applicable". Knowledge states replace it in the protocol. The legacy column is kept for compatibility.
- Raw evidence stored `JSON.stringify(parsed)`, not the wire bytes. `raw_bytes_hex` is added additively to the worker result. PostgreSQL stores the bytes only after it checks them against the digest.
- Rust `ObservationEnvelope.surface` is a free string, and its provider/model fields cannot tell requested values from observed ones. It is retained as the local legacy record. Portable evidence uses `SurfaceIdentityV1`.
- The previous draft stored match classification and before/after signatures on `reobservations`. Those are derived summaries that could drift from the derivation rules. The final schema stores only the link.

## Duplication: removed vs retained

- **Retained:** hosted and local storage both model facts, claims, and judgments. They have different durable stores and deployment boundaries (a local-first CLI and hosted PostgreSQL). Merging them is a storage migration outside P0. Both converge on one portable representation, `packages/protocol`.
- **Retained by design:** a Rust reader of the protocol. Rust is a second, independent implementation, so cross-language agreement on every fixture is a real check. A shared parser would make it a tautology. The two implementations cannot drift without CI failing, because fixtures, expected results, and canonical vectors are generated once and checked by both.
- **Retained, kept mechanically in sync:** issue-state mapping (`issueStateFor` in protocol, `deriveIssueState` in domain). A protocol test asserts they agree on every verdict.
- **Removed:** handwritten JSON Schemas. They are now generated from Effect Schema, and a test fails on drift. Measurement comparison and outcome logic now exists only in `packages/protocol` (plus the Rust mirror). No copy exists in db, worker, or web.

## Immutability guarantees

Already present: triggers block `UPDATE` and `DELETE` on `observations`, `raw_evidence`, `observation_citations`, `human_judgments`, and `human_judgment_facts`. A digest collision with different content fails closed.

Added: append-only triggers on `interventions` (also blocking `TRUNCATE`), `intervention_issues`, and `reobservations`. Insert-time tenancy and lineage triggers. A unique linear correction chain. A CHECK that a `MOCK` surface is always stored as synthetic. Raw-byte digest verification.

## Migration constraints

- The runner re-applies every `.sql` file on each migrate, so `0003` is fully idempotent.
- Existing rows stay valid. New columns are nullable or defaulted. Legacy observations (no measurement context) export with their surface rebuilt from stored columns and `measurement_configuration=UNKNOWN`.
- Fact `status` is mutable in Hosted V1 (`SUPERSEDED` and `RETIRED`). Packets therefore rely on `valid_from` and `valid_until` for temporal semantics.

## Already implemented before this tranche (not duplicated)

Fact versioning, authority-conflict detection, raw-evidence immutability and deduplication, append-only judgments, the requested/observed model split, provider citations, 9Router fail-closed behavior, mock-only CI, and worker fixture compatibility.

## Smallest coherent P0

1. `packages/protocol`: Effect Schemas, canonical JSON and digest, signature and comparison, outcome, assembly, validation, renderer, and worker surface mappings.
2. Generated JSON Schemas and golden fixtures. A Rust reader re-derives every fixture.
3. Additive PostgreSQL: provenance columns, `interventions`, `intervention_issues`, `reobservations`.
4. `@openrecord/db` lineage query and `exportIssuePacket`.
5. The worker records `MeasurementContextV1`, exact bytes, and provider metadata.

Out of scope, as the brief directs: MCP, a public API, a hosted CLI export (P1), new providers, scraping, automatic extraction, scoring, and causal inference.
