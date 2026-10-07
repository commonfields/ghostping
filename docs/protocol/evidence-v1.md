# Evidence protocol V1

## Objects

| Schema id | Role | Notes |
| --- | --- | --- |
| `openrecord/fact-v1` | authority | Versioned. `supersedes_id`. Temporal applicability is `[valid_from, valid_until)`. `status` is the lifecycle status at export time. |
| `openrecord/surface-v1` | evidence context | See [surface-v1.md](surface-v1.md) |
| `openrecord/measurement-context-v1` | evidence context | Exact prompt plus measurement conditions |
| `openrecord/observation-v1` | evidence | Raw-evidence reference and digest, derived answer text, provider citations and metadata, `synthetic` |
| `openrecord/claim-v1` | interpretation | Manually selected span or transcription from one observation |
| `openrecord/judgment-v1` | interpretation | Verdict plus the exact fact versions used. Append-only `supersedes_id` chain. |
| `openrecord/issue-v1` | derived view | Identity is the candidate claim id. State derives from the head of the judgment chain. `type` is Knowledge (hosted V1 has no issue taxonomy, so `UNKNOWN`). |
| `openrecord/intervention-v1` | action | See [intervention-v1.md](intervention-v1.md) |
| `openrecord/reobservation-v1` | derived view over a stored link | See [reobservation-v1.md](reobservation-v1.md) |
| `openrecord/evidence-packet-v1` | portable lineage | One issue and everything relevant to it |

Every portable object carries `schema` and `schema_version`. Objects reference each other only by stable ids. Ids encode no mutable business properties. Hosted ids are UUIDs, and the packet id is `evidence-packet:<issue id>`.

## `openrecord/evidence-packet-v1`

| Field | Content |
| --- | --- |
| `business` | `{id, name}` |
| `issue` | The derived issue |
| `facts` | Every fact version referenced by any judgment, plus their supersession ancestors. Historical versions are never dropped. |
| `original_observation` | Includes the full measurement context |
| `claims`, `judgments` | The issue claim and its full judgment history, oldest first |
| `interventions` | Every intervention linked to the issue, including corrections |
| `reobservations` | Derived comparison views, oldest first |
| `reobservation_observations` | Same order as `reobservations` |
| `reobservation_claims`, `reobservation_judgments` | Claims on the later observations and their judgment history |
| `observed_outcome` | Outcome of the latest re-observation, or `NOT_OBSERVED` |
| `causal_attribution` | Always `UNKNOWN` |
| `explicit_unknowns` | `[{subject_id, field}]`, generated deterministically |
| `synthetic` | `true` if any observation is synthetic |
| `generated_at` | Export time (part of the digest) |
| `signatures` | Must be `[]` in V1. This field is reserved as the extension point for signing. |
| `packet_digest` | See below |

Raw bytes are referenced by digest and URI by default. `raw_evidence.embedded_bytes_base64` appears only when export is called with `embedRawEvidence: true`. Export fails closed if exact bytes are not stored. A reader without OpenRecord's database can see what was asked, on which surface, what the business asserted at that time, what the AI emitted, what a reviewer concluded, what an operator changed, what a later comparable measurement showed, and what is unknown.

## Canonical JSON

The rules are implemented identically in `packages/protocol/src/canonical.ts` and `src/evidence_protocol.rs`. Both are pinned by `fixtures/evidence-protocol-v1/vectors/canonical-json.json`.

- **Keys:** sorted by Unicode code point, which equals UTF-8 byte order. This is not JavaScript's UTF-16 default order.
- **Arrays:** order is preserved. Every protocol array is semantically ordered, and assembly sorts it deterministically (by `(created_at, id)`, facts by `(subject, predicate, version, id)`, interventions by `(performed_at, created_at, id)`).
- **Whitespace:** none.
- **Strings:** escaped as by ECMAScript `JSON.stringify`. Lone surrogates are rejected.
- **Numbers:** written in ECMAScript `Number::toString` form. `-0` becomes `0`. Non-finite numbers are rejected. Integer values beyond ±(2^53−1) are rejected because readers in other languages would disagree on their value.
- **Timestamps:** UTC RFC 3339 strings ending in `Z`, with seconds or exactly three fractional digits. Hosted export writes `toISOString()` (milliseconds).
- **IDs and digests:** written as stored. Digests are lowercase hex.
- **Null:** `null` is written as JSON `null`.
- **Optional fields:** an absent optional field (`undefined`) is omitted. An unknown value is an explicit `{"state":"UNKNOWN"}` object and is never omitted.

## Digest

`packet_digest = lowercase hex SHA-256(canonical UTF-8 bytes of the packet without its top-level packet_digest)`. `serializePacket(packet)` returns the canonical bytes of the sealed packet. For the same stored state and the same `generatedAt`, the bytes and digest are always the same. V1 provides hash integrity only. It makes no claim about identity or authenticity.

## Export and validation

- `exportEvidencePacket(input)` (protocol, pure): assembles every derived field and seals the packet.
- `exportIssuePacket({accountId, businessId, issueId, generatedAt, embedRawEvidence?})` (`@openrecord/db`): loads lineage in one `REPEATABLE READ` snapshot, scoped to account → business → issue. It maps the rows, exports, and validates its own output. Observations stored before this migration export with `measurement_configuration=UNKNOWN`, and their surface is rebuilt from stored columns only.
- `validatePacket(input)` (TypeScript) and `validate_packet_bytes` (Rust) fail closed, in this order:
  1. `UnsupportedSchemaVersion`: wrong `schema` or `schema_version`. This is checked before any other field is trusted.
  2. `SchemaViolation`: a missing or invalid field, an extra field, or non-empty `signatures`.
  3. `DigestMismatch`
  4. `CrossTenantReference`, `DanglingReference`, `DuplicateId`, or `InvalidCorrection`
  5. `MockObservationNotSynthetic`
  6. `DerivationMismatch`: the validator re-derives issue state, signatures, match, change, outcome, unknowns, `synthetic`, and ordering from the packet's own evidence, and the result must equal the packet byte for byte. A resealed packet that overclaims an outcome is rejected.

Validation never imports a packet into a database.

A developer CLI (`openrecord evidence export`) is deferred to P1. The Rust CLI is local-first and does not access hosted PostgreSQL. Adding that access would create a second persistence implementation.

## Controlled explanation

`renderEvidencePacket(packet)` is deterministic application code. It does not use an LLM. It writes short sentences, one fact per sentence, in active voice, with fixed terms and explicit unknowns. Example (PART 11 fixture, abridged):

```
SYNTHETIC DATA. This packet contains synthetic test evidence. It is not a production observation.
OpenRecord measured Acme fixture provider API, a direct provider API.
The question was "How much does Acme Starter cost?".
The AI response contained the claim "$29/month".
The approved monthly price for Acme Starter was "$39/month" in fact version 1.
A reviewer judged the claim CONTRADICTED.
The claim and the approved value conflict.
The AI response cited https://example.com/acme-review.
OpenRecord cannot prove that a citation caused the response.
An operator recorded SOURCE_UPDATED for https://acme.example/pricing at 2026-10-01T12:00:00.000Z.
...
After intervention intervention-pricing-page, an exactly matched re-observation changed from CONTRADICTED to SUPPORTED.
Causal attribution is UNKNOWN.
OpenRecord does not know whether any intervention caused a later response.
```

The renderer follows controlled-language practice. OpenRecord makes no ASD-STE100 compliance claim. The renderer output is a disposable view. The packet is the evidence.
