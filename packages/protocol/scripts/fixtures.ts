// Golden fixtures for Evidence Protocol V1. Built only through the canonical
// assembly path so every fixture is internally consistent. A test asserts the
// committed files equal this output; Rust validates the same files.
import {
  canonicalJson,
  exportEvidencePacket,
  knownValue,
  NOT_APPLICABLE,
  packetDigest,
  schemaId,
  sha256,
  surfaceForWorker,
  requestConfigurationForWorker,
  UNKNOWN,
  validatePacket,
  type ClaimV1,
  type EvidencePacketV1,
  type FactV1,
  type InterventionV1,
  type JudgmentV1,
  type KnowledgeJson,
  type ObservationV1,
  type PacketInput,
  type SurfaceIdentityV1,
  type Verdict,
} from "../src/index.js"

const BIZ = "business-acme"
const QUESTION = "How much does Acme Starter cost?"
const T0 = "2026-10-01T00:00:00.000Z"
const T_INTERVENTION = "2026-10-01T12:00:00.000Z"
const T1 = "2026-10-02T00:00:00.000Z"
const GENERATED = "2026-10-02T01:00:00.000Z"
const DIGEST_A = "a".repeat(64)
const DIGEST_B = "b".repeat(64)

const directSurface: SurfaceIdentityV1 = {
  schema: schemaId.surface,
  schema_version: 1,
  kind: "DIRECT_API",
  product: "Acme fixture provider API",
  adapter: "fixture-direct-api",
  adapter_version: "1",
  gateway: NOT_APPLICABLE,
  requested_provider: knownValue("fixture-provider"),
  requested_model: knownValue("fixture-model-a"),
  observed_provider: knownValue("fixture-provider"),
  observed_model: knownValue("fixture-model-a"),
  account_state: knownValue("SERVICE_ACCOUNT"),
  subscription_tier: NOT_APPLICABLE,
  locale: knownValue("en-US"),
  region: knownValue("US"),
  search_mode: knownValue("DISABLED"),
  personalization_state: NOT_APPLICABLE,
  metadata_visibility: "FULL",
}
const directConfig: KnowledgeJson = knownValue({ max_tokens: 100, stream: false, temperature: 0 })

const observation = (
  id: string,
  answer: string,
  at: string,
  surface: SurfaceIdentityV1 = directSurface,
  config: KnowledgeJson = directConfig,
): ObservationV1 => {
  const raw = canonicalJson({ answer, id })
  const digest = sha256(raw)
  return {
    schema: schemaId.observation,
    schema_version: 1,
    id,
    business_id: BIZ,
    measurement: {
      schema: schemaId.measurement,
      schema_version: 1,
      question: QUESTION,
      question_id: "question-acme-starter-price",
      question_version: knownValue("1"),
      business_id: BIZ,
      surface,
      observed_at: at,
      measurement_configuration: config,
      sample_number: 1,
      repeat_id: knownValue(`repeat-${id}`),
    },
    raw_evidence: {
      id: `raw-${id}`,
      digest_sha256: digest,
      content_type: "application/json",
      received_at: at,
      reference: `ghostping://raw-evidence/${digest}`,
    },
    normalized_answer_text: answer,
    citations: [{ uri: "https://example.com/acme-review", title: "Acme review", position: 1, attributed: false }],
    provider_metadata: knownValue({ finish_reason: "stop" }),
    // Every fixture is test data, whatever surface it represents.
    synthetic: true,
    created_at: at,
  }
}

const fact = (id: string, version: number, value: string, from: string, until: string | null, supersedes: string | null): FactV1 => ({
  schema: schemaId.fact,
  schema_version: 1,
  id,
  business_id: BIZ,
  subject: "Acme Starter",
  predicate: "monthly price",
  value_text: value,
  value_type: "CURRENCY",
  status: until === null ? "ACTIVE" : "SUPERSEDED",
  version,
  supersedes_id: supersedes,
  valid_from: from,
  valid_until: until,
  source_kind: "MANUAL",
  created_at: from,
})
const claim = (id: string, observationId: string, text: string, at: string): ClaimV1 => ({
  schema: schemaId.claim,
  schema_version: 1,
  id,
  business_id: BIZ,
  observation_id: observationId,
  text,
  origin: "MANUAL_EXACT_SPAN",
  created_at: at,
})
const judgment = (id: string, claimId: string, verdict: Verdict, factIds: Array<string>, at: string, supersedes: string | null = null): JudgmentV1 => ({
  schema: schemaId.judgment,
  schema_version: 1,
  id,
  business_id: BIZ,
  claim_id: claimId,
  verdict,
  notes: null,
  fact_ids: factIds,
  supersedes_id: supersedes,
  created_at: at,
})

