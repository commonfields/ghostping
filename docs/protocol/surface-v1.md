# Surface and measurement V1

An answer such as "Acme costs $29" counts as measurement evidence only when Ghostping can also say where it came from, what was asked, and under which conditions. Different surfaces are different instruments. A consumer chat UI, a direct API, a router API, a search-grounded API, a local model, and a fixture never collapse into one another.

## Knowledge states

A hidden or ambiguous dimension uses exactly one of these forms:

```json
{ "state": "KNOWN", "value": "..." }
{ "state": "UNKNOWN" }
{ "state": "NOT_APPLICABLE" }
```

`UNKNOWN` never means false, disabled, anonymous, default, or unchanged. A value is `KNOWN` only when the surface returned it or Ghostping set it directly. Ghostping never derives a value from answer content. For example, it does not conclude "probably used search."

## `ghostping/surface-v1`

| Field | Type | Meaning |
| --- | --- | --- |
| `schema`, `schema_version` | `"ghostping/surface-v1"`, `1` | Version identity |
| `kind` | closed enum | `CONSUMER_UI`, `DIRECT_API`, `ROUTER_API`, `SEARCH_GROUNDED_API`, `LOCAL_MODEL`, `MOCK` |
| `product` | string | Product measured, e.g. `9Router` |
| `adapter`, `adapter_version` | string | The Ghostping code that collected the observation |
| `gateway` | Knowledge | Router or gateway in the path |
| `requested_provider`, `requested_model` | Knowledge | What Ghostping asked for |
| `observed_provider`, `observed_model` | Knowledge | What the response proved |
| `account_state`, `subscription_tier` | Knowledge | Account conditions |
| `locale`, `region` | Knowledge | Locale and region conditions |
| `search_mode` | Knowledge | Retrieval or search state |
| `personalization_state` | Knowledge | Personalization or memory state |
| `metadata_visibility` | `FULL` \| `PARTIAL` \| `NONE` \| `UNKNOWN` | How much metadata the surface exposes |

An adapter sets `kind` from what it actually calls. An API adapter cannot emit `CONSUMER_UI`.

## `ghostping/measurement-context-v1`

| Field | Meaning |
| --- | --- |
| `question` | Exact prompt as sent. Ghostping does not trim it or normalize its whitespace before storing or hashing it. |
| `question_id`, `question_version` | Question identity. Hosted V1 questions are immutable, so the version is `sha256:<digest of the exact prompt>`. |
| `business_id` | Business identity |
| `surface` | `ghostping/surface-v1` |
| `observed_at` | UTC timestamp |
| `measurement_configuration` | What Ghostping **requested** (Knowledge JSON). This is not the provider's effective state. |
| `sample_number`, `repeat_id` | Repeat identity (hosted: the check-run id) |

## Observation evidence

`ghostping/observation-v1` references immutable raw evidence by `id`, `digest_sha256`, `content_type`, `received_at`, and `reference` (`ghostping://raw-evidence/<digest>`). The exact response bytes are canonical evidence. The worker sends them as `raw_bytes_hex`, and PostgreSQL stores them only when they hash to the reported digest. `normalized_answer_text` is derived from those bytes. `citations` contains only citations the provider returned. `provider_metadata` holds only metadata the provider returned, or `UNKNOWN`.

Raw evidence is deduplicated by digest. `received_at` is therefore the first receipt of those bytes. Rows stored before this migration have no exact bytes. Ghostping never rebuilds those bytes from normalized fields.

## Current 9Router mapping

| Field | Value |
| --- | --- |
| `kind` | `ROUTER_API` (never a consumer UI, never "ChatGPT") |
| `product` / `adapter` | `9Router` / `ghostping-9router` |
| `gateway` | `KNOWN("9router")` |
| `requested_model` | `KNOWN(<configured exact pin>)` |
| `observed_model` | `KNOWN(response.model)` only when returned, else `UNKNOWN` |
| `requested_provider`, `observed_provider` | `UNKNOWN` (9Router does not prove the upstream provider) |
| `search_mode`, `personalization_state`, `account_state`, `subscription_tier`, `locale`, `region` | `UNKNOWN` |
| `measurement_configuration` | `KNOWN({model, stream:false, sampling_parameters:"PROVIDER_DEFAULT"})`. Effective sampling values are not known. |
| citations | Only the response's `citations` array (objects or URL strings), in returned order |
| provider metadata | Only the response's `id`, `object`, `created`, `model`, `usage`, `system_fingerprint` keys that are present |

`search_mode` is always `UNKNOWN` for 9Router. Two 9Router observations therefore compare as `INDETERMINATE` and never as `EXACT_MATCH`.

## Mock mapping

`kind=MOCK`, `product="Ghostping deterministic fixture"`, `adapter=ghostping-mock`. Every external dimension is `NOT_APPLICABLE`, because a fixture has no account, locale, search, or personalization. Mock observations are always `synthetic=true`. PostgreSQL rejects a row whose surface kind is `MOCK` and whose `synthetic` value is false. Export treats every `provider='mock'` row as synthetic, including rows stored before the `synthetic` column existed. A rendered packet that contains synthetic evidence starts with `SYNTHETIC DATA.`.
