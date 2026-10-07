// The one path-containment primitive. Every filesystem mutation OpenRecord
// performs (site checkouts, truth projections, local CLI metadata) resolves
// its target here; an architecture test forbids fs imports anywhere else.
//
// Algorithm (resolveContainedPath):
//   1. Lexically validate the candidate: non-empty relative POSIX path, no
//      NUL/control bytes, no backslashes (so `..\` and mixed separators are
//      impossible), no drive letters, no percent-encoded dot/separator/NUL/%,
//      no empty, `.` or `..` segments.
//   2. realpath() the allowed root (macOS /var -> /private/var etc.).
//   3. Walk the candidate one component at a time with lstat(): any symlink
//      is rejected (inside or outside the root — we never follow), every
//      intermediate component must be a real directory, an existing target
//      must be a regular file with a single link. The walk stops at the
//      first missing component (the deepest existing ancestor).
//   4. Prove containment independently: realpath(deepest existing ancestor)
//      must equal the root or sit strictly inside it, and the joined target
//      must sit strictly inside the root.
//
// Roots: a caller that validated a root once (resolveAllowedRoot) holds a
// PinnedRoot {path, dev, ino}; every later operation re-checks that the
// path is still that same real directory (ROOT_CHANGED otherwise), so a
// checkout swapped for a symlink after validation is refused.
//
// Every open is verified after the fact: the opened inode must be the one
// now reachable at the contained path, under a parent whose realpath is
// inside the root, with a single link. Data is read or written only through
// a verified descriptor, so a parent swapped between check and open cannot
// make OpenRecord read outside bytes or stage data outside the root.
//
// Writes: stage a sibling temp file (O_EXCL|O_NOFOLLOW, verified before any
// byte is written), re-walk the path, hash the current target through a
// held descriptor, rename immediately, then prove the staged inode landed
// at the contained path and that the replaced file was not modified between
// the hash and the rename (lost update -> ConcurrentModification).
//
// Threat model and residuals (documented, not hidden). Protected: untrusted
// path inputs and repository contents (traversal, encodings, symlinks,
// hardlinks, special files, roots outside the tenant's directory). Not
// fully preventable without openat()/renameat(), which Node lacks: a local
// process writing inside the checkout concurrently can (a) make an empty
// temp file or empty directory appear outside the root, or (b) swap a parent
// in the instant between the final walk and rename(). (b) is detected and
// reported as CHANGED_DURING_WRITE, never success, but not undone. Checkouts
// under SITE_OPERATOR_ROOTS must not be written concurrently by others.
import { createHash, randomUUID } from "node:crypto"
import { constants, promises as fs, type Stats } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

export type ContainmentCode =
  | "ROOT_INVALID"
  | "ROOT_UNAVAILABLE"
  | "ROOT_NOT_DIRECTORY"
  | "ROOT_NOT_ALLOWED"
  | "EMPTY_PATH"
  | "PATH_TOO_LONG"
  | "NUL_BYTE"
  | "CONTROL_CHARACTER"
  | "BACKSLASH_SEPARATOR"
  | "ABSOLUTE_PATH"
  | "ENCODED_SEGMENT"
  | "EMPTY_SEGMENT"
  | "DOT_SEGMENT"
  | "TRAVERSAL"
  | "SYMLINK"
  | "NOT_A_DIRECTORY"
  | "NOT_A_REGULAR_FILE"
  | "HARDLINKED_FILE"
  | "PARENT_MISSING"
  | "ESCAPES_ROOT"
  | "CHANGED_DURING_WRITE"
  | "ROOT_CHANGED"
  | "RESERVED_PATH"

export class ContainmentError extends Error {
  readonly _tag = "ContainmentError"
  constructor(
    readonly code: ContainmentCode,
    readonly candidate: string,
  ) {
    super(`ContainmentError: ${code}: ${JSON.stringify(candidate).slice(0, 200)}`)
  }
}

/** The file's current bytes did not hash to what the caller reviewed. */
export class PreconditionFailed extends Error {
  readonly _tag = "PreconditionFailed"
  constructor(
    readonly expectedSha256: string | null,
    readonly actualSha256: string | null,
  ) {
    super(`PreconditionFailed: expected ${expectedSha256 ?? "absent"}, found ${actualSha256 ?? "absent"}`)
  }
}

