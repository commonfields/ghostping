# Contributing to OpenRecord

Thank you for your interest in contributing! OpenRecord is built for indie hackers and open-source maintainers — contributions that keep it fast, local, and useful are most welcome.

---

## Types of Contributions

| Type | Where |
|------|-------|
| Bug fixes | `src/` — open a PR with a test |
| New providers | `src/providers/` |
| Prompt templates | `templates/community/` |
| CLI polish | `src/bin/openrecord.rs` |
| Tauri desktop | `tauri-app/` |
| Documentation | `README.md`, `CONTRIBUTING.md` |

---

## Dev Setup

```bash
git clone https://github.com/commonfields/openrecord
cd openrecord
cargo build --release
cargo test        # must pass all 23 tests
cargo clippy
```

Binary must stay under **10 MB**:
```bash
ls -lh target/release/openrecord
```

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
