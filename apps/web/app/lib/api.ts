// Typed API client shared with the backend contract (packages/contracts).
// Most server state comes from these calls; ordinary React state covers UI-local interaction.
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(`${res.status} ${(body as { _tag?: string })._tag ?? "error"} ${JSON.stringify(body).slice(0, 300)}`)
  }
  return (await res.json()) as T
}

export const Auth = {
  me: () => api<{ userId: string; accountId: string }>("/api/auth/me"),
  signup: (email: string, password: string) =>
    api<{ userId: string; accountId: string }>("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  signin: (email: string, password: string) =>
    api<{ userId: string; accountId: string }>("/api/auth/signin", { method: "POST", body: JSON.stringify({ email, password }) }),
  signout: () => api<{ ok: boolean }>("/api/auth/signout", { method: "POST" }),
}

export const Businesses = {
  list: () => api<{ businesses: Array<{ id: string; name: string }> }>("/api/businesses"),
  create: (name: string) =>
    api<{ business: { id: string; name: string } }>("/api/businesses", { method: "POST", body: JSON.stringify({ name }) }),
}

export const Facts = {
  list: (businessId: string) =>
    api<{ facts: Array<{ id: string; subject: string; predicate: string; valueText: string; valueType: string; status: string; version: number; validFrom: string; validUntil: string | null }>; conflicts: Array<{ a: string; b: string }> }>(
      `/api/businesses/${businessId}/facts`,
    ),
  create: (businessId: string, input: Record<string, unknown>) =>
    api(`/api/businesses/${businessId}/facts`, { method: "POST", body: JSON.stringify(input) }),
  supersede: (businessId: string, factId: string, input: Record<string, unknown>) =>
    api(`/api/businesses/${businessId}/facts/${factId}/supersede`, { method: "POST", body: JSON.stringify(input) }),
  retire: (businessId: string, factId: string) =>
    api(`/api/businesses/${businessId}/facts/${factId}/retire`, { method: "POST" }),
}

export const Questions = {
  list: (businessId: string) =>
    api<{ questions: Array<{ id: string; prompt: string; origin: string }> }>(`/api/businesses/${businessId}/questions`),
  create: (businessId: string, prompt: string) =>
    api(`/api/businesses/${businessId}/questions`, { method: "POST", body: JSON.stringify({ prompt, origin: "BUSINESS_OWNER" }) }),
}

export const Checks = {
  list: (businessId: string) =>
    api<{ checkRuns: Array<{ id: string; status: string; provider: string; queuedAt: string; observationId: string | null; questionId: string }> }>(
      `/api/businesses/${businessId}/check-runs`,
    ),
  run: (businessId: string, questionId: string) =>
    api<{ checkRun: { id: string; status: string } }>(`/api/businesses/${businessId}/check-runs`, {
      method: "POST",
      body: JSON.stringify({ questionId, provider: "mock" }),
    }),
}

export const Observations = {
  get: (observationId: string) =>
    api<{ observation: { answer_text: string; provider: string; observed_model: string | null; collected_at: string; retrieval_mode: string } & Record<string, unknown>; claims: Array<{ id: string; text: string }> }>(
      `/api/observations/${observationId}`,
    ),
}

export const Claims = {
  create: (observationId: string, text: string) =>
    api<{ claim: { id: string } }>("/api/claims", { method: "POST", body: JSON.stringify({ observationId, text }) }),
}

export const Judgments = {
  create: (claimId: string, verdict: string, factIds: Array<string>, notes?: string) =>
    api("/api/judgments", { method: "POST", body: JSON.stringify({ claimId, verdict, factIds, notes: notes ?? null }) }),
}

export const Issues = {
  list: (businessId: string) =>
    api<{ issues: Array<{ claim_id: string; claim_text: string; state: string; verdict: string | null; answer_text: string; provider: string; question_prompt: string; facts: Array<{ predicate: string; valueText: string }> }> }>(
      `/api/businesses/${businessId}/issues`,
    ),
  overview: (businessId: string) =>
    api<{ overview: { completed: string; last_checked: string | null; unreviewed: string; needs_attention: string } }>(
      `/api/businesses/${businessId}/overview`,
    ),
}
