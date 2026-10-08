# Contributing to OpenRecord

Thank you for your interest in contributing! OpenRecord is an evidence system for AI representation
integrity. Contributions that keep the evidence honest are most welcome — see the design rules in the
[README](README.md#design-rules).

> **Two codebases live here.** The TypeScript monorepo (`apps/`, `packages/`) is the product. The Rust
> CLI (`src/`) is a frozen legacy tool described in
> [README](README.md#the-openrecord-cli-is-a-separate-legacy-tool). Most contributions target the
> monorepo.

## Maintaining the legacy CLI

Everything below this line documents the frozen Rust CLI for maintainers. Skip it unless you are
fixing a security or correctness defect.

`templates/community/`, `src/providers/`, and the plugin manifest format are CLI-only concepts. They
do not exist in the product and are not being extended.

---

## Types of Contributions

| Type | Where |
|------|-------|
| Product bug fixes | `apps/api`, `apps/worker`, `apps/web` — open a PR with a test |
| Evidence semantics | `packages/protocol`, `packages/representation` |
| Database schema | `packages/db/migrations/` — see the migration rules below |
| Providers | `packages/providers` |
| Documentation | `README.md`, `CONTRIBUTING.md`, `docs/` |

---

## Dev Setup (product)

Prerequisites: Node.js 24 (`.node-version`), pnpm 10.12.1, and PostgreSQL 16.

```bash
git clone https://github.com/commonfields/openrecord
cd openrecord
pnpm install --frozen-lockfile

docker compose up -d postgres
export DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord"
pnpm db:migrate

pnpm typecheck   # must pass
pnpm lint        # must pass, zero warnings
pnpm test        # must pass
pnpm build
```

Two tests assert PostgreSQL ≥ 16. On PostgreSQL 14 those two version assertions fail; that is an
environment limitation, not a code defect.

### Migrations

`packages/db/src/migrate.ts` re-applies **every** `.sql` file on each run under an advisory lock.
There is no applied-migrations table, so each file must be idempotent (`IF NOT EXISTS`,
`DROP TRIGGER IF EXISTS`, `CREATE OR REPLACE`).

**Applied migrations are behavior-frozen.** `migrate.ts` re-runs every file on every migrate (there
is no ledger), so each file must stay idempotent, and an edit to an existing file must not change the
schema a full migrate leaves behind — comments, or a definition a later migration already replaces.
Behavior changes go in a new numbered migration: `0017_authority_sync_rebrand.sql` redefines a
function rather than changing what `0005` leaves in place.

---

## Dev Setup (legacy Rust CLI)

Frozen. Changes are not currently accepted unless they fix a security or correctness defect.

```bash
cargo build --release
cargo test        # 165 tests
cargo fmt --check && cargo clippy -D warnings
```

Binary must stay under **10 MB**:
```bash
ls -lh target/release/openrecord
```

The sections below document the legacy plugin and provider systems for maintainers.

---

## Creating a Community Prompt Plugin

Plugins live in `~/.openrecord/plugins/<name>/` at runtime, and can be submitted to the repo under `templates/community/<name>/`.

### Structure

```
templates/community/my-plugin/
  plugin.toml           # manifest
  generate.prompt.md    # system prompt for content generation
  discover.prompt.md    # system prompt for prompt discovery (optional)
```

### `plugin.toml` format

```toml
[meta]
name = "my-plugin"
version = "1.0.0"
description = "GEO optimization for <your niche>"
author = "your-github-handle"
tags = ["tag1", "tag2"]

[templates]
generate = "generate.prompt.md"
discover = "discover.prompt.md"   # optional
```

### Template variables

Both template files support these variables, substituted at runtime:

| Variable | Replaced with |
|----------|--------------|
| `{about}` | Value of `--about` flag |
| `{niche}` | Value of `--niche` flag |
| `{domain}` | Target domain being optimized |
| `{competitors}` | Comma-separated competitor list |

### `generate.prompt.md` guidelines

This is the **system prompt** for the content generation step. Write it to guide the LLM toward producing content that will be cited by other LLMs.

Key rules:
- Start with a one-sentence entity definition
- Specify the expected structure (H2 sections, bullet lists, code examples)
- Set a target word count (400–700 words is optimal)
- Avoid subjective claims — factual descriptions cite better
- Mention relevant platforms, registries, or ecosystems by name

### `discover.prompt.md` guidelines

This is the **system prompt** for prompt discovery. The model will be given domain/niche/competitors and should return a JSON array of 10–15 high-intent search queries.

Required format instruction (include this in your template):
```
Return ONLY a valid JSON array of strings. No markdown, no explanations.
Example: ["query one", "query two"]
```

### Testing your plugin locally

```bash
# Install it
cp -r templates/community/my-plugin ~/.openrecord/plugins/

# Use it
openrecord generate "target query" --about "myproject.io is a ..." --plugin my-plugin
openrecord optimize myproject.com --niche "my niche" --plugin my-plugin --dry-run
```

### Submitting a plugin

1. Fork the repository
2. Add your plugin under `templates/community/<name>/`
3. Test it against at least one real domain
4. Open a PR with a short description of the niche it targets

---

## Adding a New Provider

1. Create `src/providers/<name>.rs` implementing the `LlmProvider` trait:

```rust
use async_trait::async_trait;
use crate::providers::LlmProvider;

pub struct MyProvider { /* fields */ }

#[async_trait]
impl LlmProvider for MyProvider {
    fn name(&self) -> &str { "myprovider" }

    async fn query(&self, prompt: &str) -> anyhow::Result<String> {
        // HTTP call to the API
        todo!()
    }

    async fn query_with_system(&self, system: Option<&str>, prompt: &str) -> anyhow::Result<String> {
        // HTTP call with system message support
        todo!()
    }
}
```

2. Add config fields in `src/config.rs` under `ProvidersConfig`
3. Wire it in `src/tracker.rs` → `build_providers_filtered()`
4. Add a `doctor` check in `src/bin/openrecord.rs` → `run_doctor()`

---

## Code Style

- Rust edition 2021
- `cargo fmt` before every commit
- `cargo clippy -- -D warnings` must pass
- No unsafe code
- Prefer `anyhow::Result` for error propagation
- Keep functions short and single-purpose

---

## Binary Size Budget

| Phase | Budget |
|-------|--------|
| Current | 7.3 MB |
| Hard limit | 10 MB |

Check before submitting:
```bash
cargo build --release && ls -lh target/release/openrecord
```

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
