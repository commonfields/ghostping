// Internal Effect services (no public REST, no API keys, no MCP).
// Persistence is injected; this package holds orchestration only.

import { extractCssText, extractJsonLd, extractMetaContent } from "./extraction.js"
import { originOf } from "./collector.js"
import { shouldReuseExtraction } from "./policy.js"
import type { CostCounters, PreviousValidators, WebCollector } from "./collector.js"
import type {
  ObservedSourceValueV1,
  SourceBindingV1,
  SourceObservationV1,
  SourceTargetV1,
} from "./types.js"

export interface RepresentationStore {
  readonly insertTarget: (t: SourceTargetV1) => Promise<void>
  readonly insertBinding: (b: SourceBindingV1) => Promise<void>
  readonly insertObservation: (o: SourceObservationV1) => Promise<void>
  readonly insertValue: (v: ObservedSourceValueV1) => Promise<void>
  readonly latestObservation: (targetId: string) => Promise<SourceObservationV1 | null>
  readonly latestValue: (bindingId: string, observationId: string) => Promise<ObservedSourceValueV1 | null>
  readonly previousValueForDigest: (bindingId: string) => Promise<{ digest: string | null; extractor_version: string | null } | null>
}

export const EXTRACTOR_VERSION = "extractors/1"

const runExtractor = (binding: SourceBindingV1, html: string) => {
  switch (binding.extractor.kind) {
    case "JSON_LD":
      return extractJsonLd(html, binding.extractor.selector)
    case "CSS_TEXT":
      return extractCssText(html, binding.extractor.selector)
    case "META_CONTENT":
      return extractMetaContent(html, binding.extractor.selector)
  }
}

export const collectAndEvaluate = async (args: {
  readonly target: SourceTargetV1
  readonly bindings: ReadonlyArray<SourceBindingV1>
  readonly collector: WebCollector
  readonly store: RepresentationStore
  readonly counters: CostCounters
  readonly ids: { observationId: string; valueIds: Record<string, string>; now: string }
}): Promise<{ observation: SourceObservationV1; values: ObservedSourceValueV1[] }> => {
  const prev = await args.store.latestObservation(args.target.id)
  const previous: PreviousValidators | null =
    prev === null
      ? null
      : { etag: prev.etag, last_modified: prev.last_modified, body_digest: prev.body_digest, origin: originOf(prev.final_url) }
  const outcome = await args.collector.collect(args.target, previous)
  const observation: SourceObservationV1 = {
    id: args.ids.observationId,
    business_id: args.target.business_id,
    source_target_id: args.target.id,
    ...outcome.observation,
  }
  await args.store.insertObservation(observation)
  const values: ObservedSourceValueV1[] = []
  if (outcome.body === null) {
    // NOT_MODIFIED or FAILED: no extraction work; failure never replaces prior valid evidence.
    return { observation, values }
  }
  for (const b of args.bindings) {
    const prevDigest = await args.store.previousValueForDigest(b.id)
    const reuse = shouldReuseExtraction({
      collection_state: observation.collection_state,
      body_digest: observation.body_digest,
      previous_digest: prevDigest?.digest ?? previous?.body_digest ?? null,
      extractor_version: EXTRACTOR_VERSION,
      previous_extractor_version: prevDigest?.extractor_version ?? null,
      comparator_unchanged: true,
    })
    if (reuse) continue
    args.counters.extractionsReran += 1
    const r = runExtractor(b, outcome.body)
    const value: ObservedSourceValueV1 = {
      id: args.ids.valueIds[b.id] ?? `${observation.id}:${b.id}`,
      business_id: args.target.business_id,
      source_observation_id: observation.id,
      source_binding_id: b.id,
      fact_id: b.fact_id,
      extracted_value: r.value,
      extraction_state: r.state,
      evidence_locator: {
        selector: b.extractor.selector,
        source_observation_id: observation.id,
        node_identity: r.node_identity,
      },
      extractor_version: EXTRACTOR_VERSION,
      created_at: args.ids.now,
    }
    await args.store.insertValue(value)
    values.push(value)
  }
  if (outcome.observation.body_digest !== previous?.body_digest) args.counters.changed += 1
  return { observation, values }
}
