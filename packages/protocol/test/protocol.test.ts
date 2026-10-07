import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { deriveIssueState } from "@openrecord/domain"
import {
  canonicalJson,
  compareMeasurements,
  CRITICAL_DIMENSIONS,
  deriveObservedChange,
  deriveOutcome,
  EvidencePacketInvalid,
  factsAt,
  issueStateFor,
  knownValue,
  measurementSignature,
  packetDigest,
  renderEvidencePacket,
  sealPacket,
  serializePacket,
  sha256,
  SUPPORTING_DIMENSIONS,
  surfaceForWorker,
  UNKNOWN,
  validatePacket,
  type EvidencePacketV1,
  type MeasurementSignatureV1,
  type Verdict,
} from "../src/index.js"
import { buildFixtures, buildPackets, canonicalVectors, expectedResults } from "../scripts/fixtures.js"
import { buildSchemas } from "../scripts/schemas.js"

const root = resolve(import.meta.dirname, "../../..")
const dir = resolve(root, "fixtures/evidence-protocol-v1")
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))
const fixture = (name: string): unknown => readJson(resolve(dir, `${name}.json`))
const packet = (name: string): EvidencePacketV1 => validatePacket(fixture(name))
const fixtureNames = readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort()
const expected = readJson(resolve(dir, "vectors/expected.json")) as Record<string, { valid: boolean; reason?: string; packet_digest?: string }>
const reasonOf = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    return e instanceof EvidencePacketInvalid ? e.reason : `non-protocol error: ${String(e)}`
  }
  return "accepted"
}

describe("generated artifacts", () => {
  it("committed fixtures equal the canonical generator output", () => {
    const built = buildFixtures()
    expect(fixtureNames).toEqual(Object.keys(built).sort())
    for (const name of fixtureNames) expect(fixture(name), name).toEqual(JSON.parse(JSON.stringify(built[name])))
    expect(readJson(resolve(dir, "vectors/expected.json"))).toEqual(expectedResults(built))
    expect(readJson(resolve(dir, "vectors/canonical-json.json"))).toEqual(JSON.parse(JSON.stringify(canonicalVectors())))
  })
  it("committed JSON Schemas equal the Effect Schema generator output", () => {
    const built = buildSchemas()
    const schemaDir = resolve(root, "schemas/ghostping")
    expect(readdirSync(schemaDir).sort()).toEqual(Object.keys(built).sort())
    for (const [name, text] of Object.entries(built)) expect(readFileSync(resolve(schemaDir, name), "utf8"), name).toBe(text)
  })
})

