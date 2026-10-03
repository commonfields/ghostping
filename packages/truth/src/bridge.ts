// Representation Graph bridge: projection `verify` blocks compile into
// the EXISTING SourceTarget / SourceBinding representation. No second
// verification engine: HTTP collection, extraction, comparison, and
// IN_SYNC / DRIFT / UNKNOWN stay in @ghostping/representation.

import type { TruthManifestV1 } from "./manifest.js"

export interface TargetDescriptor {
  readonly url: string
  readonly control: "OWNED"
}

export interface BindingDescriptor {
  readonly fact_key: string
  readonly extractor: { readonly kind: "JSON_LD" | "CSS_TEXT" | "META_CONTENT"; readonly selector: string }
  readonly comparator: "EXACT_TEXT" | "BOOLEAN" | "MONEY"
}

export interface VerificationBinding {
  readonly projection_id: string
  readonly target: TargetDescriptor
  readonly binding: BindingDescriptor
}

/** Every projection's verify block becomes one target + one binding. */
export const compileVerificationBindings = (manifest: TruthManifestV1): VerificationBinding[] =>
  manifest.projections.map((p) => ({
    projection_id: p.id,
    target: { url: p.verify.url, control: "OWNED" as const },
    binding: {
      fact_key: primaryFactKey(manifest, p.id),
      extractor: p.verify.extractor,
      comparator: p.verify.comparator,
    },
  }))

const primaryFactKey = (manifest: TruthManifestV1, projectionId: string): string => {
  const spec = manifest.projections.find((p) => p.id === projectionId)
  const refs = new Set<string>()
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    const r = node as Record<string, unknown>
    if (typeof r["fact"] === "string" && typeof r["component"] === "string") {
      refs.add(r["fact"] as string)
      return
    }
    Object.values(r).forEach(walk)
  }
  walk(spec?.document)
  const [first] = [...refs].sort()
  if (first === undefined) throw new Error(`NoFactReference: ${projectionId}`)
  return first
}

export interface BridgeTarget {
  readonly id: string
  readonly url: string
}

export interface BridgeBinding {
  readonly id: string
  readonly target_id: string
  readonly fact_id: string
}

export interface BridgeStore {
  readonly findTargetByUrl: (canonicalUrl: string) => Promise<BridgeTarget | null>
  readonly createTarget: (url: string) => Promise<BridgeTarget>
  readonly findBinding: (targetId: string, factId: string, extractorKind: string, selector: string, comparator: string) => Promise<BridgeBinding | null>
  readonly createBinding: (targetId: string, factId: string, extractorKind: string, selector: string, comparator: string) => Promise<BridgeBinding>
}

/**
 * Idempotent binding sync: repeated syncs never duplicate targets/bindings.
 * The binding tracks the logical fact lineage (fact_id resolved from the
 * manifest key at sync time), never a hard-coded old value.
 */
export const syncVerificationBindings = async (
  bindings: VerificationBinding[],
  factIds: Map<string, string>,
  canonicalize: (url: string) => string | null,
  store: BridgeStore,
): Promise<BridgeBinding[]> => {
  const out: BridgeBinding[] = []
  for (const vb of bindings) {
    const factId = factIds.get(vb.binding.fact_key)
    if (factId === undefined) throw new Error(`DanglingFactReference: ${vb.binding.fact_key}`)
    const canonical = canonicalize(vb.target.url)
    if (canonical === null) throw new Error(`InvalidVerifyUrl: ${vb.target.url}`)
    const target = (await store.findTargetByUrl(canonical)) ?? (await store.createTarget(vb.target.url))
    const binding =
      (await store.findBinding(target.id, factId, vb.binding.extractor.kind, vb.binding.extractor.selector, vb.binding.comparator)) ??
      (await store.createBinding(target.id, factId, vb.binding.extractor.kind, vb.binding.extractor.selector, vb.binding.comparator))
    out.push(binding)
  }
  return out
}
