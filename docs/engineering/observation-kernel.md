# Observation Kernel — architecture note (design only, not implemented)

This note defines the next-layer contracts for OpenRecord's future
Observation Kernel. It specifies shapes and invariants only. Per scope,
no adapters are implemented here: no Search Console, no grounded-search
adapters, no crawler-log ingestion, no referral analytics, no claim
extraction, no visibility scoring, no content optimization.

## Why

Today an "audit" is a bag of parsed rows plus derived rates computed at
read time. That is sufficient for one engine, but a kernel that will one
day ingest eligibility checks, crawler visits, referrals, and experiments
needs a single envelope in which **immutable observations** and
**derived views** cannot be confused.

## ObservationEnvelope

Every observation collected by any adapter is stored as:

| Field | Type | Notes |
|---|---|---|
| `observation_id` | string (ULID/UUIDv7) | Primary key, time-ordered |
| `project_id` | string | Canonical project identity (see below) |
| `observation_type` | enum | One of the payload classes |
| `surface` | enum | e.g. `chatgpt`, `claude`, `perplexity`, `grok`, `gemini`, `ollama:<model>`, `origin-server`, `referrer`, `search-console` |
| `collected_at` | RFC 3339 | Collection timestamp, not inference time |
| `collector_version` | string | Adapter name + version, e.g. `openrecord-audit/0.4.0` |
| `schema_version` | integer | Envelope schema version; readers must tolerate newer minor versions by ignoring unknown fields, never by guessing |
| `provider` / `model` | optional strings | Where applicable; `null` for first-party surfaces |
| `retrieval_mode` | optional enum | `UNKNOWN` \| `GROUNDED` \| `PARAMETRIC` — how the underlying answer was produced, when known |
| `region` / `language` | optional strings | Where known; `null` otherwise (never invented) |
| `prompt_group` / `prompt_variant` | optional strings | Which prompt family and sampling variant produced this |
| `url_digest` | optional string | SHA-256 of a cited/fetched URL where applicable |
| `execution` | struct | `{ planned, succeeded, failed }` counts for the collection batch (already established by the evidence engine) |
| `failure_class` | optional enum | `NONE` \| `TIMEOUT` \| `AUTH` \| `RATE_LIMIT` \| `MALFORMED_RESPONSE` \| `TRANSPORT` \| `UNKNOWN` |
| `latency_ms` | optional integer | Measured, never estimated |
| `cost_usd` | optional number | When available from the provider; `null` otherwise |
| `raw_digest` | string | SHA-256 of the raw evidence bytes |
| `raw_ref` | string | Pointer to the stored raw bytes (content-addressed) |
| `payload` | typed object | Exactly one payload class, validated against its schema |

## Payload classes (proposed)

- `EligibilityObservation` — can this surface even see the project (index/crawl/robots/llms.txt checks)? Views: eligibility rate.
- `GenerativeImpressionObservation` — a model produced an answer in response to a prompt; records mention/recommend spans, not verdicts.
- `GroundedAnswerObservation` — answer with provider-native citations preserved verbatim (URLs, titles, offsets where the API supplies them).
- `ParametricAnswerObservation` — answer with no citations; memory-only output.
- `CrawlerVisitObservation` — first-party log evidence a bot fetched a URL (timestamp, path, agent, status).
- `ReferralObservation` — first-party evidence of inbound AI-referred traffic (referrer, landing path, session markers available).
- `IntegrityObservation` — something about the collection was off: partial batch, clock skew, schema mismatch, adapter error. Always emitted alongside — never instead of — the affected observations.
- `InterventionObservation` — OpenRecord itself did something (published content, changed prompts, checkpoint stamped). Controlled-experiment evidence; distinct class from platform measurements.
- `ClaimObservation` — a verifiable factual claim extracted about the project (text span + source span). Extraction is a later slice; the class exists so claims are attributable from day one.

## Invariants (normative)

1. **UNKNOWN is a real state.** `retrieval_mode`, `region`, `language`,
   `cost_usd` and friends are nullable enums/values with an explicit
   unknown variant — never blank strings, zeros, or guesses.
2. **No invented citations.** A `GroundedAnswerObservation` contains only
   citations the provider emitted. The kernel never synthesizes, completes,
   or "helpfully" normalizes a citation into existence.
3. **Grounded and parametric observations are never silently pooled.**
   Any view spanning both must label the mixture and report per-mode
   counts. This is today's mock/real and citation/response distinction,
   generalized.
4. **Provider-native source metadata is retained where available.**
   Citation offsets, titles, `is_project_domain` judgments, and raw
   payloads are stored, not just derived booleans — so judgment code can
   be fixed later without re-collecting.
5. **Derived mention/citation/recommendation rates are views, not stored
   facts.** Rates are computed from observations at read time (as
   `get_audit_summary` already does). Persisted summaries are caches with
   a schema version, invalidated when scoring code changes.
6. **An observation remains reproducible after scoring/classification
   algorithms change.** `raw_ref` + `raw_digest` pin the evidence;
   re-running a new classifier over old bytes must yield the same
   observation with a new derived view — never a mutated observation.
7. **First-party platform measurements and OpenRecord-controlled
   experiments are different evidence classes.** `CrawlerVisit`/`Referral`
   (the world acting) vs `Intervention` (us acting). Comparing them is
   legitimate; conflating them is not.
8. **No universal "AI visibility score" is part of the core schema.**
   Scores are product views built atop observations, versioned and
   labeled, with their formula attached. The kernel stores no score.

## What already exists (mapping to current code)

- `planned/succeeded/failed` batch accounting: `AuditSummary`
  (`audit_storage.rs`) + `completed_with_errors` status.
- Failure preservation without secret leakage: `audit_errors` +
  `sanitize_error` (`audit_engine.rs`).
- Immutable raw evidence with derived views: `audit_results.response_text`
  stored verbatim; rates recomputed in `get_audit_summary`, including live
  recomputation for legacy rows.
- Provenance labeling: `uses_mock_provider()`, mock TEST DATA banners,
  `TrackSummary.source = "legacy-tracker"`.
- Additive, version-tolerant storage: `audit_errors` table migration,
  `#[serde(default)]` summary fields.

## What is explicitly missing (later slices)

Adapters for every payload class above; the envelope table itself;
content-addressed raw store; schema-version negotiation; trend views over
heterogeneous observations; any score. None of that is built here.
