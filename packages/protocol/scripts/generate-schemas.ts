// Writes generated JSON Schemas to schemas/ghostping. Never edit those by hand.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildSchemas } from "./schemas.js"

const out = resolve(import.meta.dirname, "../../../schemas/ghostping")
mkdirSync(out, { recursive: true })
for (const stale of readdirSync(out)) rmSync(resolve(out, stale))
for (const [name, text] of Object.entries(buildSchemas())) writeFileSync(resolve(out, name), text)
