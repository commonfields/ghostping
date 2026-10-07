// Adversarial containment tests: every escape class named by the security
// phase, plus property tests that throw random traversal/encoding/symlink
// compositions at the primitive and prove nothing outside the root changes.
import { describe, expect, it } from "vitest"
import { FastCheck as fc } from "effect"
import { execFileSync } from "node:child_process"
import {
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ConcurrentModification,
  ContainmentError,
  PreconditionFailed,
  containedEntryKind,
  hasReservedSegment,
  pinRoot,
  readContainedFile,
  resolveAllowedRoot,
  resolveContainedPath,
  sha256Hex,
  validateCandidate,
  writeContainedFile,
  type ContainmentCode,
} from "../src/index.js"

const layout = () => {
  const base = mkdtempSync(join(tmpdir(), "or-contain-"))
  const root = join(base, "root")
  const outside = join(base, "outside")
  mkdirSync(join(root, "pages"), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, "index.html"), "<p>in</p>")
  writeFileSync(join(root, "pages", "a.html"), "<p>a</p>")
  writeFileSync(join(outside, "secret.txt"), "secret")
  symlinkSync(outside, join(root, "dirlink"))
  symlinkSync(join(outside, "secret.txt"), join(root, "filelink.html"))
  symlinkSync(join(root, "index.html"), join(root, "innerlink.html"))
  return { base, root, outside }
}

const outsideSnapshot = (outside: string) =>
  readdirSync(outside).sort().map((f) => `${f}:${readFileSync(join(outside, f), "utf8")}`).join("|")

const rejects = async (p: Promise<unknown>, code: ContainmentCode) => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e, `expected ${code}`).toBeInstanceOf(ContainmentError)
  expect((e as ContainmentError).code).toBe(code)
}

describe("lexical rejection", () => {
  const cases: Array<[string, ContainmentCode]> = [
    ["", "EMPTY_PATH"],
    ["../outside/secret.txt", "TRAVERSAL"],
    ["pages/../../outside/secret.txt", "TRAVERSAL"],
    ["pages/a/../../../x", "TRAVERSAL"],
    ["..", "TRAVERSAL"],
    ["..\\outside\\secret.txt", "BACKSLASH_SEPARATOR"],
    ["pages/..\\..\\outside", "BACKSLASH_SEPARATOR"],
    ["pages\\a.html", "BACKSLASH_SEPARATOR"],
    ["/etc/passwd", "ABSOLUTE_PATH"],
    ["C:/Windows/win.ini", "ABSOLUTE_PATH"],
    ["c:evil", "ABSOLUTE_PATH"],
    ["%2e%2e/outside/secret.txt", "ENCODED_SEGMENT"],
    ["%2E%2E%2Foutside", "ENCODED_SEGMENT"],
    ["pages%2f..%2f..%2fx", "ENCODED_SEGMENT"],
    ["%252e%252e/x", "ENCODED_SEGMENT"],
    ["..%5coutside", "ENCODED_SEGMENT"],
    ["index.html%00.txt", "ENCODED_SEGMENT"],
    ["index.html\0.txt", "NUL_BYTE"],
    ["index\n.html", "CONTROL_CHARACTER"],
    ["pages//a.html", "EMPTY_SEGMENT"],
    ["pages/", "EMPTY_SEGMENT"],
    ["./index.html", "DOT_SEGMENT"],
    ["a".repeat(1025), "PATH_TOO_LONG"],
  ]
  for (const [candidate, code] of cases) {
    it(`rejects ${JSON.stringify(candidate.slice(0, 40))} as ${code}`, async () => {
      expect(() => validateCandidate(candidate)).toThrowError(ContainmentError)
      const { root } = layout()
      await rejects(resolveContainedPath(root, candidate), code)
    })
  }

  it("rejects non-string candidates", () => {
    expect(() => validateCandidate(undefined)).toThrowError(/EMPTY_PATH/)
    expect(() => validateCandidate(42)).toThrowError(/EMPTY_PATH/)
  })

  it("accepts ordinary names that merely contain dots or percent signs", async () => {
    const { root } = layout()
    for (const ok of ["...", "..foo", "foo..", "a.b.c", "100%.html", "%41.html"]) {
      const p = await resolveContainedPath(root, ok)
      expect(p.exists).toBe(false)
      expect(p.absolute.startsWith(p.root)).toBe(true)
    }
  })
})

