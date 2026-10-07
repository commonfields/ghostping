// Local working-tree IO for the truth CLI: projection outputs, the
// projections lock and append-only receipts, all through the shared
// containment primitive (never direct fs).
import { readContainedFile, writeContainedFile } from "@openrecord/fs-containment"
import type { ApplyIo } from "./apply.js"
import { EMPTY_LOCK, type ProjectionLock } from "./plan.js"

export const readLock = async (root: string): Promise<ProjectionLock> => {
  // Missing lock means a fresh root: nothing is managed yet. Any other read
  // failure (including a containment rejection) leaves lock state unknown,
  // so it throws and the apply fails closed.
  const lock = await readContainedFile(root, ".openrecord/projections.lock.json")
  if (lock === null) return EMPTY_LOCK
  const parsed: unknown = JSON.parse(new TextDecoder().decode(lock.bytes))
  if (parsed !== null && typeof parsed === "object" && "projections" in parsed) {
    return parsed as ProjectionLock
  }
  throw new Error("projections.lock.json has invalid shape; refusing to apply with unknown lock state")
}

export const fileIo = (root: string): ApplyIo => ({
  root,
  read: async (rel) => (await readContainedFile(root, rel))?.bytes ?? null,
  readLock: () => readLock(root),
  writeLock: async (lock) => {
    await writeContainedFile(root, ".openrecord/projections.lock.json", `${JSON.stringify(lock, null, 2)}\n`, { createParents: true })
  },
  appendReceipt: async (receipt) => {
    // Receipts are append-only: the file must not exist yet.
    await writeContainedFile(root, `.openrecord/receipts/${receipt.id}.json`, `${JSON.stringify(receipt, null, 2)}\n`, { createParents: true, expectedBeforeSha256: null })
  },
})