describe("protocol validation", () => {
  it("accepts every V1 fixture and rejects every malformed one with the expected reason", () => {
    expect(fixtureNames.filter((n) => n.startsWith("malformed-")).length).toBeGreaterThanOrEqual(5)
    for (const name of fixtureNames) {
      const want = expected[name]
      expect(want, name).toBeDefined()
      if (name.startsWith("malformed-")) expect(reasonOf(() => validatePacket(fixture(name))), name).toBe(want?.reason)
      else expect(packet(name).packet_digest, name).toBe(want?.packet_digest)
    }
  })
  it("rejects an unknown future version before trusting any other field", () => {
    expect(reasonOf(() => validatePacket({ ...packet("corrected-reobservation"), schema_version: 2 }))).toBe("UnsupportedSchemaVersion")
    expect(reasonOf(() => validatePacket({ ...packet("corrected-reobservation"), schema: "ghostping/evidence-packet-v2" }))).toBe("UnsupportedSchemaVersion")
  })
  it("rejects malformed required fields, excess fields, and non-empty V1 signatures", () => {
    const p = packet("corrected-reobservation")
    const { issue: _issue, ...missing } = p
    expect(reasonOf(() => validatePacket(missing))).toBe("SchemaViolation")
    expect(reasonOf(() => validatePacket({ ...p, corrected: true }))).toBe("SchemaViolation")
    expect(reasonOf(() => validatePacket({ ...p, signatures: [{ alg: "x" }] }))).toBe("SchemaViolation")
  })
  it("rejects resealed packets whose derived fields disagree with their evidence", () => {
    const p = packet("changed-unjudged")
    const forged = sealPacket({ ...p, reobservations: p.reobservations.map((r) => ({ ...r, outcome: "OBSERVED_CORRECTION" as const })) })
    expect(reasonOf(() => validatePacket(forged))).toBe("DerivationMismatch")
    const flipped = sealPacket({ ...p, issue: { ...p.issue, state: "RESOLVED" as const } })
    expect(reasonOf(() => validatePacket(flipped))).toBe("DerivationMismatch")
  })
  it("rejects cross-tenant and dangling references", () => {
    const p = packet("corrected-reobservation")
    const foreign = sealPacket({ ...p, interventions: p.interventions.map((i) => ({ ...i, business_id: "business-other" })) })
    expect(reasonOf(() => validatePacket(foreign))).toBe("CrossTenantReference")
    const dangling = sealPacket({ ...p, judgments: p.judgments.map((j) => ({ ...j, fact_ids: ["fact-missing"] })) })
    expect(reasonOf(() => validatePacket(dangling))).toBe("DanglingReference")
  })
  it("rejects judgment forks, cycles, and self-supersession with a shared reason", () => {
    expect(reasonOf(() => validatePacket(fixture("malformed-judgment-fork")))).toBe("InvalidJudgmentSupersession")
    expect(reasonOf(() => validatePacket(fixture("malformed-judgment-cycle")))).toBe("InvalidJudgmentSupersession")
    expect(reasonOf(() => validatePacket(fixture("malformed-judgment-self")))).toBe("InvalidJudgmentSupersession")
  })
  it("rejects intervention forks, cycles, and self-supersession with a shared reason", () => {
    expect(reasonOf(() => validatePacket(fixture("malformed-intervention-fork")))).toBe("InvalidInterventionSupersession")
    expect(reasonOf(() => validatePacket(fixture("malformed-intervention-cycle")))).toBe("InvalidInterventionSupersession")
    expect(reasonOf(() => validatePacket(fixture("malformed-intervention-self")))).toBe("InvalidInterventionSupersession")
  })
})

describe("canonical JSON", () => {
  it("matches shared vectors and refuses non-portable input", () => {
    const vectors = canonicalVectors()
    for (const v of vectors.accepted) {
      expect(canonicalJson(v.input)).toBe(v.canonical)
      expect(sha256(v.canonical)).toBe(v.sha256)
    }
    for (const raw of vectors.rejected) expect(() => canonicalJson(JSON.parse(raw)), raw).toThrow(/CanonicalJsonError/)
  })
  it("is independent of key insertion order and stable across serializations", () => {
    expect(canonicalJson({ b: 2, a: [3, { z: null, y: "x" }] })).toBe('{"a":[3,{"y":"x","z":null}],"b":2}')
    const p = packet("corrected-reobservation")
    const reversed = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reversed)
        : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)]))
        : v
    const shuffled = reversed(p) as EvidencePacketV1
    expect(canonicalJson(shuffled)).toBe(serializePacket(p))
    expect(packetDigest(shuffled)).toBe(p.packet_digest)
    expect(validatePacket(JSON.parse(serializePacket(p))).packet_digest).toBe(p.packet_digest)
  })
  it("exports deterministic packets and digests", () => {
    const a = buildPackets()
    const b = buildPackets()
    for (const name of Object.keys(a)) {
      expect(serializePacket(a[name]!)).toBe(serializePacket(b[name]!))
      expect(a[name]!.packet_digest).toBe(sha256(canonicalJson({ ...a[name]!, packet_digest: undefined })))
    }
  })
})

