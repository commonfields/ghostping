import { describe, expect, it } from "vitest"
import { assembleCitationEvidence, assembleRepresentationList, findingHistoryForBinding } from "./reads.js"

const rows = () => ({
  facts: [{ id: "f", subject: "Acme Starter", predicate: "monthly price", valueText: "49 USD", valueType: "CURRENCY", status: "ACTIVE", version: 2 }],
  targets: [
    { id: "t1", url: "https://acme.example/pricing", control: "OWNED" },
    { id: "t2", url: "https://docs.acme.example/billing", control: "OWNED" },
  ],
  bindings: [
    { id: "b1", factId: "f", sourceTargetId: "t1", extractorKind: "JSON_LD", extractorSelector: "offers.price", comparator: "MONEY" },
    { id: "b2", factId: "f", sourceTargetId: "t2", extractorKind: "CSS_TEXT", extractorSelector: ".price", comparator: "MONEY" },
  ],
  observations: [
    { id: "o1", sourceTargetId: "t1", completedAt: "2026-10-03T10:00:00.000Z", collectionState: "FETCHED", failure: null },
    { id: "o2", sourceTargetId: "t1", completedAt: "2026-10-03T11:00:00.000Z", collectionState: "FAILED", failure: "TIMEOUT" },
    { id: "o3", sourceTargetId: "t2", completedAt: "2026-10-03T09:00:00.000Z", collectionState: "FETCHED", failure: null },
  ],
  values: [
    { id: "v1", sourceObservationId: "o1", sourceBindingId: "b1", factId: "f", extractedValue: "49 USD", extractionState: "OBSERVED" },
    { id: "v3", sourceObservationId: "o3", sourceBindingId: "b2", factId: "f", extractedValue: "39 USD", extractionState: "OBSERVED" },
  ],
})

describe("assembleRepresentationList", () => {
  it("keeps effective evidence and latest attempt separate", () => {
    const list = assembleRepresentationList(rows())
    const pricing = list.find((r) => r.binding_id === "b1")!
    expect(pricing.finding.state).toBe("IN_SYNC")
    expect(pricing.effective_observation).toMatchObject({ observation_id: "o1", extracted_value: "49 USD" })
    expect(pricing.latest_attempt).toMatchObject({ completed_at: "2026-10-03T11:00:00.000Z", collection_state: "FAILED", failure: "TIMEOUT" })
    const docs = list.find((r) => r.binding_id === "b2")!
    expect(docs.finding.state).toBe("DRIFT")
    expect(JSON.stringify(list)).not.toMatch(/caused_by|CAUSED_BY|influence|score/i)
  })

  it("unobserved bindings are UNKNOWN without an effective observation", () => {
    const r = rows()
    const list = assembleRepresentationList({ ...r, observations: [], values: [] })
    for (const row of list) {
      expect(row.finding.state).toBe("UNKNOWN")
      expect(row.effective_observation).toBeNull()
      expect(row.latest_attempt).toBeNull()
    }
  })
})

describe("assembleCitationEvidence", () => {
  it("links fragment-only differences, never query differences", () => {
    const representations = assembleRepresentationList(rows())
    const out = assembleCitationEvidence(
      [
        { uri: "https://docs.acme.example/billing#plans", title: "Billing", position: 1, attributed: true },
        { uri: "https://docs.acme.example/billing?ref=gemini", title: "Billing", position: 2, attributed: false },
        { uri: "https://thirdparty.example/acme", title: null, position: null, attributed: false },
      ],
      representations,
    )
    expect(out[0]?.tracked?.binding_id).toBe("b2")
    expect(out[1]?.tracked).toBeNull()
    expect(out[2]?.tracked).toBeNull()
  })
})

describe("findingHistoryForBinding", () => {
  it("orders history with per-observation states", () => {
    const r = rows()
    const history = findingHistoryForBinding(
      "b1",
      r.facts[0]!,
      { id: "b1", factId: "f", sourceTargetId: "t1", extractorKind: "JSON_LD", extractorSelector: "offers.price", comparator: "MONEY" },
      r.observations,
      r.values,
    )
    expect(history.map((h) => [h.observation_id, h.state])).toEqual([["o1", "IN_SYNC"], ["o2", "UNKNOWN"]])
  })
})
