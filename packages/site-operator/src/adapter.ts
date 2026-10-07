// SiteAdapter boundary: domain owns Finding -> FixProposal -> Approval ->
// Mutation -> Verification. Adapters implement the mechanics per platform.
// V1 ships a local-filesystem adapter (deterministic demo/tests) and a
// git-checkout adapter that stages the change inside an existing checkout.
// Hosted sources never shell out (architecture guard): commits and pull
// requests are created with normal git tooling by the operator (or CI) and
// their identity is recorded back via the mutation identity endpoint, so a
// merge is always observed, never performed by OpenRecord. WordPress/Shopify/
// Webflow/Squarespace/Wix adapters plug in later without domain changes.
import { readFile, writeFile, mkdir, stat } from "node:fs/promises"
import { join, dirname } from "node:path"
import { buildPatch, removeNoindexFromHtml } from "./fixes.js"

export type AdapterKind = "LOCAL_FILE" | "GIT" | "GITHUB"

export interface MutationInput {
  readonly filePath: string
  readonly before: string
  readonly after: string
  readonly message: string
}

export interface MutationResult {
  readonly branch: string | null
  readonly commitSha: string | null
  readonly prNumber: number | null
  readonly prUrl: string | null
  readonly detail: string
}

export interface SiteAdapter {
  readonly kind: AdapterKind
  inspect(args: { rootDir: string; filePath: string }): Promise<string | null>
  prepareMutation(args: { rootDir: string; input: MutationInput }): Promise<{ patch: string; before: string; after: string }>
  applyMutation(args: { rootDir: string; input: MutationInput; branch?: string }): Promise<MutationResult>
  verifyMutation(args: { rootDir: string; filePath: string; absent: string }): Promise<boolean>
}

const readIfExists = async (abs: string): Promise<string | null> => {
  try {
    return await readFile(abs, "utf8")
  } catch {
    return null
  }
}

/** Deterministic adapter over a local directory (tests + acceptance demo). */
export const LocalFileSiteAdapter: SiteAdapter = {
  kind: "LOCAL_FILE",
  async inspect({ rootDir, filePath }) {
    return readIfExists(join(rootDir, filePath))
  },
  async prepareMutation({ input }) {
    return { patch: buildPatch(input.filePath, input.before, input.after), before: input.before, after: input.after }
  },
  async applyMutation({ rootDir, input }) {
    const abs = join(rootDir, input.filePath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.after, "utf8")
    return { branch: null, commitSha: null, prNumber: null, prUrl: null, detail: `wrote ${input.filePath} in ${rootDir}` }
  },
  async verifyMutation({ rootDir, filePath, absent }) {
    const content = await readIfExists(join(rootDir, filePath))
    if (content === null) return false
    return !content.includes(absent)
  },
}

const isGitCheckout = async (rootDir: string): Promise<boolean> => {
  try {
    const st = await stat(join(rootDir, ".git"))
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

/**
 * Git-checkout adapter: stages the patched file inside an existing git
 * checkout and names the branch the operator should commit on. It never
 * commits, never pushes, never merges: the commit/PR identity is observed
 * later (mutation identity endpoint) once the operator creates it with
 * normal git tooling. Outside a git checkout it fails closed with
 * ADAPTER_FAILURE semantics (never a fake success).
 */
export const GitSiteAdapter: SiteAdapter = {
  kind: "GIT",
  async inspect({ rootDir, filePath }) {
    return readIfExists(join(rootDir, filePath))
  },
  async prepareMutation({ input }) {
    return { patch: buildPatch(input.filePath, input.before, input.after), before: input.before, after: input.after }
  },
  async applyMutation({ rootDir, input, branch }) {
    if (!(await isGitCheckout(rootDir))) {
      throw new Error("ADAPTER_FAILURE: target directory is not a git checkout")
    }
    const abs = join(rootDir, input.filePath)
    const current = await readIfExists(abs)
    if (current === null) throw new Error("ADAPTER_FAILURE: source file not found; refusing to guess")
    if (current !== input.before) {
      throw new Error("ADAPTER_FAILURE: source file changed since inspection; refusing to overwrite")
    }
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.after, "utf8")
    const name = branch ?? `openrecord/fix-${Date.now()}`
    return { branch: name, commitSha: null, prNumber: null, prUrl: null, detail: `staged ${input.filePath} in ${rootDir} for branch ${name}; commit and open a PR with normal git tooling, then record the identity` }
  },
  async verifyMutation({ rootDir, filePath, absent }) {
    const content = await readIfExists(join(rootDir, filePath))
    if (content === null) return false
    return !content.includes(absent)
  },
}

/** Map a noindex finding to a file mutation where the source is known. */
export const noindexMutationForHtml = (
  filePath: string,
  htmlBefore: string,
): { before: string; after: string; patch: string } | null => {
  const after = removeNoindexFromHtml(htmlBefore)
  if (after === null || after === htmlBefore) return null
  return { before: htmlBefore, after, patch: buildPatch(filePath, htmlBefore, after) }
}