export const MAX_CANDIDATE_LENGTH = 1024

// %2e '.', %2f '/', %5c '\', %00 NUL, %25 '%' (double encoding).
const ENCODED_UNSAFE = /%(2e|2f|5c|00|25)/i
const CONTROL = /[\u0001-\u001f\u007f]/

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex")

/** Lexical validation only. Returns the path's segments. */
export const validateCandidate = (candidate: unknown): ReadonlyArray<string> => {
  if (typeof candidate !== "string" || candidate.length === 0) throw new ContainmentError("EMPTY_PATH", String(candidate ?? ""))
  if (candidate.length > MAX_CANDIDATE_LENGTH) throw new ContainmentError("PATH_TOO_LONG", candidate)
  if (candidate.includes("\0")) throw new ContainmentError("NUL_BYTE", candidate)
  if (CONTROL.test(candidate)) throw new ContainmentError("CONTROL_CHARACTER", candidate)
  if (candidate.includes("\\")) throw new ContainmentError("BACKSLASH_SEPARATOR", candidate)
  if (candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) throw new ContainmentError("ABSOLUTE_PATH", candidate)
  if (ENCODED_UNSAFE.test(candidate)) throw new ContainmentError("ENCODED_SEGMENT", candidate)
  const segments = candidate.split("/")
  for (const s of segments) {
    if (s === "") throw new ContainmentError("EMPTY_SEGMENT", candidate)
    if (s === ".") throw new ContainmentError("DOT_SEGMENT", candidate)
    if (s === "..") throw new ContainmentError("TRAVERSAL", candidate)
  }
  return segments
}

/** The file changed between the final hash and the rename (lost update). */
export class ConcurrentModification extends Error {
  readonly _tag = "ConcurrentModification"
  constructor(readonly candidate: string) {
    super(`ConcurrentModification: ${JSON.stringify(candidate).slice(0, 200)} changed while it was being replaced`)
  }
}

/**
 * True when any segment, compared case- and Unicode-insensitively (APFS and
 * NTFS treat these spellings as one name), is in `names` (lower-case NFC).
 */
export const hasReservedSegment = (relativePath: string, names: ReadonlyArray<string>): boolean =>
  relativePath.normalize("NFC").toLowerCase().split("/").some((s) => names.includes(s))

/** True when `abs` is strictly beneath `root` (both already absolute). */
export const isStrictlyInside = (root: string, abs: string): boolean => {
  const rel = relative(root, abs)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const isInsideOrEqual = (root: string, abs: string): boolean => abs === root || isStrictlyInside(root, abs)

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

const lstatOrNull = async (p: string): Promise<Stats | null> => {
  try {
    return await fs.lstat(p)
  } catch (e) {
    if (codeOf(e) === "ENOENT") return null
    throw e
  }
}

export interface PinnedRoot {
  /** realpath of the root at pin time. */
  readonly path: string
  readonly dev: number
  readonly ino: number
}

export type RootRef = string | PinnedRoot

/**
 * realpath() an absolute directory root. A PinnedRoot must still be the same
 * real directory (same path, not a symlink, same dev/ino): ROOT_CHANGED.
 */
export const resolveRoot = async (root: RootRef): Promise<string> => {
  if (typeof root !== "string") {
    let st: Stats | null
    let real: string
    try {
      st = await fs.lstat(root.path)
      real = await fs.realpath(root.path)
    } catch {
      throw new ContainmentError("ROOT_CHANGED", root.path)
    }
    if (st.isSymbolicLink() || !st.isDirectory() || real !== root.path || st.dev !== root.dev || st.ino !== root.ino) {
      throw new ContainmentError("ROOT_CHANGED", root.path)
    }
    return root.path
  }
  if (root.length === 0 || root.includes("\0") || !isAbsolute(root)) {
    throw new ContainmentError("ROOT_INVALID", String(root))
  }
  let real: string
  try {
    real = await fs.realpath(root)
  } catch {
    throw new ContainmentError("ROOT_UNAVAILABLE", root)
  }
  const st = await fs.stat(real)
  if (!st.isDirectory()) throw new ContainmentError("ROOT_NOT_DIRECTORY", root)
  return real
}

/** Resolve a root once and pin its identity for later operations. */
export const pinRoot = async (root: string): Promise<PinnedRoot> => {
  const real = await resolveRoot(root)
  const st = await fs.lstat(real)
  return { path: real, dev: st.dev, ino: st.ino }
}

/**
 * Resolve a configured root against an allowlist of roots: the root's
 * realpath must equal or sit inside `<allowed root>/<scope>` for one allowed
 * root, where `scope` is a single path segment owned by the caller (the
 * business id) and `<allowed root>/<scope>` is a real directory, not a
 * symlink. Allowed roots that do not exist are ignored. Returns the pinned
 * real root; later operations refuse it if it has been swapped.
 */
export const resolveAllowedRoot = async (candidateRoot: string, allowedRoots: ReadonlyArray<string>, scope: string): Promise<PinnedRoot> => {
  const scopeSegments = validateCandidate(scope)
  if (scopeSegments.length !== 1) throw new ContainmentError("ROOT_NOT_ALLOWED", candidateRoot)
  const pinned = await pinRoot(candidateRoot)
  for (const allowed of allowedRoots) {
    let allowedReal: string
    try {
      allowedReal = await resolveRoot(allowed)
    } catch {
      continue
    }
    const scoped = join(allowedReal, scope)
    const st = await lstatOrNull(scoped).catch(() => null)
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) continue
    if (isInsideOrEqual(scoped, pinned.path)) return pinned
  }
  throw new ContainmentError("ROOT_NOT_ALLOWED", candidateRoot)
}