describe("filesystem rejection", () => {
  it("rejects a symlinked parent directory that escapes the root", async () => {
    const { root, outside } = layout()
    await rejects(resolveContainedPath(root, "dirlink/secret.txt"), "SYMLINK")
    await rejects(writeContainedFile(root, "dirlink/secret.txt", "pwned"), "SYMLINK")
    await rejects(writeContainedFile(root, "dirlink/new.txt", "pwned", { createParents: true }), "SYMLINK")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret")
    expect(readdirSync(outside)).toEqual(["secret.txt"])
  })

  it("rejects a symlinked target file that escapes the root (read and write)", async () => {
    const { root, outside } = layout()
    await rejects(readContainedFile(root, "filelink.html"), "SYMLINK")
    await rejects(writeContainedFile(root, "filelink.html", "pwned"), "SYMLINK")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret")
  })

  it("rejects symlinks even when they point inside the root (never followed)", async () => {
    const { root } = layout()
    await rejects(resolveContainedPath(root, "innerlink.html"), "SYMLINK")
  })

  it("rejects a hardlink to a file outside the root", async () => {
    const { root, outside } = layout()
    linkSync(join(outside, "secret.txt"), join(root, "hard.html"))
    await rejects(readContainedFile(root, "hard.html"), "HARDLINKED_FILE")
    await rejects(writeContainedFile(root, "hard.html", "pwned"), "HARDLINKED_FILE")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret")
  })

  it("rejects a file used as a directory and a directory used as a file", async () => {
    const { root } = layout()
    await rejects(resolveContainedPath(root, "index.html/x"), "NOT_A_DIRECTORY")
    await rejects(resolveContainedPath(root, "pages"), "NOT_A_REGULAR_FILE")
  })

  it("resolves a symlinked root to its real path and still contains", async () => {
    const { base, root } = layout()
    symlinkSync(root, join(base, "rootlink"))
    const p = await resolveContainedPath(join(base, "rootlink"), "index.html")
    expect(p.root).toBe(realpathSync(root))
    expect(p.exists).toBe(true)
  })

  it("rejects unusable roots", async () => {
    const { root } = layout()
    await rejects(resolveContainedPath("relative/root", "index.html"), "ROOT_INVALID")
    await rejects(resolveContainedPath(join(root, "missing"), "index.html"), "ROOT_UNAVAILABLE")
    await rejects(resolveContainedPath(join(root, "index.html"), "x"), "ROOT_NOT_DIRECTORY")
  })
})

describe("allowed roots (tenant-scoped)", () => {
  // <allowed>/<tenant>/site is tenant A's checkout; tenant B owns <allowed>/tenant-b.
  const tenants = () => {
    const allowed = mkdtempSync(join(tmpdir(), "or-allowed-"))
    mkdirSync(join(allowed, "tenant-a", "site"), { recursive: true })
    mkdirSync(join(allowed, "tenant-b", "site"), { recursive: true })
    mkdirSync(join(allowed, "tenant-a-evil"))
    return allowed
  }

  it("accepts a tenant's own checkout, through tmpdir aliases", async () => {
    const allowed = tenants()
    const site = join(allowed, "tenant-a", "site")
    expect((await resolveAllowedRoot(site, [allowed], "tenant-a")).path).toBe(realpathSync(site))
    expect((await resolveAllowedRoot(realpathSync(site), [allowed], "tenant-a")).path).toBe(realpathSync(site))
    expect((await resolveAllowedRoot(join(allowed, "tenant-a"), [allowed], "tenant-a")).path).toBe(realpathSync(join(allowed, "tenant-a")))
  })

  it("rejects another tenant's checkout even though it is globally allowed", async () => {
    const allowed = tenants()
    await rejects(resolveAllowedRoot(join(allowed, "tenant-b", "site"), [allowed], "tenant-a"), "ROOT_NOT_ALLOWED")
    await rejects(resolveAllowedRoot(join(allowed, "tenant-a", "..", "tenant-b", "site"), [allowed], "tenant-a"), "ROOT_NOT_ALLOWED")
    await rejects(resolveAllowedRoot(allowed, [allowed], "tenant-a"), "ROOT_NOT_ALLOWED")
  })

  it("rejects prefix confusion, symlinked tenant dirs, symlinks out, and bad scopes", async () => {
    const allowed = tenants()
    const { outside } = layout()
    await rejects(resolveAllowedRoot(join(allowed, "tenant-a-evil"), [allowed], "tenant-a"), "ROOT_NOT_ALLOWED")
    symlinkSync(join(allowed, "tenant-b"), join(allowed, "tenant-c"))
    await rejects(resolveAllowedRoot(join(allowed, "tenant-c", "site"), [allowed], "tenant-c"), "ROOT_NOT_ALLOWED")
    symlinkSync(outside, join(allowed, "tenant-a", "out"))
    await rejects(resolveAllowedRoot(join(allowed, "tenant-a", "out"), [allowed], "tenant-a"), "ROOT_NOT_ALLOWED")
    await rejects(resolveAllowedRoot(outside, [], "tenant-a"), "ROOT_NOT_ALLOWED")
    await expect(resolveAllowedRoot(join(allowed, "tenant-a"), [allowed], "..")).rejects.toThrowError(/TRAVERSAL/)
    await rejects(resolveAllowedRoot(join(allowed, "tenant-a", "site"), [allowed], "tenant-a/site"), "ROOT_NOT_ALLOWED")
  })
})