const FACT_39 = fact("fact-acme-starter-price-v1", 1, "$39/month", "2026-01-01T00:00:00.000Z", null, null)
const intervention: InterventionV1 = {
  schema: schemaId.intervention,
  schema_version: 1,
  id: "intervention-pricing-page",
  business_id: BIZ,
  issue_ids: ["claim-before"],
  type: "SOURCE_UPDATED",
  target: "https://acme.example/pricing",
  performed_at: T_INTERVENTION,
  actor: "HUMAN",
  actor_id: knownValue("operator-1"),
  notes: "Pricing page now states $39/month.",
  evidence_before_digest: knownValue(DIGEST_A),
  evidence_after_digest: knownValue(DIGEST_B),
  supersedes_id: null,
  correction_reason: null,
  created_at: T_INTERVENTION,
}

const before = observation("observation-before", "$29/month", T0)
const after = observation("observation-after", "$39/month", T1)
const base: PacketInput = {
  id: "packet-claim-before",
  business: { id: BIZ, name: "Acme" },
  issue: { id: "claim-before", type: knownValue("WRONG_PRICE"), created_at: T0 },
  issue_claim_id: "claim-before",
  facts: [FACT_39],
  original_observation: before,
  claims: [claim("claim-before", before.id, "$29/month", T0)],
  // Judgment history: an initial INSUFFICIENT_EVIDENCE superseded by CONTRADICTED.
  judgments: [
    judgment("judgment-before-1", "claim-before", "INSUFFICIENT_EVIDENCE", [], T0),
    judgment("judgment-before-2", "claim-before", "CONTRADICTED", [FACT_39.id], "2026-10-01T00:05:00.000Z", "judgment-before-1"),
  ],
  interventions: [intervention],
  reobservations: [
    {
      id: "reobservation-after",
      intervention_id: intervention.id,
      created_at: T1,
      observation: after,
      claims: [claim("claim-after", after.id, "$39/month", T1)],
      judgments: [judgment("judgment-after", "claim-after", "SUPPORTED", [FACT_39.id], T1)],
    },
  ],
  generated_at: GENERATED,
}

const withAfter = (surface: SurfaceIdentityV1, config: KnowledgeJson = directConfig, beforeSurface = directSurface): PacketInput => {
  const b = observation("observation-before", "$29/month", T0, beforeSurface, config)
  const a = observation("observation-after", "$39/month", T1, surface, config)
  const r = base.reobservations[0]!
  return { ...base, original_observation: b, reobservations: [{ ...r, observation: a }] }
}

const routerSurface = (model: string): SurfaceIdentityV1 => surfaceForWorker("9router", model, model)

export const buildPackets = (): Record<string, EvidencePacketV1> => {
  const out: Record<string, EvidencePacketV1> = {}
  const add = (name: string, input: PacketInput) => {
    out[name] = exportEvidencePacket(input)
  }

  // Original answer already agreed with authority; nothing else happened.
  const supported = observation("observation-supported", "$39/month", T0)
  add("complete-supported", {
    ...base,
    id: "packet-claim-supported",
    issue: { id: "claim-supported", type: knownValue("PRICE"), created_at: T0 },
    issue_claim_id: "claim-supported",
    original_observation: supported,
    claims: [claim("claim-supported", supported.id, "$39/month", T0)],
    judgments: [judgment("judgment-supported", "claim-supported", "SUPPORTED", [FACT_39.id], T0)],
    interventions: [],
    reobservations: [],
  })
  add("contradiction-before-intervention", { ...base, interventions: [], reobservations: [] })
  // PART 11 acceptance case.
  add("corrected-reobservation", base)
  add("intervention-not-observed", { ...base, reobservations: [] })
  add("changed-unjudged", { ...base, reobservations: [{ ...base.reobservations[0]!, judgments: [] }] })
  add("unknown-attribution", {
    ...base,
    interventions: [{ ...intervention, actor: "UNKNOWN", actor_id: UNKNOWN, evidence_before_digest: UNKNOWN, evidence_after_digest: UNKNOWN }],
  })
  add("corrective-intervention", {
    ...base,
    interventions: [
      intervention,
      {
        ...intervention,
        id: "intervention-pricing-page-correction",
        type: "STRUCTURED_DATA_UPDATED",
        supersedes_id: intervention.id,
        correction_reason: "The change was to structured data, not page copy.",
        created_at: "2026-10-01T13:00:00.000Z",
      },
    ],
  })
  // PART 12 A: router API / model A before, direct API / model B after.
  add("incomparable-reobservation", withAfter({ ...directSurface, requested_model: knownValue("fixture-model-b"), observed_model: knownValue("fixture-model-b") }, directConfig, routerSurface("router-model-a")))
  // PART 12 B: both sides lack search mode and personalization.
  const hidden = { ...directSurface, search_mode: UNKNOWN, personalization_state: UNKNOWN }
  add("indeterminate-hidden-dimensions", withAfter(hidden, directConfig, hidden))
  // Current 9Router mapping on both sides: search mode stays UNKNOWN.
  const routerConfig = requestConfigurationForWorker("9router", "router-model-a")
  add("router-api-reobservation", withAfter(routerSurface("router-model-a"), routerConfig, routerSurface("router-model-a")))
  // PART 12 E: the authority changed between measurements.
  const old29 = fact("fact-acme-starter-price-v1", 1, "$29/month", "2026-01-01T00:00:00.000Z", T_INTERVENTION, null)
  const new39 = { ...fact("fact-acme-starter-price-v2", 2, "$39/month", T_INTERVENTION, null, old29.id) }
  add("superseded-fact", {
    ...base,
    issue: { ...base.issue, type: knownValue("PRICE") },
    facts: [old29, new39],
    judgments: [judgment("judgment-before", "claim-before", "SUPPORTED", [old29.id], T0)],
    interventions: [],
    reobservations: [{ ...base.reobservations[0]!, intervention_id: null, judgments: [judgment("judgment-after", "claim-after", "SUPPORTED", [new39.id], T1)] }],
  })
  // PART 10: mock surface, visibly synthetic.
  const mockSurface = surfaceForWorker("mock", null, null)
  const mockConfig = requestConfigurationForWorker("mock", null)
  add("mock-synthetic", { ...withAfter(mockSurface, mockConfig, mockSurface), interventions: [], reobservations: [], id: "packet-mock" })
  return out
}

