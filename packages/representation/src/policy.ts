// Bounded collection policy: never recursively crawl by default.
// A collection request targets explicit SourceTargets only.
// V1 target creation comes only from:
// - user/operator configured URL
// - authoritative fact source URL
// - URL already observed in provider-returned AI citations
// No sitemap recursion, no backlink discovery, no web search.

export const TARGET_ORIGIN = ["OPERATOR", "FACT_SOURCE", "AI_CITATION"] as const
export type TargetOrigin = (typeof TARGET_ORIGIN)[number]

export const assertTargetOrigin = (origin: string): TargetOrigin => {
  if ((TARGET_ORIGIN as ReadonlyArray<string>).includes(origin)) return origin as TargetOrigin
  throw new Error(`InvalidTargetOrigin: ${origin}`)
}

/**
 * Cache rule: when the collector returns NOT_MODIFIED (304) or the body
 * digest is unchanged, reuse previous extraction results without rerunning
 * extractors, provided extractor + comparator versions are unchanged.
 */
export const shouldReuseExtraction = (args: {
  readonly collection_state: "FETCHED" | "NOT_MODIFIED" | "FAILED"
  readonly body_digest: string | null
  readonly previous_digest: string | null
  readonly extractor_version: string
  readonly previous_extractor_version: string | null
  readonly comparator_unchanged: boolean
}): boolean => {
  if (args.collection_state === "FAILED") return false
  if (args.collection_state === "NOT_MODIFIED") return true
  if (args.body_digest !== null && args.body_digest === args.previous_digest) {
    return args.extractor_version === args.previous_extractor_version && args.comparator_unchanged
  }
  return false
}
