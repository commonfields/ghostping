# Truth Projection Assay V1

Base: `origin/main` @ `50e1c42` (PR #13 merged, PR #14 auth repair merged, CI green).
Date: 2026-10-03. Branch: `feat/truth-projection-v1` (from clean origin/main;
operator files `apps/web/app/lib/mock.ts`, `apps/web/app/routes/today.tsx` left untouched).

## 1. What is currently the writable source of authoritative facts?

Two disjoint stores, no sync between them:

- Hosted PostgreSQL `authoritative_facts` (`packages/db/migrations/0001_init.sql:43-59`):
  UUID id, `business_id`, subject/predicate/`value_text`/`value_type`
  (TEXT,NUMBER,CURRENCY,BOOLEAN,DATE,URL,ENUM), status
  (ACTIVE/SUPERSEDED/RETIRED), monotonic INT `version`, `supersedes_id`,
  `[valid_from,valid_until)` TIMESTAMPTZ, `source_kind`, `created_at`.
- Local SQLite `evidence.db` (`src/integrity.rs:340-362`): `FACT-NNNN` ids,
  `project_id`, same subject/predicate/value shape plus
  `source_ref/digest/notes/created_by`, TEXT windows, no version column.

## 2. Can a fact currently be written from multiple paths?

Yes. Hosted: API routes (`apps/api/src/router.ts:440-541` create/supersede/
retire, conflict-guarded by `activeOverlapping`), direct `FactRepositoryLive`
calls (`packages/db/src/repositories.ts:158-200`), raw-SQL seeds
(`packages/db/src/seed.ts:18-24`). Local: `openrecord facts add|retire`
(`src/bin/openrecord.rs:3746-3916` via `AuditStorage::insert_fact`,
`src/integrity.rs:615-662,799-808`). No CLI↔hosted sync exists
(`0001_init.sql:1-2`: PG is the sole hosted store).

## 3. How are fact versions identified?

Hosted: `(id UUID, version INT)` with `version = prev + 1` on supersede,
`supersedes_id` linear pointer, head = ACTIVE rows; overlap conflicts are
rejected at create and surfaced pairwise at list
(`repositories.ts:177-212`, `router.ts:408-439`). Local: `FACT-%04d`
row-count ids + `supersedes_fact_id` chain ordered by `created_at`.

## 4. What must change to enforce one writer?

A per-business authority-mode record (absent = HOSTED, preserving current
behavior), enforced in two places: application-level guards in
`FactRepository` (create/supersede/retire throw
`FactAuthorityManagedByRepository` when mode is REPOSITORY_MANIFEST) and a
DB trigger as backstop, plus the mirror guard (manifest sync rejected for
HOSTED businesses). Mode changes prohibited once facts exist; no UI switch.

## 5. Can the existing Rust CLI consume this feature without duplicating substantial domain logic?

No — not without re-implementing the manifest model, YAML parsing (Rust has
no YAML crate today: `Cargo.toml` carries `toml 0.8`, `serde_json`, no
`serde_yaml`), decimal money handling, canonical JSON, and the compiler in
Rust. Per milestone rules, the canonical implementation stays TypeScript
(single writer); the repo already runs TS CLIs via `tsx` (`db migrate`,
`seed`), so a thin `truth` tsx wrapper reuses that pattern with zero
duplicated semantics.

## 6. What is the smallest coherent projection mechanism?

V1: one projection kind (JSON_LD) as a typed AST of literals plus
`{fact, component}` references over manifest `text|boolean|money` facts;
a pure compiler (manifest + resolved canonical facts + compiler version →
canonical JSON bytes + SHA-256); plan (CREATE/UPDATE/UNCHANGED/CONFLICT/
STALE) against the working tree plus a derived-only lock file; atomic apply
(temp sibling + rename) plus append-only file receipts. No timestamps,
randomness, network, interpolation, or executable config anywhere.

## 7. What state must remain derived rather than persisted?

Projection bytes/digests, plan actions, IN_SYNC/DRIFT/UNKNOWN findings, the
lock file (id/output/digest/compiler only — never fact values), and receipt
`after_digest` lineage views. Persisted: authority mode, fact rows +
repository provenance (key/digest/revision/timestamp/writer), receipts as
immutable records.

## 8. Which existing representation objects can be reused?

All verification reuses `@openrecord/representation` with no new engine:
`SourceTargetV1`/`SourceBindingV1` shapes (`types.ts:16-43`),
`RepresentationStore` (`service.ts:15-23`), `collectAndEvaluate`,
`buildGraph` + `deriveFinding` + `compareMoney/Boolean/ExactText`,
`extractJsonLd`, `shouldReuseExtraction`, canonical URL matching, and the
`FACT_SOURCE` target origin (`policy.ts:3-10`). The bridge only synthesizes
target/binding descriptors from projection `verify` blocks and syncs them
idempotently.

## Additional findings

- Money today is free text (`value_text` + `CURRENCY`); the manifest must add
  canonical decimal discipline (scale-preserving, no binary floats) with one
  documented `AuthoritativeFact` bridge encoding + round-trip tests.
- No YAML runtime exists in TS packages (only transitive lockfile hits);
  the truth package adds `yaml` (safe Core schema, no tags/anchors→objects).
- No `.openrecord/` lock/receipt conventions exist; only JEV assay receipts
  (`src/jev_assay.rs`) and `generated_assets` rows — file receipts under
  `.openrecord/receipts/` plus `projections.lock.json` are new but minimal.
- Boundary audit (precondition 2): `readCapped` truncates only when
  `total > maxBytes + 1`, so exactly `maxBytes + 1` bytes are wrongly
  accepted. Fixed as the first commit of this branch with boundary tests.
