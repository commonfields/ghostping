// Demo seed: fictional Northstar Software.
import pg from "pg"
import { randomUUID } from "node:crypto"
import { NORTHSTAR_FACTS, NORTHSTAR_QUESTIONS } from "./seed-helpers.js"

export async function seed(databaseUrl: string, email = "demo@northstar.test", passwordHash = "SCR glance"): Promise<void> {
  void passwordHash
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const accountId = randomUUID()
    await client.query(`INSERT INTO accounts (id, name) VALUES ($1, 'Northstar Demo') ON CONFLICT DO NOTHING`, [accountId])
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
    console.log(`seeded business ${businessId} for ${email}`)
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
