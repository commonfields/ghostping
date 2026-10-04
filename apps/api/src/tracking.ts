// Operator-driven source tracking: the product path for associating a
// source with the business (VERIFY SOURCE stage prerequisite). Deliberate
// user action only — discovery never auto-creates targets or bindings.
// Unknown ids and cross-business ids both read as null (404 upstream,
// no existence leak). Idempotent: re-tracking the identical binding
// returns the existing row instead of duplicating it.
import { Effect } from "effect"
import { normalizeUrl } from "@ghostping/representation"
import {
  FactRepository,
  ProductReadRepository,
  SourceTargetRepository,
  type SourceBindingRow,
  type SourceTargetRow,
} from "@ghostping/db"

export interface CreateTargetInput {
  readonly url: string
  readonly control: "OWNED" | "THIRD_PARTY" | "UNKNOWN"
}

export interface CreateBindingInput {
  readonly factId: string
  readonly extractorKind: "JSON_LD" | "CSS_TEXT" | "META_CONTENT"
  readonly extractorSelector: string
  readonly comparator: "EXACT_TEXT" | "BOOLEAN" | "MONEY"
}

/** A tracked source target, or null when the URL is not an http(s) URL. */
export const createTarget = (
  businessId: string,
  input: CreateTargetInput,
): Effect.Effect<SourceTargetRow | null, unknown, SourceTargetRepository> =>
  Effect.gen(function*() {
    const canonical = normalizeUrl(input.url.trim())
    if (canonical === null) return null
    const targets = yield* SourceTargetRepository
    const existing = yield* targets.listByBusiness(businessId)
    const same = existing.find((t) => t.url === canonical)
    if (same) return same
    return yield* targets.create({ businessId, url: canonical, control: input.control })
  })

/** A binding of an approved fact to a tracked target, or null when any id is unknown here. */
export const createBinding = (
  businessId: string,
  targetId: string,
  input: CreateBindingInput,
): Effect.Effect<SourceBindingRow | null, unknown, SourceTargetRepository | FactRepository | ProductReadRepository> =>
  Effect.gen(function*() {
    const targets = yield* SourceTargetRepository
    const target = yield* targets.getScoped(businessId, targetId)
    if (!target) return null
    const facts = yield* FactRepository
    const fact = yield* facts.getScoped(businessId, input.factId)
    if (!fact) return null
    const reads = yield* ProductReadRepository
    const selector = input.extractorSelector.trim()
    if (!selector) return null
    const existing = yield* reads.findBindingExact(
      businessId,
      target.id,
      fact.id,
      input.extractorKind,
      selector,
      input.comparator,
    )
    if (existing) return existing
    return yield* reads.createBinding({
      businessId,
      factId: fact.id,
      sourceTargetId: target.id,
      extractorKind: input.extractorKind,
      extractorSelector: selector,
      comparator: input.comparator,
    })
  })
