// Phase 1 mutation binding, end to end through the service the HTTP routes
// call, against PostgreSQL and a real checkout directory:
// prepare -> approve -> apply, idempotent replay, stale file, re-prepared
// patch, path escapes, root allowlist, and the DB-level binding guards.
// Requires TEST_DATABASE_URL (CI provides postgres; skipped otherwise).
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SiteOperatorRepositoriesLive } from "@openrecord/db"
import { sha256Hex } from "@openrecord/fs-containment"
import { applyFix, approveFix, prepareFix, siteOperatorRoots } from "./site-mutations.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

const BROKEN = `<!doctype html><html><head><title>Plumbing</title>
<meta name="robots" content="noindex">
</head><body><h1>Plumbing</h1></body></html>`

suite("site mutation binding (prepare/approve/apply)", () => {
  let pool: pg.Pool
  const Repos = SiteOperatorRepositoriesLive.pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) })))
  const run = <A, E>(eff: Effect.Effect<A, E, never>) => Effect.runPromise(eff)
  const svc = <A, E, R>(eff: Effect.Effect<A, E, R>) => run(eff.pipe(Effect.provide(Repos)) as Effect.Effect<A, E, never>)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
  })
  afterAll(async () => {
    await pool.end()
  })

  /**
   * One business + site + finding + REMOVE_NOINDEX_META proposal over a
   * fresh checkout at <tmpdir>/<business id>/<random>/site (tenant-scoped).
   */
  const fixture = async (opts: { fileMap?: Record<string, string>; rootDir?: string } = {}) => {
    const account = (await pool.query("INSERT INTO accounts (name) VALUES ('mutation fixture') RETURNING id")).rows[0].id as string
    const business = (await pool.query("INSERT INTO businesses (account_id, name) VALUES ($1,'MutBiz') RETURNING id", [account])).rows[0].id as string
    mkdirSync(join(tmpdir(), business), { recursive: true })
    const base = mkdtempSync(join(tmpdir(), business, "or-mutation-api-"))
    const root = join(base, "site")
    mkdirSync(join(root, "services"), { recursive: true })
    writeFileSync(join(root, "services", "plumbing.html"), BROKEN)
    writeFileSync(join(base, "outside.html"), BROKEN)
    const repoRef = { rootDir: opts.rootDir ?? root, fileMap: opts.fileMap ?? {} }
    const site = (await pool.query(
      "INSERT INTO site_targets (business_id, root_url, canonical_origin, path_prefix, adapter_kind, repo_ref) VALUES ($1,'https://example.com/','https://example.com','/','LOCAL_FILE',$2) RETURNING id",
      [business, JSON.stringify(repoRef)],
    )).rows[0].id as string
    const runId = (await pool.query("INSERT INTO site_inspection_runs (business_id, site_target_id, state) VALUES ($1,$2,'SUCCEEDED') RETURNING id", [business, site])).rows[0].id as string
    const finding = (await pool.query(
      `INSERT INTO site_findings (business_id, site_target_id, run_id, url, canonical_url, finding_kind, severity, category, identity_key)
       VALUES ($1,$2,$3,'https://example.com/services/plumbing','https://example.com/services/plumbing','BLOCKED_BY_META','HIGH','CRAWL_INDEX_RISK',$4) RETURNING id`,
      [business, site, runId, `k-${Math.random()}`],
    )).rows[0].id as string
    const proposal = (await pool.query(
      `INSERT INTO site_fix_proposals (business_id, finding_id, fix_kind, target, classification, requires_approval)
       VALUES ($1,$2,'REMOVE_NOINDEX_META','https://example.com/services/plumbing','APPROVAL_REQUIRED',true) RETURNING id`,
      [business, finding],
    )).rows[0].id as string
    return { base, root, business, site, finding, proposal }
  }

  /** Prepare, then approve exactly the prepared (reviewed) hash. */
  const prepareAndApprove = async (f: { business: string; proposal: string }, actor = "op-1") => {
    const prepared = await svc(prepareFix(f.business, f.proposal, actor, null))
    const hash = String((prepared.body as { proposal: { patchSha256: string } }).proposal.patchSha256)
    const approved = await svc(approveFix(f.business, f.proposal, actor, true, hash))
    return { prepared, approved, hash }
  }
  const findingStatus = async (id: string) => (await pool.query("SELECT status FROM site_findings WHERE id=$1", [id])).rows[0].status as string
  const body = (r: { body: unknown }) => r.body as Record<string, unknown> & { mutation?: Record<string, unknown>; proposal?: Record<string, unknown> }

  it("allows the OS temp dir only under test or explicit opt-in", () => {
    expect(siteOperatorRoots({ NODE_ENV: "production" })).toEqual([])
    expect(siteOperatorRoots({ NODE_ENV: "production", SITE_OPERATOR_ROOTS: "/srv/a:/srv/b" })).toEqual(["/srv/a", "/srv/b"])
    expect(siteOperatorRoots({ NODE_ENV: "production", SITE_OPERATOR_ALLOW_TMPDIR: "1" })).toEqual([tmpdir()])
  })

  it("prepare -> approve -> apply writes exactly the approved bytes, once", async () => {
    const f = await fixture()
    // Approval without a prepared change is refused.
    expect((await svc(approveFix(f.business, f.proposal, "op-1", true, null))).status).toBe(409)
    const prepared = await svc(prepareFix(f.business, f.proposal, "op-1", null))
    expect(prepared.status).toBe(200)
    const plan = body(prepared).proposal!
    expect(plan["filePath"]).toBe("services/plumbing.html")
    expect(plan["beforeSha256"]).toBe(sha256Hex(BROKEN))
    expect(String(body(prepared)["patch"])).toContain('-<meta name="robots" content="noindex">')
    // Approving an automated fix without naming the reviewed hash is refused.
    expect((await svc(approveFix(f.business, f.proposal, "op-1", true, null))).status).toBe(422)
    const approved = await svc(approveFix(f.business, f.proposal, "op-1", true, String(plan["patchSha256"])))
    expect(approved.status).toBe(200)
    expect(body(approved).proposal!["approvedPatchSha256"]).toBe(plan["patchSha256"])
    expect(await findingStatus(f.finding)).toBe("APPROVED")

    const applied = await svc(applyFix(f.business, f.proposal, "op-1", {}))
    expect(applied.status).toBe(200)
    const m = body(applied).mutation!
    expect(m).toMatchObject({ state: "CREATED", failureCode: null, targetPath: "services/plumbing.html", beforeSha256: plan["beforeSha256"], afterSha256: plan["afterSha256"], approvedPatchSha256: plan["patchSha256"], approvedBy: "op-1", appliedAfterSha256: plan["afterSha256"] })
    expect(sha256Hex(readFileSync(join(f.root, "services", "plumbing.html")))).toBe(plan["afterSha256"])
    expect(await findingStatus(f.finding)).toBe("FIX_APPLIED")

    // Same idempotency key (default) -> the original result, nothing rewritten.
    writeFileSync(join(f.root, "services", "plumbing.html"), BROKEN) // even if the file regressed
    const replay = await svc(applyFix(f.business, f.proposal, "op-1", {}))
    expect(replay.status).toBe(200)
    expect(body(replay)).toMatchObject({ replayed: true, mutation: { id: m["id"] } })
    expect(readFileSync(join(f.root, "services", "plumbing.html"), "utf8")).toBe(BROKEN)
    const count = (await pool.query("SELECT count(*)::int n FROM site_mutations WHERE fix_proposal_id=$1", [f.proposal])).rows[0].n as number
    expect(count).toBe(1)
  })

  it("stale file -> PRECONDITION_FAILED, recorded, nothing written; replay returns the same failure", async () => {
    const f = await fixture()
    await prepareAndApprove(f)
    const edited = BROKEN.replace("<h1>Plumbing</h1>", "<h1>Edited by a human</h1>")
    writeFileSync(join(f.root, "services", "plumbing.html"), edited)
    const r = await svc(applyFix(f.business, f.proposal, "op-1", {}))
    expect(r.status).toBe(409)
    expect(body(r)).toMatchObject({ _tag: "PreconditionFailed", mutation: { state: "FAILED", failureCode: "PRECONDITION_FAILED", appliedAfterSha256: sha256Hex(edited) } })
    expect(readFileSync(join(f.root, "services", "plumbing.html"), "utf8")).toBe(edited)
    expect(readdirSync(join(f.root, "services"))).toEqual(["plumbing.html"])
    expect(await findingStatus(f.finding)).toBe("APPROVED")
    const replay = await svc(applyFix(f.business, f.proposal, "op-1", {}))
    expect(replay.status).toBe(409)
    expect(body(replay)).toMatchObject({ _tag: "PreconditionFailed", replayed: true })
  })

  it("a changed patch requires new approval", async () => {
    const f = await fixture()
    await prepareAndApprove(f)
    // The source changes and the operator re-prepares: the approval no longer covers it.
    writeFileSync(join(f.root, "services", "plumbing.html"), BROKEN.replace("<h1>", "<h1 class=x>"))
    const re = await svc(prepareFix(f.business, f.proposal, "op-1", null))
    expect(body(re)).toMatchObject({ approvalInvalidated: true, proposal: { status: "PROPOSED" } })
    expect(await findingStatus(f.finding)).toBe("AWAITING_APPROVAL")
    expect((await svc(applyFix(f.business, f.proposal, "op-1", {}))).status).toBe(409)
    expect(readFileSync(join(f.root, "services", "plumbing.html"), "utf8")).toContain("noindex")
    // Re-approval binds the new patch and apply succeeds.
    await svc(approveFix(f.business, f.proposal, "op-2", true, String((re.body as { proposal: { patchSha256: string } }).proposal.patchSha256)))
    const ok = await svc(applyFix(f.business, f.proposal, "op-2", {}))
    expect(ok.status).toBe(200)
    expect(readFileSync(join(f.root, "services", "plumbing.html"), "utf8")).not.toContain("noindex")
  })

  it("approval hash mismatch at apply time -> APPROVAL_INVALIDATED, recorded, nothing written", async () => {
    const f = await fixture()
    await prepareAndApprove(f)
    // Simulate a plan edited behind the approval (e.g. a buggy writer).
    await pool.query("UPDATE site_fix_proposals SET after_sha256 = $2, patch_sha256 = $3 WHERE id = $1", [f.proposal, sha256Hex("evil"), sha256Hex("evil-patch")])
    const r = await svc(applyFix(f.business, f.proposal, "op-1", { idempotencyKey: "explicit-key-1" }))
    expect(r.status).toBe(409)
    expect(body(r)).toMatchObject({ _tag: "ApprovalInvalidated", mutation: { failureCode: "APPROVAL_INVALIDATED" } })
    expect(readFileSync(join(f.root, "services", "plumbing.html"), "utf8")).toBe(BROKEN)
    // A request naming a different file than the approved one is refused.
    expect(body(await svc(applyFix(f.business, f.proposal, "op-1", { filePath: "index.html", idempotencyKey: "k2" })))).toMatchObject({ _tag: "ApprovalInvalidated" })
  })

  it("rejects escaping file paths from the request and from repoRef.fileMap", async () => {
    const f = await fixture()
    symlinkSync(join(f.base, "outside.html"), join(f.root, "link.html"))
    for (const filePath of ["../outside.html", "services/../../outside.html", "..\\outside.html", "/etc/hosts", "%2e%2e/outside.html", "link.html", "services/plumbing.html\0"]) {
      const r = await svc(prepareFix(f.business, f.proposal, "op-1", filePath))
      expect(r.status, filePath).toBe(422)
      expect(body(r)["_tag"], filePath).toBe("PathRejected")
    }
    const g = await fixture({ fileMap: { "https://example.com/services/plumbing": "../outside.html" } })
    expect(body(await svc(prepareFix(g.business, g.proposal, "op-1", null)))).toMatchObject({ _tag: "PathRejected", code: "TRAVERSAL" })
    expect(readFileSync(join(f.base, "outside.html"), "utf8")).toBe(BROKEN)
    expect(readFileSync(join(g.base, "outside.html"), "utf8")).toBe(BROKEN)
  })

  it("rejects checkout roots outside the allowlist, including via traversal and symlink", async () => {
    const f = await fixture()
    const elsewhere = mkdtempSync(join(tmpdir(), "or-not-allowed-"))
    symlinkSync(elsewhere, join(f.base, "rootlink"))
    for (const rootDir of ["/etc", `${tmpdir()}/../../etc`, join(f.base, "rootlink"), "relative/dir"]) {
      await pool.query("UPDATE site_targets SET repo_ref = $2 WHERE id = $1", [f.site, JSON.stringify({ rootDir })])
      const r = await svc(prepareFix(f.business, f.proposal, "op-1", "services/plumbing.html", [tmpdir()]))
      expect(r.status, rootDir).toBe(422)
      expect(String(body(r)["reason"]), rootDir).toContain("outside the allowed workspace")
    }
  })

  it("a business cannot point its site at another business's checkout", async () => {
    const victim = await fixture()
    const attacker = await fixture({ rootDir: victim.root })
    const r = await svc(prepareFix(attacker.business, attacker.proposal, "op-1", "services/plumbing.html"))
    expect(r.status).toBe(422)
    expect(String(body(r)["reason"])).toContain("outside the allowed workspace")
    expect(readFileSync(join(victim.root, "services", "plumbing.html"), "utf8")).toBe(BROKEN)
  })

  it("GITHUB sites fail closed instead of falling through to the local adapter", async () => {
    const f = await fixture()
    await pool.query("UPDATE site_targets SET adapter_kind = 'GITHUB' WHERE id = $1", [f.site])
    const r = await svc(prepareFix(f.business, f.proposal, "op-1", null))
    expect(r.status).toBe(422)
    expect(body(r)).toMatchObject({ _tag: "AdapterBlocked", code: "ADAPTER_NOT_IMPLEMENTED" })
    expect(readFileSync(join(f.root, "services", "plumbing.html"), "utf8")).toBe(BROKEN)
  })

  it("the database refuses to rewrite a claimed binding", async () => {
    const f = await fixture()
    await prepareAndApprove(f)
    const m = body(await svc(applyFix(f.business, f.proposal, "op-1", {}))).mutation!
    for (const [col, value] of [["target_path", "index.html"], ["approved_patch_sha256", sha256Hex("x")], ["approved_by", "someone-else"], ["idempotency_key", "other"]] as const) {
      await expect(pool.query(`UPDATE site_mutations SET ${col} = $2 WHERE id = $1`, [m["id"], value]), col).rejects.toThrow(/binding is immutable/)
    }
    const other = await fixture()
    await expect(pool.query("UPDATE site_mutations SET business_id = $2 WHERE id = $1", [m["id"], other.business])).rejects.toThrow(/binding is immutable/)
    // A keyed mutation without its binding cannot be inserted.
    await expect(pool.query(
      "INSERT INTO site_mutations (business_id, fix_proposal_id, finding_id, idempotency_key) VALUES ($1,$2,$3,'unbound')",
      [f.business, f.proposal, f.finding],
    )).rejects.toThrow(/site_mutations_binding_ck/)
  })

  it("approval binds only to the change the reviewer saw (stale review is refused)", async () => {
    const f = await fixture()
    writeFileSync(join(f.root, "services", "other.html"), BROKEN)
    const seen = await svc(prepareFix(f.business, f.proposal, "op-1", null))
    const seenHash = String((seen.body as { proposal: { patchSha256: string } }).proposal.patchSha256)
    // Someone re-prepares the proposal against another file before approval arrives.
    await svc(prepareFix(f.business, f.proposal, "op-2", "services/other.html"))
    const stale = await svc(approveFix(f.business, f.proposal, "op-1", true, seenHash))
    expect(stale.status).toBe(409)
    expect(body(stale)["_tag"]).toBe("ApprovalInvalidated")
    expect((await pool.query("SELECT status FROM site_fix_proposals WHERE id=$1", [f.proposal])).rows[0].status).toBe("PROPOSED")
    expect((await svc(applyFix(f.business, f.proposal, "op-1", {}))).status).toBe(409)
    expect(readFileSync(join(f.root, "services", "other.html"), "utf8")).toBe(BROKEN)
  })

  it("one approval executes at most once, even under different idempotency keys", async () => {
    const f = await fixture()
    await prepareAndApprove(f)
    const results = await Promise.all([
      svc(applyFix(f.business, f.proposal, "op-1", { idempotencyKey: "key-a" })),
      svc(applyFix(f.business, f.proposal, "op-1", { idempotencyKey: "key-b" })),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    const rows = (await pool.query("SELECT state, failure_code FROM site_mutations WHERE fix_proposal_id=$1", [f.proposal])).rows
    expect(rows).toHaveLength(1)
    // A third key after success is refused too, without touching the file.
    const third = await svc(applyFix(f.business, f.proposal, "op-1", { idempotencyKey: "key-c" }))
    expect(third.status).toBe(409)
  })

  it("a replay returns the original patch even after the proposal is re-prepared", async () => {
    const f = await fixture()
    const { prepared } = await prepareAndApprove(f)
    const original = String(body(prepared)["patch"])
    const first = await svc(applyFix(f.business, f.proposal, "op-1", { idempotencyKey: "replay-key" }))
    expect(body(first)["patch"]).toBe(original)
    writeFileSync(join(f.root, "services", "other.html"), BROKEN)
    await svc(prepareFix(f.business, f.proposal, "op-1", "services/other.html"))
    const replay = await svc(applyFix(f.business, f.proposal, "op-1", { idempotencyKey: "replay-key" }))
    expect(body(replay)).toMatchObject({ replayed: true, patch: original })
    expect(String(body(replay)["patch"])).not.toContain("other.html")
  })

  it("partially-NULL bindings are rejected by the database (NULL-safe CHECKs)", async () => {
    const f = await fixture()
    await prepareAndApprove(f)
    const m = body(await svc(applyFix(f.business, f.proposal, "op-1", {}))).mutation!
    const base = [f.business, f.proposal, f.finding, "services/plumbing.html", "patch", sha256Hex("b"), sha256Hex("a"), sha256Hex("p"), "op", new Date().toISOString()]
    const insert = (overrides: Record<number, unknown>) => {
      const v = base.map((x, i) => (i in overrides ? overrides[i] : x))
      return pool.query(
        `INSERT INTO site_mutations (business_id, fix_proposal_id, finding_id, target_path, patch, before_sha256, after_sha256, approved_patch_sha256, approved_by, approved_at, idempotency_key, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'partial-${Math.random()}','FAILED')`,
        v,
      )
    }
    for (const nulled of [5, 6, 7, 4]) await expect(insert({ [nulled]: null }), `column ${nulled}`).rejects.toThrow(/site_mutations_binding_ck/)
    await expect(pool.query("UPDATE site_fix_proposals SET before_sha256 = NULL WHERE id = $1", [f.proposal])).rejects.toThrow(/site_fix_proposals_plan_ck/)
    void m
  })

  it("a FAILED keyed mutation is final; a completion lost to another writer is not overwritten", async () => {
    const f = await fixture()
    await prepareAndApprove(f)
    writeFileSync(join(f.root, "services", "plumbing.html"), BROKEN.replace("<h1>", "<h1 id=edited>"))
    const failed = body(await svc(applyFix(f.business, f.proposal, "op-1", {}))).mutation!
    expect(failed["state"]).toBe("FAILED")
    await expect(pool.query("UPDATE site_mutations SET state = 'CREATED', failure_code = NULL WHERE id = $1", [failed["id"]])).rejects.toThrow(/failed and is final/)
    await expect(pool.query("UPDATE site_mutations SET failure_code = 'MUTATION_FAILED' WHERE id = $1 AND state <> 'FAILED'", [failed["id"]])).resolves.toBeDefined()
    // complete() only moves APPLYING rows: a second completion returns null.
    const { SiteMutationRepository } = await import("@openrecord/db")
    const again = await svc(Effect.flatMap(SiteMutationRepository, (r) => r.complete(f.business, String(failed["id"]), { state: "CREATED", failureCode: null, branch: null, appliedAfterSha256: null, detail: "late" })))
    expect(again).toBeNull()
  })
})
