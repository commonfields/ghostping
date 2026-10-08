import { Effect, Layer, Redacted } from "effect"
import { MockProvider, ProviderMalformed, ProviderUnavailable, rawEvidence, type Citation, type ProviderRequest } from "./model.js"
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
export const makeMockProviderLive = (script?: (request: ProviderRequest) => string | null | { answer: string; citations: readonly (typeof Citation.Type)[] }) => Layer.succeed(MockProvider, {
  observe: (request) => Effect.gen(function*() {
    const scripted = script?.(request)
    const p = request.prompt.toLowerCase()
    if (scripted === null || p.includes("__fail__") || p.includes("fail_provider")) {
      const bytes = new TextEncoder().encode(JSON.stringify({ provider: "mock", prompt: request.prompt, error: "simulated provider failure" }))
      if (bytes.byteLength > 2 * 1024 * 1024) return yield* Effect.fail(new ProviderMalformed({}))
      return yield* Effect.fail(new ProviderUnavailable({ evidence: Redacted.make(rawEvidence(bytes, "application/json")) }))
    }
    const answer = typeof scripted === "object" && scripted !== null ? scripted.answer : scripted ?? mockAnswer(request.prompt)
    const citations = typeof scripted === "object" && scripted !== null ? scripted.citations : []
    const retrievalMode = "unknown"
    const rawResponse = { provider: "mock", model: "mock-v1", prompt: request.prompt, answer, retrieval_mode: retrievalMode, citations }
    const bytes = new TextEncoder().encode(JSON.stringify(rawResponse))
    if (bytes.byteLength > 2 * 1024 * 1024) return yield* Effect.fail(new ProviderMalformed({}))
    return {
      ...rawEvidence(bytes, "application/json"),
      provider: "mock", requestedModel: request.requestedModel, observedModel: "mock-v1",
      collectedAt: new Date().toISOString(), answerText: answer, retrievalMode, modelVersion: "mock-v1", retrievalTool: null,
      requestParameters: { retrievalMode: request.retrievalMode ?? null, sampleNumber: request.sampleNumber ?? null },
      citations, rawResponse, providerMetadata: { synthetic: true }, synthetic: true,
    }
  }),
})

export const MockProviderLive = makeMockProviderLive()
