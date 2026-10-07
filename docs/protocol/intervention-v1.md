# Intervention V1

An intervention records something an operator changed, or tried to change, after an issue was found. It records **chronology, not causality**. A later re-observation that differs never implies that the intervention caused the difference.

## `openrecord/intervention-v1`

| Field | Meaning |
| --- | --- |
| `id`, `business_id` | Stable identity and tenant |
| `issue_ids` | Issues this action addresses (≥ 1) |
| `type` | `SOURCE_UPDATED`, `SOURCE_PUBLISHED`, `THIRD_PARTY_CORRECTION_REQUESTED`, `KNOWLEDGE_BASE_UPDATED`, `STRUCTURED_DATA_UPDATED`, `OTHER` |
| `target` | What was changed, e.g. a URL |
| `performed_at` | When the action happened |
| `actor` | `HUMAN`, `AGENT`, `SYSTEM`, or `UNKNOWN` |
| `actor_id` | Knowledge. `UNKNOWN` unless identity is proven. Never fabricated. |
| `notes` | Optional operator notes |
| `evidence_before_digest`, `evidence_after_digest` | Knowledge (SHA-256). `UNKNOWN` unless OpenRecord holds real content digests. V1 never scrapes to fill them. |
| `supersedes_id`, `correction_reason` | Both set only on a correcting record |
| `created_at` | When OpenRecord recorded the event |

## Append-only enforcement (PostgreSQL)

- `interventions` and `intervention_issues` have `BEFORE UPDATE OR DELETE` triggers that raise `<table> is append-only`. `TRUNCATE interventions` is also rejected.
- `CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL))`. Digest columns must be NULL or 64 lowercase hex characters.
- An insert trigger rejects a supersession that crosses businesses, and an issue link to another business's claim.
- A unique partial index on `supersedes_id` keeps correction chains linear. When concurrent corrections target the same record, exactly one succeeds.

The repository exposes only `append` and `listByIssue`. It has no update or delete method.

## Corrections

To correct a recorded intervention, append a new record with `supersedes_id = <old id>` and a `correction_reason`. The new record must reference exactly the same issues as the record it supersedes. This keeps every packet's lineage closed. The old record never changes, and both records appear in packets. Storage keeps a missing actor identity or a missing digest as NULL, and the protocol exports it as `UNKNOWN`. Explicit unknowns list it.
