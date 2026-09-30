# External Inference V1 (9Router, one pinned model)

Engineering-validation milestone: real network inference through the
complete hosted stack. NOT a GEO effectiveness claim. NOT a measurement of
ChatGPT/Gemini/Claude consumer surfaces.

## Gateway and pinning

- Gateway: **9Router**, OpenAI-compatible `POST {base}/v1/chat/completions`.
- Execution mode: `provider=9router` (only `mock` and `9router` are enabled
  in hosted mode; direct providers stay rejected).
- Model: exactly one pinned model via `NINE_ROUTER_MODEL`. The Rust worker
  sends that model id verbatim with `stream:false` and one user message.
  A job naming any other model fails closed (`WORKER_FAILED`, no request).
- Fallback: the worker never requests `auto`/combos and never retries
  across models. Whether the gateway itself falls back internally is
  observable only through the resolved model (below); if the resolved model
  differs from the requested pin, `fallback_occurred=true`.

## Evidence semantics (never mislabeled)

- `surface_kind = CONTROLLED_API` for every `provider=9router` row
  (documented constant, not a measured consumer surface).
- `gateway = 9router` is the `provider` field (no overload: a 9Router row
  is never labeled ChatGPT/Gemini/Claude/Perplexity).
- `requested_model` = the exact pin sent.
- `resolved_model` = `observed_model`, populated ONLY from the response
  body's `model` field; `null` (UNKNOWN) when absent.
- `fallback_occurred`: `true` if resolved differs from requested, `false`
  if equal, `UNKNOWN` if resolved is null.
- `retrieval_mode = unknown` always (a chat completion proves no
  grounding); `citations = []` always (never invented).
- Token/cost metadata: preserved verbatim inside the exact `raw_response`
  body (`usage.*` when the gateway returns it); `null`/absent otherwise —
  never invented.

## Contract: result-v1 kept (no v2)

`ghostping-worker-result-v1` represents the new provider without
ambiguity: gateway via `provider`, requested via `requested_model`,
resolved via `observed_model`-or-null, usage via the exact raw body.
No schema bump for adding a provider; v2 would require evidence that
cannot be represented, which does not exist here.

## Configuration (env only)

- `NINE_ROUTER_BASE_URL` (default `http://localhost:20128/v1`)
- `NINE_ROUTER_API_KEY` (optional; header-only when set)
- `NINE_ROUTER_MODEL` (required pin; missing = fail-closed `WORKER_FAILED`)
- `NINE_ROUTER_TIMEOUT_MS` (default `60000`)

Secrets never enter `WorkerJobV1`, CheckRun rows, raw evidence,
frontend payloads, or logs. HTTPS is enforced except loopback.

## Failure mapping and retry

- `401/403 → PROVIDER_AUTH`, `429 → PROVIDER_RATE_LIMITED`,
  timeout → `PROVIDER_TIMEOUT`, other non-2xx/unreachable →
  `PROVIDER_UNAVAILABLE`, 2xx-but-bad-schema → `PROVIDER_MALFORMED`.
- Frozen bound unchanged: initial + 3 retries = 4 attempts through the
  existing Effect retry path (typed classes only; auth/malformed never retry).

## Live runs (opt-in only)

Live 9Router traffic happens ONLY through `scripts/live-9router-check.sh`,
which refuses to run unless `GHOSTPING_LIVE_PROVIDER=1` plus
`NINE_ROUTER_API_KEY` and `NINE_ROUTER_MODEL` are set. `pnpm test`,
`cargo test`, and CI never touch the network: Rust tests use a localhost
stub server, and no live key exists in CI.

## Status

- Code, fixtures, docs, and Notion frozen fixture: complete on this branch.
- Live execution (≥10 real checks + 3 manual reviews): **pending gateway
  credentials** (`NINE_ROUTER_API_KEY`, reachable base URL, pinned model).
