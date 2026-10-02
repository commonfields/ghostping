// Writes golden fixtures to fixtures/evidence-protocol-v1. Never edit those by hand.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildFixtures, canonicalVectors, expectedResults } from "./fixtures.js"

const out = resolve(import.meta.dirname, "../../../fixtures/evidence-protocol-v1")
const vectors = resolve(out, "vectors")
mkdirSync(vectors, { recursive: true })
for (const stale of readdirSync(out).filter((n) => n.endsWith(".json"))) rmSync(resolve(out, stale))
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const fixtures = buildFixtures()
for (const [name, value] of Object.entries(fixtures)) writeFileSync(resolve(out, `${name}.json`), pretty(value))
writeFileSync(resolve(vectors, "canonical-json.json"), pretty(canonicalVectors()))
writeFileSync(resolve(vectors, "expected.json"), pretty(expectedResults(fixtures)))
