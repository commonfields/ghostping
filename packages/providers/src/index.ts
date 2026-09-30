// Hosted provider surface for V1: only `mock` is enabled.
// Live providers remain server-side env configuration; the Effect worker
// delegates all provider I/O to ghostping-worker (Rust). TypeScript never
// parses provider-specific payloads.
export const SUPPORTED_HOSTED_PROVIDERS = ["mock"] as const
export type HostedProvider = (typeof SUPPORTED_HOSTED_PROVIDERS)[number]
export const isSupportedProvider = (p: string): p is HostedProvider =>
  (SUPPORTED_HOSTED_PROVIDERS as ReadonlyArray<string>).includes(p)