export interface ContainedPath {
  /** realpath of the allowed root. */
  readonly root: string
  /** The validated relative POSIX path. */
  readonly relative: string
  readonly segments: ReadonlyArray<string>
  readonly absolute: string
  /** Whether the target file exists now. */
  readonly exists: boolean
  /** Index of the first missing segment (segments.length when it exists). */
  readonly missingFrom: number
}

const walkError = (e: unknown, candidate: string): unknown => {
  const code = codeOf(e)
  if (code === "ENOTDIR") return new ContainmentError("NOT_A_DIRECTORY", candidate)
  if (code === "ENAMETOOLONG") return new ContainmentError("PATH_TOO_LONG", candidate)
  return e
}

export const resolveContainedPath = async (root: RootRef, candidate: string): Promise<ContainedPath> => {
  const segments = validateCandidate(candidate)
  const realRoot = await resolveRoot(root)
  let cursor = realRoot
  let missingFrom = segments.length
  for (let i = 0; i < segments.length; i++) {
    const next = join(cursor, segments[i]!)
    let st: Stats | null
    try {
      st = await lstatOrNull(next)
    } catch (e) {
      throw walkError(e, candidate)
    }
    if (st === null) {
      missingFrom = i
      break
    }
    if (st.isSymbolicLink()) throw new ContainmentError("SYMLINK", candidate)
    const last = i === segments.length - 1
    if (!last && !st.isDirectory()) throw new ContainmentError("NOT_A_DIRECTORY", candidate)
    if (last) {
      if (!st.isFile()) throw new ContainmentError("NOT_A_REGULAR_FILE", candidate)
      if (st.nlink > 1) throw new ContainmentError("HARDLINKED_FILE", candidate)
    }
    cursor = next
  }
  // Independent proof, not derived from the walk above.
  const realAncestor = await fs.realpath(cursor)
  if (!isInsideOrEqual(realRoot, realAncestor)) throw new ContainmentError("ESCAPES_ROOT", candidate)
  const absolute = join(realRoot, ...segments)
  if (!isStrictlyInside(realRoot, absolute)) throw new ContainmentError("ESCAPES_ROOT", candidate)
  return { root: realRoot, relative: segments.join("/"), segments, absolute, exists: missingFrom === segments.length, missingFrom }
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const O_NONBLOCK = constants.O_NONBLOCK ?? 0

/**
 * Prove an open descriptor refers to the inode now reachable at `abs`,
 * under a parent whose realpath is inside `realRoot`, with a single link.
 */
const verifyLanded = async (realRoot: string, abs: string, fdStat: Stats, candidate: string): Promise<void> => {
  let atPath: Stats
  let realParent: string
  try {
    atPath = await fs.lstat(abs)
    realParent = await fs.realpath(dirname(abs))
  } catch {
    throw new ContainmentError("CHANGED_DURING_WRITE", candidate)
  }
  if (atPath.isSymbolicLink() || atPath.ino !== fdStat.ino || atPath.dev !== fdStat.dev || !isInsideOrEqual(realRoot, realParent)) {
    throw new ContainmentError("CHANGED_DURING_WRITE", candidate)
  }
  if (fdStat.nlink > 1) throw new ContainmentError("HARDLINKED_FILE", candidate)
}

/** Open a contained regular file read-only and verify the descriptor. */
const openVerified = async (path: ContainedPath, candidate: string): Promise<fs.FileHandle> => {
  let handle: fs.FileHandle
  try {
    // O_NONBLOCK: a FIFO swapped in after the walk cannot hang the open.
    handle = await fs.open(path.absolute, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (e) {
    if (codeOf(e) === "ELOOP") throw new ContainmentError("SYMLINK", candidate)
    if (codeOf(e) === "ENOENT") throw new ContainmentError("CHANGED_DURING_WRITE", candidate)
    throw e
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) throw new ContainmentError("NOT_A_REGULAR_FILE", candidate)
    await verifyLanded(path.root, path.absolute, st, candidate)
    return handle
  } catch (e) {
    await handle.close()
    throw e
  }
}

const readVerified = async (path: ContainedPath, candidate: string): Promise<Uint8Array> => {
  const handle = await openVerified(path, candidate)
  try {
    return new Uint8Array(await handle.readFile())
  } finally {
    await handle.close()
  }
}

/** Kind of an entry inside the root, without following symlinks. */
export const containedEntryKind = async (root: RootRef, candidate: string): Promise<"FILE" | "DIRECTORY" | "MISSING" | "OTHER"> => {
  const segments = validateCandidate(candidate)
  const realRoot = await resolveRoot(root)
  let cursor = realRoot
  for (let i = 0; i < segments.length; i++) {
    cursor = join(cursor, segments[i]!)
    const st = await lstatOrNull(cursor).catch((e) => {
      if (codeOf(e) === "ENOTDIR") return null
      throw walkError(e, candidate)
    })
    if (st === null) return "MISSING"
    if (st.isSymbolicLink()) throw new ContainmentError("SYMLINK", candidate)
    const last = i === segments.length - 1
    if (!last && !st.isDirectory()) return "MISSING"
    if (last) return st.isFile() ? "FILE" : st.isDirectory() ? "DIRECTORY" : "OTHER"
  }
  return "MISSING"
}

export interface ContainedReadOptions {
  /** Test seam: awaited after resolution, before the descriptor is opened. */
  readonly onResolved?: () => Promise<void>
}

/** Read a contained regular file; null when it does not exist. */
export const readContainedFile = async (
  root: RootRef,
  candidate: string,
  options: ContainedReadOptions = {},
): Promise<{ path: ContainedPath; bytes: Uint8Array } | null> => {
  const path = await resolveContainedPath(root, candidate)
  if (!path.exists) return null
  if (options.onResolved) await options.onResolved()
  return { path, bytes: await readVerified(path, candidate) }
}

export type WriteStage = "prepared" | "opened" | "staged" | "checked" | "renamed"

export interface ContainedWriteOptions {
  /**
   * Precondition on the current bytes: a sha256 hex the file must hash to,
   * `null` when the file must not exist, or omitted for no precondition.
   */
  readonly expectedBeforeSha256?: string | null
  /** Create missing parent directories (one real directory at a time). */
  readonly createParents?: boolean
  /**
   * Test seam, awaited at each stage: "prepared" (before the temp file is
   * created), "opened" (temp created and verified, nothing written), "staged" (temp written), "checked" (final hash taken, rename
   * next), "renamed" (before read-back).
   */
  readonly onStage?: (stage: WriteStage) => Promise<void>
}

export interface ContainedWriteResult {
  readonly path: ContainedPath
  readonly beforeSha256: string | null
  /** Hash of the bytes read back from the target after the rename. */
  readonly afterSha256: string
}

const checkPrecondition = (options: ContainedWriteOptions, actual: string | null): void => {
  if (options.expectedBeforeSha256 === undefined) return
  if (options.expectedBeforeSha256 !== actual) throw new PreconditionFailed(options.expectedBeforeSha256, actual)
}

/** Unlink our temp file only if the path still names our inode inside the root. */
const unlinkOwnTemp = async (realRoot: string, tmp: string, staged: Stats | null): Promise<void> => {
  if (staged === null) return
  try {
    const st = await fs.lstat(tmp)
    const parent = await fs.realpath(dirname(tmp))
    if (st.isSymbolicLink() || st.ino !== staged.ino || st.dev !== staged.dev || !isInsideOrEqual(realRoot, parent)) return
    await fs.unlink(tmp)
  } catch {
    // Leave it: never unlink something we cannot prove is ours.
  }
}

/**
 * Atomically replace (or create) a contained file. Nothing is written to
 * the target unless containment and the precondition hold at the last
 * check before the rename.
 */
export const writeContainedFile = async (
  root: RootRef,
  candidate: string,
  bytes: Uint8Array | string,
  options: ContainedWriteOptions = {},
): Promise<ContainedWriteResult> => {
  const stage = async (s: WriteStage) => {
    if (options.onStage) await options.onStage(s)
  }
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  const first = await resolveContainedPath(root, candidate)
  const before = first.exists ? sha256Hex(await readVerified(first, candidate)) : null
  checkPrecondition(options, before)
  const parentIndex = first.segments.length - 1
  if (first.missingFrom < parentIndex) {
    if (!options.createParents) throw new ContainmentError("PARENT_MISSING", candidate)
    for (let i = first.missingFrom; i < parentIndex; i++) {
      const dir = join(first.root, ...first.segments.slice(0, i + 1))
      try {
        await fs.mkdir(dir)
      } catch (e) {
        if (codeOf(e) !== "EEXIST") throw e
      }
      const st = await fs.lstat(dir)
      if (st.isSymbolicLink()) throw new ContainmentError("SYMLINK", candidate)
      if (!st.isDirectory()) throw new ContainmentError("NOT_A_DIRECTORY", candidate)
      if (!isStrictlyInside(first.root, await fs.realpath(dir))) throw new ContainmentError("CHANGED_DURING_WRITE", candidate)
    }
  }
  const mode = first.exists ? (await fs.lstat(first.absolute)).mode & 0o777 : 0o644
  const tmp = join(dirname(first.absolute), `.openrecord-tmp-${randomUUID()}`)
  let staged: Stats | null = null
  let renamed = false
  try {
    await stage("prepared")
    const handle = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, mode)
    try {
      staged = await handle.stat()
      // Prove the new inode is inside the root before writing any byte.
      await verifyLanded(first.root, tmp, staged, candidate)
      await stage("opened")
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await stage("staged")
    // Final checks: walk, then hash through a held descriptor, then rename
    // with no other awaited work in between.
    const second = await resolveContainedPath(root, candidate)
    if (second.root !== first.root || second.absolute !== first.absolute) {
      throw new ContainmentError("CHANGED_DURING_WRITE", candidate)
    }
    const held = second.exists ? await openVerified(second, candidate) : null
    try {
      const heldBefore = held === null ? null : await held.stat({ bigint: true })
      const current = held === null ? null : sha256Hex(new Uint8Array(await held.readFile()))
      checkPrecondition(options, current)
      await stage("checked")
      await fs.rename(tmp, second.absolute)
      renamed = true
      // Lost update: the replaced inode was modified after we hashed it.
      if (held !== null && heldBefore !== null) {
        const heldAfter = await held.stat({ bigint: true })
        if (heldAfter.mtimeNs !== heldBefore.mtimeNs || heldAfter.size !== heldBefore.size) throw new ConcurrentModification(candidate)
      }
    } finally {
      await held?.close()
    }
    await stage("renamed")
    // The staged inode must now be the file at the contained path.
    const landed = await openVerified(second, candidate)
    let after: string
    try {
      const st = await landed.stat()
      if (st.ino !== staged.ino || st.dev !== staged.dev) throw new ContainmentError("CHANGED_DURING_WRITE", candidate)
      after = sha256Hex(new Uint8Array(await landed.readFile()))
    } finally {
      await landed.close()
    }
    return { path: { ...second, exists: true, missingFrom: second.segments.length }, beforeSha256: before, afterSha256: after }
  } finally {
    if (!renamed) await unlinkOwnTemp(first.root, tmp, staged)
  }
}
