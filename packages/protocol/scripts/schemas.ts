// JSON Schema generation from the canonical Effect Schemas.
import { JSONSchema, Schema } from "effect"
import { canonicalJson, protocolSchemas, schemaId } from "../src/index.js"

const fileName: Record<keyof typeof protocolSchemas, string> = {
  fact: "fact",
  surface: "surface",
  measurement: "measurement-context",
  observation: "observation",
  claim: "claim",
  judgment: "judgment",
  issue: "issue",
  intervention: "intervention",
  reobservation: "reobservation",
  packet: "evidence-packet",
}

/** File name → canonical JSON Schema text (with trailing newline). */
export const buildSchemas = (): Record<string, string> =>
  Object.fromEntries(
    (Object.keys(protocolSchemas) as Array<keyof typeof protocolSchemas>).map((name) => {
      const json = {
        ...JSONSchema.make(protocolSchemas[name] as Schema.Schema.Any, { target: "jsonSchema2020-12" }),
        $id: `https://ghostping.dev/schemas/${schemaId[name]}.schema.json`,
      }
      return [`${fileName[name]}-v1.schema.json`, `${canonicalJson(json)}\n`]
    }),
  )
