// Minimal migration runner using node-postgres directly (no ORM).
import { readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, "../migrations")

// Serializes concurrent migrate() callers (parallel vitest files, parallel
// deploy tasks). Postgres DDL guards like CREATE TABLE IF NOT EXISTS are
// check-then-create and NOT atomic: concurrent first-migrates race on the
// catalog (23505 pg_type_typname_nsp_index, duplicate trigger/index
// errors) with exactly one winner. A session-level advisory lock makes the
// whole batch mutually exclusive without retries (real failures still
// throw). Released on unlock, or automatically if the session drops.
// Key = first 60 bits of sha256("ghostping-db-migrations").
const MIGRATION_ADVISORY_LOCK = "769653221042929474"

export async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  // Blocks until any concurrent migrate() finishes its batch.
  await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_ADVISORY_LOCK])
  try {
    // CITEXT is optional (may be missing in minimal images); tolerate it.
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)
    } catch {
      // ignore
    }
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "citext"`)
    } catch {
      // ignore
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    for (const f of files) {
      let sql = readFileSync(join(dir, f), "utf8")
      // Graceful CITEXT fallback: plain TEXT UNIQUE keeps V1 working.
      sql = sql.replace("email CITEXT UNIQUE", "email TEXT UNIQUE")
      await client.query(sql)
      console.log(`applied ${f}`)
    }
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_ADVISORY_LOCK])
    } finally {
      await client.end()
    }
  }
}

const url = process.env["DATABASE_URL"]
if (url && process.argv[1]?.endsWith("migrate.ts")) {
  migrate(url).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