const reseal = (p: Record<string, unknown>) => ({ ...p, packet_digest: packetDigest(p as unknown as EvidencePacketV1) })

export const buildFixtures = (): Record<string, unknown> => {
  const packets = buildPackets()
  const fixtures: Record<string, unknown> = { ...packets }
  const corrected = packets["corrected-reobservation"] as EvidencePacketV1
  const incomparable = packets["incomparable-reobservation"] as EvidencePacketV1
  const mock = packets["mock-synthetic"] as EvidencePacketV1
  // Validly sealed but an unsupported future version.
  fixtures["malformed-future-version"] = reseal({ ...corrected, schema_version: 2 })
  // Required field missing.
  const { business: _business, ...missing } = corrected
  fixtures["malformed-missing-required"] = reseal(missing)
  // Content changed after sealing.
  fixtures["malformed-digest-mismatch"] = { ...corrected, claims: corrected.claims.map((c) => ({ ...c, text: "$39/month" })) }
  // Causal overclaim: an incomparable re-observation relabelled as a correction.
  fixtures["malformed-overclaimed-outcome"] = reseal({
    ...incomparable,
    reobservations: incomparable.reobservations.map((r) => ({ ...r, match_classification: "EXACT_MATCH", outcome: "OBSERVED_CORRECTION" })),
    observed_outcome: "OBSERVED_CORRECTION",
  })
  // Mock evidence presented as production evidence.
  fixtures["malformed-mock-not-synthetic"] = reseal({
    ...mock,
    synthetic: false,
    original_observation: { ...mock.original_observation, synthetic: false },
  })
  return fixtures
}

export const canonicalVectors = () => ({
  accepted: [
    { b: 2, a: [3, { z: null, y: "x" }] },
    { "10": "ten", "2": "two", a: "a", "é": "e-acute", "😀": "emoji", "ﬀ": "ligature", Z: "upper" },
    { numbers: [0, -0, 1, -1, 0.7, 1.5, 100, 1e-7, 0.000001, 123456789012, 9007199254740991, 1.5e-10, 123.456] },
    { text: "tab\tnewline\ncontrol\u0001quote\"backslash\\slash/unicode é \u2028" },
    { nested: { empty_object: {}, empty_array: [], bool: true, nil: null } },
  ].map((input) => {
    const canonical = canonicalJson(input)
    return { input, canonical, sha256: sha256(canonical) }
  }),
  /** Raw JSON texts every V1 canonicalizer must refuse. */
  rejected: ['{"n":1e21}', '{"n":9007199254740993}', '{"s":"\\ud800"}'],
})

export const expectedResults = (fixtures: Record<string, unknown>) =>
  Object.fromEntries(
    Object.keys(fixtures)
      .sort()
      .map((name) => {
        try {
          const p = validatePacket(fixtures[name])
          return [
            name,
            {
              valid: true,
              packet_digest: p.packet_digest,
              synthetic: p.synthetic,
              observed_outcome: p.observed_outcome,
              match_classifications: p.reobservations.map((r) => r.match_classification),
              outcomes: p.reobservations.map((r) => r.outcome),
            },
          ]
        } catch (e) {
          return [name, { valid: false, reason: (e as { reason?: string }).reason ?? "Unknown" }]
        }
      }),
  )
