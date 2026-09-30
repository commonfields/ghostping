// Shared demo seed constants: fictional Northstar Software.
export const NORTHSTAR_FACTS = [
  {
    subject: "northstar",
    predicate: "monthly_price",
    valueText: "$39",
    valueType: "CURRENCY" as const,
    sourceKind: "MANUAL" as const,
    validFrom: "2026-01-01T00:00:00Z",
  },
  {
    subject: "northstar",
    predicate: "salesforce_integration",
    valueText: "false",
    valueType: "BOOLEAN" as const,
    sourceKind: "MANUAL" as const,
    validFrom: "2026-01-01T00:00:00Z",
  },
  {
    subject: "northstar",
    predicate: "cancellation_period",
    valueText: "24 hours",
    valueType: "TEXT" as const,
    sourceKind: "MANUAL" as const,
    validFrom: "2026-01-01T00:00:00Z",
  },
] as const

export const NORTHSTAR_QUESTIONS = [
  { prompt: "How much does Northstar cost?", origin: "BUSINESS_OWNER" as const },
  { prompt: "Does Northstar integrate with Salesforce?", origin: "BUSINESS_OWNER" as const },
  { prompt: "What is Northstar's cancellation policy?", origin: "BUSINESS_OWNER" as const },
] as const
