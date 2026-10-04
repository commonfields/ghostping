import { Effect, Layer, Redacted } from "effect"
import { MockProvider, ProviderMalformed, ProviderUnavailable, rawEvidence } from "./model.js"
export const mockAnswer = (prompt: string): string => {
  const p = prompt.toLowerCase()
  if (p.includes("__wrong__")) return "Northstar costs $29/month."
  if (p.includes("__supported__")) return "Northstar does not integrate with Salesforce."
  if (p.includes("__unknown__")) return "I don't have enough information about Northstar's cancellation policy."
  if (p.includes("cost") || p.includes("price") || p.includes("much does northstar")) return "Northstar costs $29/month."
  if (p.includes("salesforce")) return "Northstar does not integrate with Salesforce."
  if (p.includes("cancellation") || p.includes("cancel")) return "I'm not sure about Northstar's cancellation policy — I don't have reliable information."
  return "I don't have enough information to answer that about Northstar."
}
export const MockProviderLive = Layer.succeed(MockProvider, {
  observe: (request) => Effect.gen(function*() {
    const p = request.prompt.toLowerCase()
    if (p.includes("__fail__") || p.includes("fail_provider")) {
      const bytes = new TextEncoder().encode(JSON.stringify({ provider: "mock", prompt: request.prompt, error: "simulated provider failure" }))
      if (bytes.byteLength > 2 * 1024 * 1024) return yield* Effect.fail(new ProviderMalformed({}))
      return yield* Effect.fail(new ProviderUnavailable({ evidence: Redacted.make(rawEvidence(bytes, "application/json")) }))
    }
    const answer = mockAnswer(request.prompt)
    const rawResponse = { provider: "mock", model: "mock-v1", prompt: request.prompt, answer, retrieval_mode: "unknown", citations: [] }
    const bytes = new TextEncoder().encode(JSON.stringify(rawResponse))
    if (bytes.byteLength > 2 * 1024 * 1024) return yield* Effect.fail(new ProviderMalformed({}))
    return {
      ...rawEvidence(bytes, "application/json"),
      provider: "mock", requestedModel: request.requestedModel, observedModel: "mock-v1",
      collectedAt: new Date().toISOString(), answerText: answer, retrievalMode: "unknown" as const,
      citations: [], rawResponse, providerMetadata: { synthetic: true }, synthetic: true,
    }
  }),
})
