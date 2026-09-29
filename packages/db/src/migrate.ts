// Minimal migration runner using node-postgres directly (no ORM).
import { readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, "../migrations")

export async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
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
    await client.end()
  }
}

const url = process.env["DATABASE_URL"]
if (url && process.argv[1]?.endsWith("migrate.ts")) {
  migrate(url).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