// Each barrier test injects a concurrent change at one stage of the write
// and asserts that nothing outside the root changes and no success is
// reported for bytes that were not checked.
describe("concurrent changes during a write (onStage barriers)", () => {
  const swapParent = (root: string, outside: string) => {
    renameSync(join(root, "pages"), join(root, "pages-moved"))
    symlinkSync(outside, join(root, "pages"))
  }
  const tmpFiles = (dir: string) => readdirSync(dir).filter((f) => f.startsWith(".openrecord-tmp-"))

  it("parent swapped before the temp file is created: no byte is written outside", async () => {
    const { root, outside } = layout()
    const e = await writeContainedFile(root, "pages/a.html", "pwned", {
      onStage: async (s) => {
        if (s === "prepared") swapParent(root, outside)
      },
    }).then(() => null, (err: unknown) => err)
    expect(e).toBeInstanceOf(ContainmentError)
    // Documented residual: an empty temp file may be created outside; it is
    // refused before any byte is written and never reported as success.
    for (const f of readdirSync(outside)) expect(readFileSync(join(outside, f), "utf8"), f).not.toContain("pwned")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret")
    expect(readFileSync(join(root, "pages-moved", "a.html"), "utf8")).toBe("<p>a</p>")
  })

  it("parent swapped after the temp file is verified: bytes still land only in the verified inode", async () => {
    const { root, outside } = layout()
    const snapshot = outsideSnapshot(outside)
    const e = await writeContainedFile(root, "pages/a.html", "pwned", {
      onStage: async (s) => {
        if (s === "opened") swapParent(root, outside)
      },
    }).then(() => null, (err: unknown) => err)
    expect(e).toBeInstanceOf(ContainmentError)
    expect(outsideSnapshot(outside)).toBe(snapshot)
  })

  it("parent swapped after staging -> rejected; cleanup never unlinks a same-named outside file", async () => {
    const { root, outside } = layout()
    let tmpName = ""
    const e = await writeContainedFile(root, "pages/a.html", "pwned", {
      onStage: async (s) => {
        if (s !== "staged") return
        tmpName = tmpFiles(join(root, "pages"))[0]!
        swapParent(root, outside)
        writeFileSync(join(outside, tmpName), "outside file with the staged name")
      },
    }).then(() => null, (err: unknown) => err)
    expect(e).toBeInstanceOf(ContainmentError)
    expect(readFileSync(join(outside, tmpName), "utf8")).toBe("outside file with the staged name")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret")
  })

  it("target swapped for an outside symlink after staging -> SYMLINK, temp removed", async () => {
    const { root, outside } = layout()
    const snapshot = outsideSnapshot(outside)
    await rejects(writeContainedFile(root, "pages/a.html", "pwned", {
      onStage: async (s) => {
        if (s !== "staged") return
        rmSync(join(root, "pages", "a.html"))
        symlinkSync(join(outside, "secret.txt"), join(root, "pages", "a.html"))
      },
    }), "SYMLINK")
    expect(outsideSnapshot(outside)).toBe(snapshot)
    expect(tmpFiles(join(root, "pages"))).toEqual([])
  })

  it("hardlink to an outside file swapped in after staging -> rejected, outside untouched", async () => {
    const { root, outside } = layout()
    await rejects(writeContainedFile(root, "pages/a.html", "pwned", {
      onStage: async (s) => {
        if (s !== "staged") return
        rmSync(join(root, "pages", "a.html"))
        linkSync(join(outside, "secret.txt"), join(root, "pages", "a.html"))
      },
    }), "HARDLINKED_FILE")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret")
  })

  it("content edited after staging -> PreconditionFailed, edit preserved", async () => {
    const { root } = layout()
    const e = await writeContainedFile(root, "index.html", "<p>ours</p>", {
      expectedBeforeSha256: sha256Hex("<p>in</p>"),
      onStage: async (s) => {
        if (s === "staged") writeFileSync(join(root, "index.html"), "<p>theirs</p>")
      },
    }).then(() => null, (err: unknown) => err)
    expect(e).toBeInstanceOf(PreconditionFailed)
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe("<p>theirs</p>")
    expect(tmpFiles(root)).toEqual([])
  })

  it("content edited between the final hash and the rename -> ConcurrentModification, never success", async () => {
    const { root } = layout()
    const e = await writeContainedFile(root, "index.html", "<p>ours</p>", {
      expectedBeforeSha256: sha256Hex("<p>in</p>"),
      onStage: async (s) => {
        if (s === "checked") writeFileSync(join(root, "index.html"), "<p>theirs, edited in place</p>")
      },
    }).then(() => null, (err: unknown) => err)
    expect(e).toBeInstanceOf(ConcurrentModification)
  })

  it("bytes changed after the rename are caught by the real read-back", async () => {
    const { root } = layout()
    const r = await writeContainedFile(root, "index.html", "<p>ours</p>", {
      onStage: async (s) => {
        if (s === "renamed") writeFileSync(join(root, "index.html"), "<p>someone else</p>")
      },
    })
    expect(r.afterSha256).toBe(sha256Hex("<p>someone else</p>"))
    expect(r.afterSha256).not.toBe(sha256Hex("<p>ours</p>"))
  })

  it("a pinned root swapped for a symlink is refused (ROOT_CHANGED), outside untouched", async () => {
    const { base, root, outside } = layout()
    const pinned = await pinRoot(root)
    renameSync(root, join(base, "root-moved"))
    symlinkSync(outside, root)
    await rejects(writeContainedFile(pinned, "secret.txt", "pwned"), "ROOT_CHANGED")
    await rejects(readContainedFile(pinned, "secret.txt"), "ROOT_CHANGED")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret")
  })

  it("a pinned root replaced by another real directory is refused (ROOT_CHANGED)", async () => {
    const { base, root } = layout()
    const pinned = await pinRoot(root)
    renameSync(root, join(base, "root-moved"))
    mkdirSync(root)
    writeFileSync(join(root, "index.html"), "impostor")
    await rejects(writeContainedFile(pinned, "index.html", "x"), "ROOT_CHANGED")
  })
})

