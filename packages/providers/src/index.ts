// Hosted provider surface for V1: `mock` (deterministic) plus exactly one
// external route, `9router` (single pinned model; see NINE_ROUTER_MODEL).
// Direct provider integrations (OpenAI/Anthropic/Gemini/...) are NOT enabled:
// TypeScript never parses provider-specific payloads and the Effect worker
// delegates all provider I/O to ghostping-worker (Rust).
export const SUPPORTED_HOSTED_PROVIDERS = ["mock", "9router"] as const
export type HostedProvider = (typeof SUPPORTED_HOSTED_PROVIDERS)[number]
export const isSupportedProvider = (p: string): p is HostedProvider =>
  (SUPPORTED_HOSTED_PROVIDERS as ReadonlyArray<string>).includes(p)