describe("surface protocol", () => {
  it("maps 9Router to ROUTER_API with explicit unknowns and never infers upstream state", () => {
    const router = surfaceForWorker("9router", "pin-model", null)
    expect(router.kind).toBe("ROUTER_API")
    expect(router.gateway).toEqual(knownValue("9router"))
    expect(router.requested_model).toEqual(knownValue("pin-model"))
    expect(router.observed_model).toEqual(UNKNOWN)
    expect(router.requested_provider).toEqual(UNKNOWN)
    expect(router.observed_provider).toEqual(UNKNOWN)
    expect(router.search_mode).toEqual(UNKNOWN)
    expect(router.personalization_state).toEqual(UNKNOWN)
    expect(surfaceForWorker("9router", "pin-model", "returned-model").observed_model).toEqual(knownValue("returned-model"))
  })
  it("maps mock to MOCK and rejects unsupported providers", () => {
    expect(surfaceForWorker("mock", null, null).kind).toBe("MOCK")
    expect(() => surfaceForWorker("openai", null, null)).toThrow(/UnsupportedSurfaceProvider/)
  })
  it("an API measurement cannot masquerade as a consumer UI", () => {
    for (const p of ["9router", "mock"]) expect(surfaceForWorker(p, "m", "m").kind).not.toBe("CONSUMER_UI")
    const api = measurementSignature(packet("corrected-reobservation").original_observation.measurement)
    expect(compareMeasurements(api, { ...api, surface_kind: "CONSUMER_UI" })).toBe("NOT_COMPARABLE")
    const text = renderEvidencePacket(packet("router-api-reobservation"))
    expect(text).toContain("9Router, a router API")
    expect(text).not.toMatch(/ChatGPT|consumer/i)
  })
})

describe("measurement comparison", () => {
  const sig = measurementSignature(packet("corrected-reobservation").original_observation.measurement)
  it("identical known configuration is EXACT_MATCH", () => expect(compareMeasurements(sig, { ...sig })).toBe("EXACT_MATCH"))
  it("account_state and subscription_tier participate as critical dimensions", () => {
    const free = { ...sig, subscription_tier: knownValue("free") }
    const pro = { ...sig, subscription_tier: knownValue("pro") }
    expect(compareMeasurements(free, pro)).toBe("NOT_COMPARABLE")
    const authed = { ...sig, account_state: knownValue("authenticated") }
    const anon = { ...sig, account_state: knownValue("anonymous") }
    expect(compareMeasurements(authed, anon)).toBe("NOT_COMPARABLE")
    const unknownA = { ...sig, account_state: UNKNOWN, subscription_tier: UNKNOWN }
    const unknownB = { ...sig, account_state: UNKNOWN, subscription_tier: UNKNOWN }
    expect(compareMeasurements(unknownA, unknownB)).toBe("INDETERMINATE")
    expect(compareMeasurements(sig, unknownA)).toBe("INDETERMINATE")
  })
  it("incomplete supporting configuration is COMPARABLE; incomplete critical configuration is INDETERMINATE", () => {
    expect(compareMeasurements(sig, { ...sig, locale: UNKNOWN })).toBe("COMPARABLE")
    expect(compareMeasurements(sig, { ...sig, adapter_version: "2" })).toBe("COMPARABLE")
    expect(compareMeasurements(sig, { ...sig, search_mode: UNKNOWN })).toBe("INDETERMINATE")
  })
  it("provider, model, locale, or exact-prompt changes are NOT_COMPARABLE", () => {
    expect(compareMeasurements(sig, { ...sig, requested_provider: knownValue("other") })).toBe("NOT_COMPARABLE")
    expect(compareMeasurements(sig, { ...sig, requested_model: knownValue("other") })).toBe("NOT_COMPARABLE")
    expect(compareMeasurements(sig, { ...sig, surface_kind: "ROUTER_API" })).toBe("NOT_COMPARABLE")
    expect(compareMeasurements(sig, { ...sig, locale: knownValue("de-DE") })).toBe("NOT_COMPARABLE")
    expect(compareMeasurements(sig, { ...sig, exact_question_digest: sha256("How much does Acme Starter cost? ") })).toBe("NOT_COMPARABLE")
  })
  it("UNKNOWN on both sides never proves equality for any dimension", () => {
    for (const key of [...CRITICAL_DIMENSIONS, ...SUPPORTING_DIMENSIONS]) {
      const hidden: MeasurementSignatureV1 = { ...sig, [key]: UNKNOWN }
      const result = compareMeasurements(hidden, { ...hidden })
      expect(result, key).not.toBe("EXACT_MATCH")
      expect(result, key).toBe(CRITICAL_DIMENSIONS.includes(key) ? "INDETERMINATE" : "COMPARABLE")
    }
  })
  it("timestamps are not part of the signature", () => {
    const m = packet("corrected-reobservation").original_observation.measurement
    expect(measurementSignature({ ...m, observed_at: "2030-01-01T00:00:00.000Z" })).toEqual(measurementSignature(m))
  })
})

