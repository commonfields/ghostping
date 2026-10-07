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
// Writes (writeContainedFile) repeat the whole resolution and the before-
// hash precondition immediately before an atomic rename of a sibling temp
// file created with O_EXCL|O_NOFOLLOW; reads open with O_NOFOLLOW.
//
// Residual race (documented, not hidden): Node has no openat()/renameat(),
// so an actor that can write inside the checkout concurrently could swap a
// parent directory for a symlink in the instant between the final re-check
// and rename(). That requires local write access to the checkout itself;
// the write then reports CHANGED_DURING_WRITE (post-rename inode/parent
// check) rather than success, but the escaped rename is not undone.
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

/** realpath() an absolute directory root. */
export const resolveRoot = async (root: string): Promise<string> => {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0") || !isAbsolute(root)) {
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

/**
 * Resolve a configured root against an allowlist of roots: the root's
 * realpath must equal or sit inside `<allowed root>/<scope>` for one allowed
 * root, where `scope` is a single path segment owned by the caller (the
 * business id) and `<allowed root>/<scope>` is a real directory, not a
 * symlink. Allowed roots that do not exist are ignored. Returns the real root.
 */
export const resolveAllowedRoot = async (candidateRoot: string, allowedRoots: ReadonlyArray<string>, scope: string): Promise<string> => {
  const scopeSegments = validateCandidate(scope)
  if (scopeSegments.length !== 1) throw new ContainmentError("ROOT_NOT_ALLOWED", candidateRoot)
  const real = await resolveRoot(candidateRoot)
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
    if (isInsideOrEqual(scoped, real)) return real
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

export const resolveContainedPath = async (root: string, candidate: string): Promise<ContainedPath> => {
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
      if (codeOf(e) === "ENOTDIR") throw new ContainmentError("NOT_A_DIRECTORY", candidate)
      throw e
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

const readNoFollow = async (abs: string, candidate: string): Promise<Uint8Array> => {
  let handle: fs.FileHandle
  try {
    // O_NONBLOCK: a FIFO swapped in after the walk cannot hang the read.
    handle = await fs.open(abs, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (e) {
    if (codeOf(e) === "ELOOP") throw new ContainmentError("SYMLINK", candidate)
    throw e
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) throw new ContainmentError("NOT_A_REGULAR_FILE", candidate)
    if (st.nlink > 1) throw new ContainmentError("HARDLINKED_FILE", candidate)
    return new Uint8Array(await handle.readFile())
  } finally {
    await handle.close()
  }
}

/** Kind of an entry inside the root, without following symlinks. */
export const containedEntryKind = async (root: string, candidate: string): Promise<"FILE" | "DIRECTORY" | "MISSING" | "OTHER"> => {
  const segments = validateCandidate(candidate)
  const realRoot = await resolveRoot(root)
  let cursor = realRoot
  for (let i = 0; i < segments.length; i++) {
    cursor = join(cursor, segments[i]!)
    const st = await lstatOrNull(cursor).catch((e) => {
      if (codeOf(e) === "ENOTDIR") return null
      throw e
    })
    if (st === null) return "MISSING"
    if (st.isSymbolicLink()) throw new ContainmentError("SYMLINK", candidate)
    const last = i === segments.length - 1
    if (!last && !st.isDirectory()) return "MISSING"
    if (last) return st.isFile() ? "FILE" : st.isDirectory() ? "DIRECTORY" : "OTHER"
  }
  return "MISSING"
}

/** Read a contained regular file; null when it does not exist. */
export const readContainedFile = async (root: string, candidate: string): Promise<{ path: ContainedPath; bytes: Uint8Array } | null> => {
  const path = await resolveContainedPath(root, candidate)
  if (!path.exists) return null
  return { path, bytes: await readNoFollow(path.absolute, candidate) }
}

export interface ContainedWriteOptions {
  /**
   * Precondition on the current bytes: a sha256 hex the file must hash to,
   * `null` when the file must not exist, or omitted for no precondition.
   */
  readonly expectedBeforeSha256?: string | null
  /** Create missing parent directories (one real directory at a time). */
  readonly createParents?: boolean
  /**
   * Test seam: awaited after the temp file is staged and before the final
   * re-checks, so tests can mutate the tree at the last observable point.
   */
  readonly onStaged?: () => Promise<void>
}

export interface ContainedWriteResult {
  readonly path: ContainedPath
  readonly beforeSha256: string | null
  /** Hash of the bytes read back from the target after the rename. */
  readonly afterSha256: string
}

const currentSha = async (p: ContainedPath, candidate: string): Promise<string | null> =>
  p.exists ? sha256Hex(await readNoFollow(p.absolute, candidate)) : null

const checkPrecondition = (options: ContainedWriteOptions, actual: string | null): void => {
  if (options.expectedBeforeSha256 === undefined) return
  if (options.expectedBeforeSha256 !== actual) throw new PreconditionFailed(options.expectedBeforeSha256, actual)
}

/**
 * Atomically replace (or create) a contained file. Nothing is written when
 * containment or the precondition fails, before or after staging.
 */
export const writeContainedFile = async (
  root: string,
  candidate: string,
  bytes: Uint8Array | string,
  options: ContainedWriteOptions = {},
): Promise<ContainedWriteResult> => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  const first = await resolveContainedPath(root, candidate)
  const before = await currentSha(first, candidate)
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
    }
  }
  const mode = first.exists ? (await fs.lstat(first.absolute)).mode & 0o777 : 0o644
  const tmp = join(dirname(first.absolute), `.openrecord-tmp-${randomUUID()}`)
  const handle = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, mode)
  let renamed = false
  let staged: Stats
  try {
    try {
      await handle.writeFile(data)
      await handle.sync()
      staged = await handle.stat()
    } finally {
      await handle.close()
    }
    if (options.onStaged) await options.onStaged()
    // Immediately before mutation: the precondition, then containment, then
    // rename with no other awaited work in between.
    const preCheck = await resolveContainedPath(root, candidate)
    checkPrecondition(options, await currentSha(preCheck, candidate))
    const second = await resolveContainedPath(root, candidate)
    if (second.root !== first.root || second.absolute !== first.absolute) {
      throw new ContainmentError("CHANGED_DURING_WRITE", candidate)
    }
    await fs.rename(tmp, second.absolute)
    renamed = true
    // Detect (cannot prevent, see header) a parent swapped between the final
    // check and rename: the staged inode must now live at the contained path.
    const landed = await fs.lstat(second.absolute)
    const realParent = await fs.realpath(dirname(second.absolute))
    if (landed.ino !== staged.ino || landed.dev !== staged.dev || !isInsideOrEqual(second.root, realParent)) {
      throw new ContainmentError("CHANGED_DURING_WRITE", candidate)
    }
    const after = sha256Hex(await readNoFollow(second.absolute, candidate))
    return { path: { ...second, exists: true, missingFrom: second.segments.length }, beforeSha256: before, afterSha256: after }
  } finally {
    if (!renamed) await fs.unlink(tmp).catch(() => undefined)
  }
}
