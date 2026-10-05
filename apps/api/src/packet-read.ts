// Evidence packet read model: one issue's sealed V1 packet as JSON, plus the
// controlled-language rendering. Read-only and account-scoped through the
// lineage repository, and deliberately derivation-free: `exportIssuePacket`
// already re-derives and fail-closed validates the packet (schema -> digest ->
// references -> linearity -> full re-derivation), so this module only hands
// the sealed result to the route. `signatures` stays the V1 [] and the digest
// is the canonical-JSON seal the client can recompute from `packet`.
import { Effect } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import {
  EvidenceLineageRepository,
  exportIssuePacket,
  type EvidenceExportError,
  type RowDecodeError,
} from "@ghostping/db"
import { renderEvidencePacket, type EvidencePacketV1 } from "@ghostping/protocol"

export interface IssuePacket {
  readonly packet: EvidencePacketV1
  /** SHA-256 over canonical packet bytes; identical to `packet.packet_digest`. */
  readonly digest: string
  /** Controlled-language narrative of the same packet (never new claims). */
  readonly rendered: string
}

/**
 * Sealed packet for one issue, or null when the issue is unknown to this
 * account/business (the lineage load scopes tenant -> business -> issue), so
 * callers answer 404 without leaking existence. `generatedAt` is part of the
 * packet bytes: pinning it reproduces an identical digest for the same stored
 * state.
 */
export const loadIssuePacket = (
  accountId: string,
  businessId: string,
  issueId: string,
  generatedAt: string,
): Effect.Effect<
  IssuePacket | null,
  SqlError | RowDecodeError | EvidenceExportError,
  EvidenceLineageRepository
> =>
  Effect.gen(function*() {
    const packet = yield* exportIssuePacket({ accountId, businessId, issueId, generatedAt })
    if (packet === null) return null
    return { packet, digest: packet.packet_digest, rendered: renderEvidencePacket(packet) }
  })
