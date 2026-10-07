# Protocol versioning

Evidence schema versions are independent of package, application, and CLI versions. Each portable object carries `schema` (for example `openrecord/evidence-packet-v1`) and an integer `schema_version`.

## Readers

- Readers match both `schema` and `schema_version` exactly and reject anything else with `UnsupportedSchemaVersion`. They do this before they trust any other field.
- Readers never guess how to convert an unknown future version.
- V1 readers reject unknown properties (`SchemaViolation`). A reader that ignored an unknown field could miss a meaning-changing field.

## Change rules

| Change | Classification |
| --- | --- |
| New optional field whose absence has a documented, unambiguous meaning | Allowed in V1 only for fields that are not covered by the packet digest or derivation. In practice this means a new version. |
| New required field | Breaking. Requires a new `schema_version`. |
| New value in a closed enum (surface kind, verdict, outcome, intervention type, …) | Breaking for fail-closed readers. Requires a new `schema_version`. |
| Change to meaning, units, canonicalization, comparison rules, outcome rules, digest scope, or the meaning of UNKNOWN | Breaking. Requires a new `schema_version`. |
| Renamed or removed field, or changed type | Breaking. Requires a new `schema_version`. |
| Editorial documentation change with no semantic effect | Allowed |

Because V1 readers reject unknown properties and re-derive every derived field, almost every schema change is a new version. This strictness is intentional.

## Deprecation

- Writers emit only the current version.
- A deprecated version stays documented and readable for at least one minor release after its successor ships. Release notes announce the removal date.
- Golden fixtures for every supported version stay in `fixtures/` until that version is removed.

## Single source

`packages/protocol` (Effect Schema) defines the schemas. JSON Schemas in `schemas/openrecord` and fixtures in `fixtures/evidence-protocol-v1` are generated. Tests fail when the committed files drift from the generators. The Rust reader is a second implementation by design. It must reach the same verdict, digest, classifications, and outcomes as TypeScript for every fixture, and CI runs that check in both languages.
