import { Context, Effect, Layer } from "effect"
import { AssayRepository, type ClaimScope, type DbEffect } from "@openrecord/db"
import { proposeAssayFacts, safeFetch, type SafeFetchOptions } from "@openrecord/representation"

export class AssayRunner extends Context.Tag("AssayRunner")<AssayRunner, {
  /** The worker loop is global; `scope` limits claim and derivation to one
   * business (tests sharing one database). */
  readonly runOnce: (scope?: ClaimScope) => DbEffect<boolean>
}>() {}
export const makeAssayRunnerLive = (fetchOptions: SafeFetchOptions = {}) => Layer.effect(AssayRunner, Effect.gen(function*() {
  const assay = yield* AssayRepository
  return { runOnce: scope => Effect.gen(function*() {
    const source = yield* assay.claimSource(scope)
    if (source) {
      const evidence = yield* Effect.promise(() => safeFetch(source.url, { ...fetchOptions,
        limits: { timeoutMs: 8000, maxBytes: 1_000_000, maxRedirects: 5, acceptedContentTypes: ["text/html", "text/plain"] } }))
      const extraction = evidence.failure || !evidence.body ? { text: "", facts: [] }
        : proposeAssayFacts(new TextDecoder().decode(evidence.body), { subject: source.subject, businessName: source.business_name, planTerms: source.plan_terms, capabilityTerms: source.capability_terms })
      yield* assay.completeSource(source, evidence, extraction.text, extraction.facts)
    }
    const derived = yield* assay.derive(scope?.businessId)
    return source !== null || derived > 0
  }) }
}))
export const AssayRunnerLive = makeAssayRunnerLive()
