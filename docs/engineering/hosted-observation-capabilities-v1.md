# Hosted observation capabilities

The hosted web product executes observations through `packages/providers` and
the Effect CheckRunner. Rust CLI/Tauri execution and `openrecord.toml` are
separate, frozen legacy surfaces. This boundary is intentional.

## Declarations and evidence

`packages/contracts/src/providers.ts` declares capabilities implemented by the
three existing hosted adapters. Unsupported controls are not silently accepted
by the registry. These declarations describe OpenRecord's adapter, not every
feature offered by the underlying model. They do not establish availability,
retrieval execution, a stable model revision, or correct source attribution.

- Gemini API requests `google_search`. Only returned search queries or usable
  grounding URLs establish reported retrieval. A source list is not verified
  answer-span attribution; the adapter does not capture source content.
- 9Router is a router API, not ChatGPT or another consumer application. It
  accepts no-retrieval requests but leaves actual retrieval and upstream
  provider identity unknown. Optional model, citation, and usage fields remain
  provider-reported metadata.
- Mock is synthetic fixture execution. Accepting a retrieval request mode does
  not establish retrieval. Its observations cannot prove an observed correction.

Repeated invocation is supported; independence and live-provider determinism
are not established. No new providers, fan-out, fallback, or consensus are added.
Evidence Protocol V1, historical observations, and comparison gates are unchanged.

## Configuration exposure

Authenticated `/api/providers` returns a sanitized shared contract containing
adapter capabilities, allowed workflow names, and API configuration status:
`DECLARED`, `DISABLED`, or `INVALID`. `enabled` means a valid API declaration,
not a verified connection. `workerAvailability` is explicitly `UNKNOWN` because
the worker may hold different configuration and worker-only credentials.

The catalog and worker share the 9Router model-list/connection validation and
Gemini model validation. Malformed declarations fail closed without exposing
raw configuration errors. No key or private endpoint is returned. Gemini is
listed for the client record only; it is not added to generic check/assay actions.
API and worker settings still need to agree operationally. Missing worker keys
or differing models fail visibly; this endpoint performs no live probe.

Search Console's hosted integration is unimplemented. Credentials alone yield
`BLOCKED_NOT_IMPLEMENTED`, not `CONNECTED` or `LIVE`; missing credentials yield
`BLOCKED_MISSING_CREDENTIALS`. Existing fixture data stays labeled as fixtures.

## Collection volume

Analytics `providerDaily[].answers` counts collected observations grouped by
adapter/provider. It replaces the misleading `mentions` field. Deploy API and
web together; clients consuming the old field must update. This is collection
volume, not detected business mentions, consumer reach, or share of voice.
Zero means no answers were collected in that bucket. Increasing check frequency
increases collection counts without establishing increased visibility.

Provider groupings are not model identity comparisons: multiple 9Router models
share a provider bucket. Reviewed-claim shares describe only the reviewed sample.
No universal accuracy score or causal inference follows from those shares.