describe("outcome semantics", () => {
  it("derives correction, regression, and indeterminate states only from judgments on usable comparisons", () => {
    expect(deriveOutcome("CONTRADICTED", "SUPPORTED", "EXACT_MATCH", "CHANGED")).toBe("OBSERVED_CORRECTION")
    expect(deriveOutcome("SUPPORTED", "CONTRADICTED", "COMPARABLE", "CHANGED")).toBe("OBSERVED_REGRESSION")
    expect(deriveOutcome(null, "SUPPORTED", "EXACT_MATCH", "CHANGED")).toBe("INDETERMINATE")
    expect(deriveOutcome("CONTRADICTED", null, "EXACT_MATCH", "CHANGED")).toBe("INDETERMINATE")
    expect(deriveOutcome("CONTRADICTED", "SUPPORTED", "NOT_COMPARABLE", "INDETERMINATE")).toBe("INDETERMINATE")
    expect(deriveOutcome("CONTRADICTED", "SUPPORTED", "INDETERMINATE", "INDETERMINATE")).toBe("INDETERMINATE")
    expect(deriveOutcome("CONTRADICTED", "CONTRADICTED", "EXACT_MATCH", "NO_CHANGE")).toBe("NO_OBSERVED_CHANGE")
    expect(deriveOutcome("CONTRADICTED", "CONTRADICTED", "EXACT_MATCH", "CHANGED")).toBe("OBSERVED_DIFFERENCE")
    expect(deriveObservedChange("NOT_COMPARABLE", "a", "b")).toBe("INDETERMINATE")
  })
  it("issue state mapping agrees with the hosted domain", () => {
    const verdicts: Array<Verdict | null> = [null, "SUPPORTED", "CONTRADICTED", "PARTIAL", "INSUFFICIENT_EVIDENCE"]
    for (const v of verdicts) {
      const latest = v === null ? null : ({ verdict: v } as Parameters<typeof deriveIssueState>[0])
      expect(issueStateFor(v), String(v)).toBe(deriveIssueState(latest))
    }
  })
  it("selects the fact version valid at each measurement time", () => {
    const p = packet("superseded-fact")
    expect(factsAt(p.facts, p.original_observation.measurement.observed_at).map((f) => f.version)).toEqual([1])
    expect(factsAt(p.facts, p.reobservation_observations[0]!.measurement.observed_at).map((f) => f.version)).toEqual([2])
  })
})

