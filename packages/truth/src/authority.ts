// Authority writer invariant: one business -> one active writer.
// Existing businesses default to HOSTED (absent row). Repository sync sets
// REPOSITORY_MANIFEST only on empty businesses; modes never change after
// facts exist. No UI switching in V1.

export const AUTHORITY_MODES = ["HOSTED", "REPOSITORY_MANIFEST"] as const
export type AuthorityWriter = (typeof AUTHORITY_MODES)[number]

export class AuthorityError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail === undefined ? `AuthorityError: ${code}` : `AuthorityError: ${code}: ${detail}`)
  }
}

export interface AuthorityStore {
  /** Null = no row yet (legacy: behaves as HOSTED). */
  mode(businessId: string): Promise<AuthorityWriter | null>
  factCount(businessId: string): Promise<number>
  setMode(businessId: string, mode: AuthorityWriter): Promise<void>
}

/** Guard a direct hosted fact mutation. Throws when repository-managed. */
export const guardHostedMutation = async (store: AuthorityStore, businessId: string, op: string): Promise<void> => {
  const mode = await store.mode(businessId)
  if (mode === "REPOSITORY_MANIFEST") {
    throw new AuthorityError("FactAuthorityManagedByRepository", `${op} ${businessId}`)
  }
}

/** Guard a manifest sync. Throws when hosted-managed. */
export const guardManifestSync = async (store: AuthorityStore, businessId: string): Promise<AuthorityWriter> => {
  const mode = await store.mode(businessId)
  if (mode === "HOSTED") throw new AuthorityError("ManifestSyncRejectedForHosted", businessId)
  if (mode === null) {
    // Legacy business: only an empty one may become repository-managed.
    // Anything with facts stays HOSTED and must never silently change.
    const count = await store.factCount(businessId)
    if (count > 0) throw new AuthorityError("ManifestSyncRejectedForHosted", `${businessId} has ${count} facts`)
    await store.setMode(businessId, "REPOSITORY_MANIFEST")
    return "REPOSITORY_MANIFEST"
  }
  return mode
}

/** Mode transitions are prohibited once facts exist. */
export const guardModeTransition = async (store: AuthorityStore, businessId: string, next: AuthorityWriter): Promise<void> => {
  const current = (await store.mode(businessId)) ?? "HOSTED"
  if (current === next) return
  const count = await store.factCount(businessId)
  if (count > 0) throw new AuthorityError("AuthorityModeImmutable", `${businessId} has ${count} facts`)
  await store.setMode(businessId, next)
}