describe("concurrent changes during a read", () => {
  it("parent swapped between resolution and open -> rejected, outside bytes never returned", async () => {
    const { root, outside } = layout()
    writeFileSync(join(outside, "a.html"), "synthetic-outside")
    const e = await readContainedFile(root, "pages/a.html", {
      onResolved: async () => {
        renameSync(join(root, "pages"), join(root, "pages-moved"))
        symlinkSync(outside, join(root, "pages"))
      },
    }).then((r) => r, (err: unknown) => err)
    expect(e).toBeInstanceOf(ContainmentError)
  })

  it("a FIFO swapped in before open is rejected without hanging", async () => {
    const { root } = layout()
    await rejects(readContainedFile(root, "pages/a.html", {
      onResolved: async () => {
        rmSync(join(root, "pages", "a.html"))
        execFileSync("mkfifo", [join(root, "pages", "a.html")])
      },
    }), "NOT_A_REGULAR_FILE")
  })
})

describe("special files and limits", () => {
  it("rejects a FIFO target found by the walk", async () => {
    const { root } = layout()
    execFileSync("mkfifo", [join(root, "pipe.html")])
    await rejects(readContainedFile(root, "pipe.html"), "NOT_A_REGULAR_FILE")
    await rejects(writeContainedFile(root, "pipe.html", "x"), "NOT_A_REGULAR_FILE")
  })

  it("an over-long path component is a typed rejection, not a raw ENAMETOOLONG", async () => {
    const { root } = layout()
    await rejects(resolveContainedPath(root, `pages/${"a".repeat(300)}`), "PATH_TOO_LONG")
  })

  it("reserved segments are detected case- and Unicode-insensitively", () => {
    for (const p of [".git/config", "a/.GIT/hooks/x", ".Git/HEAD", ".openrecord/x", ".OPENRECORD/x"]) {
      expect(hasReservedSegment(p, [".git", ".openrecord"]), p).toBe(true)
    }
    for (const p of [".gitignore", "a/git/x", "docs/.github/x"]) expect(hasReservedSegment(p, [".git", ".openrecord"]), p).toBe(false)
  })
})