describe("evidence packets", () => {
  it("PART 11 acceptance: complete lineage, correction observed, causality UNKNOWN", () => {
    const p = packet("corrected-reobservation")
    expect(p.facts.map((f) => f.value_text)).toEqual(["$39/month"])
    expect(p.claims[0]?.text).toBe("$29/month")
    expect(p.issue.type).toEqual(knownValue("WRONG_PRICE"))
    expect(p.issue.state).toBe("WRONG")
    expect(p.judgments.map((j) => j.verdict)).toEqual(["INSUFFICIENT_EVIDENCE", "CONTRADICTED"])
    expect(p.interventions[0]).toMatchObject({ type: "SOURCE_UPDATED", target: "https://acme.example/pricing", evidence_before_digest: knownValue("a".repeat(64)), evidence_after_digest: knownValue("b".repeat(64)) })
    expect(p.reobservation_observations[0]?.measurement.question).toBe(p.original_observation.measurement.question)
    expect(p.reobservation_claims[0]?.text).toBe("$39/month")
    expect(p.reobservations[0]).toMatchObject({ before_verdict: "CONTRADICTED", after_verdict: "SUPPORTED", match_classification: "EXACT_MATCH", observed_change: "CHANGED", outcome: "OBSERVED_CORRECTION", causal_attribution: "UNKNOWN" })
    expect(p.observed_outcome).toBe("OBSERVED_CORRECTION")
    expect(p.causal_attribution).toBe("UNKNOWN")
    expect(p.explicit_unknowns).toContainEqual({ subject_id: p.issue.id, field: "causal_attribution" })
  })
  it("PART 12 negative cases never claim a correction", () => {
    expect(packet("incomparable-reobservation").reobservations[0]).toMatchObject({ match_classification: "NOT_COMPARABLE", outcome: "INDETERMINATE" })
    expect(packet("indeterminate-hidden-dimensions").reobservations[0]).toMatchObject({ match_classification: "INDETERMINATE", outcome: "INDETERMINATE" })
    const notObserved = packet("intervention-not-observed")
    expect(notObserved.observed_outcome).toBe("NOT_OBSERVED")
    expect(notObserved.explicit_unknowns).toContainEqual({ subject_id: notObserved.issue.id, field: "outcome_after_intervention" })
    const unjudged = packet("changed-unjudged")
    expect(unjudged.reobservations[0]).toMatchObject({ observed_change: "CHANGED", after_verdict: null, outcome: "INDETERMINATE" })
    expect(unjudged.explicit_unknowns).toContainEqual({ subject_id: "reobservation-after", field: "after_verdict" })
    const superseded = packet("superseded-fact")
    expect(superseded.facts.map((f) => [f.version, f.status])).toEqual([[1, "SUPERSEDED"], [2, "ACTIVE"]])
    expect(superseded.reobservations[0]?.outcome).toBe("OBSERVED_DIFFERENCE")
  })
  it("preserves corrective interventions without rewriting history", () => {
    const [original, correction] = packet("corrective-intervention").interventions
    expect(original).toMatchObject({ type: "SOURCE_UPDATED", supersedes_id: null })
    expect(correction).toMatchObject({ supersedes_id: original?.id, correction_reason: expect.any(String) })
  })
  it("explicit unknowns cover attribution and hidden surface state", () => {
    const p = packet("unknown-attribution")
    for (const field of ["actor", "actor_id", "evidence_before_digest", "evidence_after_digest"]) {
      expect(p.explicit_unknowns).toContainEqual({ subject_id: "intervention-pricing-page", field })
    }
    expect(packet("router-api-reobservation").explicit_unknowns).toContainEqual({ subject_id: "observation-before", field: "surface.search_mode" })
  })
  it("mock packets are visibly synthetic", () => {
    const p = packet("mock-synthetic")
    expect(p.synthetic).toBe(true)
    expect(p.original_observation.measurement.surface.kind).toBe("MOCK")
    expect(renderEvidencePacket(p).split("\n")[0]).toMatch(/^SYNTHETIC DATA\./)
  })
})

describe("controlled explanation renderer", () => {
  it("renders the acceptance case deterministically without causal claims", () => {
    const p = packet("corrected-reobservation")
    const text = renderEvidencePacket(p)
    expect(renderEvidencePacket(p)).toBe(text)
    expect(text).toContain('The AI response contained the claim "$29/month".')
    expect(text).toContain('The approved monthly price for Acme Starter was "$39/month" in fact version 1.')
    expect(text).toContain("The claim and the approved value conflict.")
    expect(text).toContain("The AI response cited https://example.com/acme-review.")
    expect(text).toContain("OpenRecord cannot prove that a citation caused the response.")
    expect(text).toContain("After intervention intervention-pricing-page, an exactly matched re-observation changed from CONTRADICTED to SUPPORTED.")
    expect(text).toContain("Causal attribution is UNKNOWN.")
    expect(text).not.toMatch(/caused the AI|fixed|resolved by|because of the intervention|ASD-STE100/i)
  })
  it("makes temporal fact changes and missing outcomes explicit", () => {
    expect(renderEvidencePacket(packet("superseded-fact"))).toContain("The two judgments used different fact versions.")
    expect(renderEvidencePacket(packet("intervention-not-observed"))).toContain("OpenRecord has not observed an outcome after the intervention.")
    expect(renderEvidencePacket(packet("changed-unjudged"))).toContain("No reviewer has judged the later response.")
  })
})
