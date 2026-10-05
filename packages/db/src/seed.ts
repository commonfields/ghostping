// Minimal seed: one fictional business (Northstar Software) with facts and
// questions. Idempotent: re-running skips when the business already exists.
// For the full five-company demo world with a login, use scripts/demo-seed.ts
// via `pnpm db:seed:demo` instead.
import pg from "pg"
import { NORTHSTAR_FACTS, NORTHSTAR_QUESTIONS } from "./seed-helpers.js"

export async function seed(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const existing = await client.query(
      `SELECT b.id FROM businesses b JOIN accounts a ON a.id = b.account_id
       WHERE a.name = 'Northstar Demo' AND b.name = 'Northstar Software' LIMIT 1`,
    )
    if (existing.rows.length > 0) {
      console.log(`seed already present (business ${existing.rows[0]?.["id"] as string}); skipping`)
      return
    }
    const accountId: string = (
      await client.query(
        `INSERT INTO accounts (name) VALUES ('Northstar Demo') RETURNING id`,
      )
    ).rows[0]?.["id"] as string
    const biz = await client.query(
      `INSERT INTO businesses (account_id, name) VALUES ($1, 'Northstar Software') RETURNING id`,
      [accountId],
    )
    const businessId: string = biz.rows[0]?.["id"] as string
    for (const f of NORTHSTAR_FACTS) {
      await client.query(
        `INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, source_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [businessId, f.subject, f.predicate, f.valueText, f.valueType, f.validFrom, f.sourceKind],
      )
    }
    for (const q of NORTHSTAR_QUESTIONS) {
      await client.query(`INSERT INTO buyer_questions (business_id, prompt, origin) VALUES ($1,$2,$3)`, [
        businessId,
        q.prompt,
        q.origin,
      ])
    }
    console.log(`seeded business ${businessId} (minimal seed has no login; use pnpm db:seed:demo for a demo login)`)
  } finally {
    await client.end()
  }
}

const url = process.env["DATABASE_URL"]
if (url && process.argv[1]?.endsWith("seed.ts")) {
  await seed(url).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