describe("writes", () => {
  it("replaces a file atomically, preserving nothing but the new bytes", async () => {
    const { root } = layout()
    const before = sha256Hex("<p>in</p>")
    const r = await writeContainedFile(root, "index.html", "<p>new</p>", { expectedBeforeSha256: before })
    expect(r.beforeSha256).toBe(before)
    expect(r.afterSha256).toBe(sha256Hex("<p>new</p>"))
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe("<p>new</p>")
    expect(readdirSync(root).filter((f) => f.startsWith(".openrecord-tmp-"))).toEqual([])
  })

  it("writes nothing when the before hash is stale", async () => {
    const { root } = layout()
    const e = await writeContainedFile(root, "index.html", "<p>new</p>", { expectedBeforeSha256: sha256Hex("something else") }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(PreconditionFailed)
    expect((e as PreconditionFailed).actualSha256).toBe(sha256Hex("<p>in</p>"))
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe("<p>in</p>")
    expect(readdirSync(root).filter((f) => f.startsWith(".openrecord-tmp-"))).toEqual([])
  })

  it("enforces must-not-exist and parent creation explicitly", async () => {
    const { root } = layout()
    await expect(writeContainedFile(root, "index.html", "x", { expectedBeforeSha256: null })).rejects.toBeInstanceOf(PreconditionFailed)
    await rejects(writeContainedFile(root, "new/dir/file.json", "x"), "PARENT_MISSING")
    const r = await writeContainedFile(root, "new/dir/file.json", "x", { createParents: true, expectedBeforeSha256: null })
    expect(r.beforeSha256).toBeNull()
    expect(await containedEntryKind(root, "new/dir")).toBe("DIRECTORY")
    expect(await containedEntryKind(root, "new/dir/file.json")).toBe("FILE")
    expect(await containedEntryKind(root, "nope")).toBe("MISSING")
  })
})

// Fragments chosen to compose every escape class above.
const FRAGMENTS = ["..", ".", "/", "\\", "pages", "a.html", "index.html", "dirlink", "filelink.html", "innerlink.html", "%2e", "%2f", "%5c", "%25", "\0", "secret.txt", "outside", "x"]
const candidateArb = fc.array(fc.constantFrom(...FRAGMENTS), { minLength: 1, maxLength: 8 }).map((parts) => parts.join(""))

describe("properties", () => {
  it("any accepted candidate resolves strictly inside the real root", async () => {
    const { root } = layout()
    const realRoot = realpathSync(root)
    await fc.assert(
      fc.asyncProperty(candidateArb, async (candidate) => {
        const result = await resolveContainedPath(root, candidate).then((p) => p, (e: unknown) => e)
        if (result instanceof ContainmentError) return true
        if (result instanceof Error) throw result
        const p = result as Awaited<ReturnType<typeof resolveContainedPath>>
        expect(p.absolute.startsWith(`${realRoot}/`)).toBe(true)
        expect(p.relative.split("/")).not.toContain("..")
        return true
      }),
      { numRuns: 400 },
    )
  })

  it("no write ever modifies anything outside the root", async () => {
    const { root, outside } = layout()
    const snapshot = outsideSnapshot(outside)
    await fc.assert(
      fc.asyncProperty(candidateArb, async (candidate) => {
        await writeContainedFile(root, candidate, "pwned", { createParents: true }).catch((e: unknown) => {
          if (!(e instanceof ContainmentError)) throw e
        })
        expect(outsideSnapshot(outside)).toBe(snapshot)
        return true
      }),
      { numRuns: 300 },
    )
  })
})
