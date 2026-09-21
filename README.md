# Ghostping

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust 1.75+](https://img.shields.io/badge/rust-1.75%2B-orange.svg)](https://www.rust-lang.org)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](https://github.com/commonfields/ghostping/releases)

> **The private, local-first GEO companion for indie builders — track, generate, and optimize your visibility in AI answers.**

Ghostping tracks, generates, and optimizes your brand's AI visibility in ChatGPT, Claude, Grok, Perplexity, and any LLM you configure — privately, locally, no SaaS, no subscriptions.

```
  Mention rate   67%  (8/12 queries)  (↑ 24pp vs last run)
  Citations      2
  Models         2/3  (openai, anthropic)
```

---

## The Honest Pitch

- **Private.** Your prompts never leave your machine. No telemetry, no sign-up, no cloud DB.
- **Local-first.** Use your own API keys or run 100% free with [Ollama](https://ollama.com) — no per-query pricing.
- **Developer-first.** Clean CLI, scriptable with `--quiet`, native binary (~7 MB).
- **No lock-in.** Extensible via plugins. Your data stays in SQLite on your machine.

**What Ghostping does:** It measures how often LLMs mention your brand and generates optimized content to improve those odds.

**What Ghostping doesn't do:** It doesn't guarantee citations. GEO results depend on your content quality and model behavior. We help you measure and improve — success requires ongoing effort.

|                    | Ghostping          | The Prompting Company | Enterprise GEO tools |
|--------------------|--------------------|-----------------------|----------------------|
| Managed creation & routing | ✗ | ✓ | ✓ |
| Self-serve tools  | ✓                  | ✗                    | ✗                   |
| Price              | Free / open-source | $50–$500/mo          | $200–$2 000/mo      |
| Data stays local   | ✓                  | ✗ (their servers)    | ✗ (their servers)   |
| Content generation | ✓ built-in         | ✓                    | ✗                   |
| Ollama support     | ✓ fully local      | ✗                    | ✗                   |

---

## Realistic Expectations

GEO is probabilistic — not deterministic. Here is what to expect honestly:

- **Publishing content is step one.** Ghostping generates the content; you must publish it (your site, docs, blog, GitHub) for models to ever see it. A file sitting on your laptop changes nothing.
- **Results emerge over weeks, not hours.** LLMs are retrained or re-indexed on varying schedules. A citation improvement may take days to months to appear in live models.
- **Scores are estimates, not guarantees.** The citability scores from `optimize` and `generate --evaluate` reflect how well your content matches patterns that *current* models tend to cite. Different models, prompt phrasings, and retraining runs will produce different results.
- **Iteration is the strategy.** Run `audit`, publish the generated content, wait, run `audit` again. Track the trend over time with `report` and `stats`. Expect 2–4 audit cycles before seeing meaningful movement.
- **Your mileage will vary.** Crowded niches (e.g. "best JavaScript framework") are harder than specific ones (e.g. "deterministic edge runtime for robotics"). The more precise your niche, the higher your early lift.

---

## Installation

### Pre-built binaries (macOS, Linux, Windows)

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/commonfields/ghostping/main/scripts/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/commonfields/ghostping/main/scripts/install.ps1 | iex
```

### Homebrew

```bash
brew tap commonfields/tap
brew install ghostping
```

### Cargo (build from source)

```bash
cargo install --git https://github.com/commonfields/ghostping
```

### From source

```bash
git clone https://github.com/commonfields/ghostping
cd ghostping
cargo build --release
# Binary at target/release/ghostping (7.5 MB)
```

### Desktop App (optional)

Requires [Node.js 18+](https://nodejs.org) and [Rust](https://rustup.rs).

```bash
cd tauri-app
npm install
npm run tauri dev       # development
npm run tauri build     # release build
```

The desktop app wraps the same core library — identical results to the CLI.

---

## Quick Start

```bash
# Guided interactive walkthrough
ghostping quickstart
```

### New: Evidence-Based Workflow (v0.2+)

The recommended approach using project-level configuration:

```bash
# 1. Initialize a project
ghostping init --name "MyProject" --website "https://example.com" --category "developer tool" --yes

# 2. Discover prompts for your project
ghostping prompts discover

# 3. Run an audit (use --models mock for testing without API keys)
ghostping audit run --models mock --samples 3

# 4. Generate a report
ghostping report --output ./reports/

# 5. Generate content from audit gaps
ghostping generate --output ./generated/
```

### Legacy Quick Start

For the original domain-based workflow:

```bash
ghostping config                                         # 1. create config
# edit ~/.ghostping/config.toml — add API key or enable Ollama
ghostping doctor                                         # 2. verify setup
ghostping audit-legacy myproject.com --niche "Rust CLI tool"   # 3. first scan
ghostping projects add myproject.com --niche "Rust CLI tool"  # 4. save project
ghostping optimize myproject.com --niche "Rust CLI tool" --auto-apply  # 5. improve
```

> **Zero-cost option:** `ollama pull llama3.2` → set `enabled = true` under `[providers.ollama]` → use `--models ollama`

The mock provider validates the local workflow, storage, reports, and generated files. It does not measure real AI visibility. Audits using cloud providers show a notice before prompts are sent to the selected provider with your configured API key.

---

## Evidence-First Workflow (Recommended)

Ghostping v0.2 introduces an **evidence-first approach** with project-level configuration, multi-sample audits, and comprehensive reporting:

```bash
# Initialize a project with ghostping.toml
ghostping init --name "MyProject" --website "https://example.com" --yes

# Discover prompts based on your project config
ghostping prompts discover

# Run evidence-based audit with multiple samples
ghostping audit run --models mock --samples 3

# Generate markdown report
ghostping report --output ./reports/

# Generate content from audit gaps
ghostping generate --output ./generated/

# Compare two audit runs
ghostping audit compare --before 1 --after 2
```

**Key features:**
- **Project config** (`ghostping.toml`) — Define project once, audit repeatedly
- **Multi-sample audits** — Statistical significance with multiple samples per prompt
- **Raw evidence storage** — All responses stored locally for transparency
- **Prompt categorization** — Intent-aware prompts (buyer intent, comparison, etc.)
- **Content gap analysis** — Identify where competitors are mentioned but you're not
- **Before/after comparison** — Track visibility improvements over time

See [docs/v0.2-evidence-engine-guide.md](docs/v0.2-evidence-engine-guide.md) for the complete guide.

---

## Commands

### `optimize` — Full GEO agent

Runs a 5-step autonomous workflow: **discover → audit → identify → generate → evaluate**

```bash
ghostping optimize igrisinertial.com --niche "deterministic edge runtime"
ghostping optimize myproject.com --niche "rust cli tool" --competitors "ripgrep,fd" --steps 5
ghostping optimize myproject.com --niche "observability" --dry-run
ghostping optimize myproject.com --niche "edge AI runtime" --auto-apply
ghostping optimize myproject.com --niche "Rust CLI" --max-rounds 3  # up to 3 refinement rounds
```

**`--max-rounds`** (default: 3) — when a generated section scores below the citability threshold, the agent critiques and rewrites it automatically, showing its reasoning at each step:

```
  → [1/3] "best edge runtime for robotics"…  ✓ (anthropic)
  → Score 28% — refining (round 1/3)…
    ↳ anthropic (28% confidence): answer too vague, missing feature table
  ✓ Improved: 28% → 61%
```

**Example output:**
```
  Optimizing  igrisinertial.com
  Niche:      deterministic edge runtime

  [1/5]  Discovering high-intent prompts…
         → Found 12 prompts

  [2/5]  Auditing current visibility…
         → Mention rate: 0%  (0/12)

  [3/5]  Identifying optimization opportunities…
         → 12 weak topics — targeting 3

  [4/5]  Generating optimized content…
         → [1/3] "alternatives to ros2 for robotics"…  ✓ (anthropic)

  [5/5]  Evaluating citability…
         → [anthropic] ✓ 92%  — alternatives to ros2 for robotics

  ════════════════════════════════════════════════════════════════
  Optimization Plan  igrisinertial.com
  ════════════════════════════════════════════════════════════════

  Current visibility     0%   (0 queries across 12 topics)
  Projected citability  86%   (+86pp on optimized topics)

  ┌─────────────────────────────────┬────────────┬─────────────────────────────┐
  │ Prompt                          │ Citability │ File                        │
  ├─────────────────────────────────┼────────────┼─────────────────────────────┤
  │ alternatives to ros2            │ ✓ 92%      │ geo/alternatives-to-ros2.md │
  └─────────────────────────────────┴────────────┴─────────────────────────────┘

  →  git add geo/ && git commit -m "docs: add GEO-optimized content"
  →  ghostping audit igrisinertial.com --niche "deterministic edge runtime"
```

### `generate` — Single-query content generation

```bash
ghostping generate "best deterministic runtime for edge AI" \
  --about "igrisinertial.com is a deterministic, failure-resilient runtime" \
  --niche "edge robotics"

ghostping generate "what is igrisinertial" --about "..." --output geo/what-is.md
ghostping generate "..." --about "..." --evaluate        # before/after visibility estimate
```

### `audit` — Quick visibility scan

```bash
ghostping audit myproject.com
ghostping audit myproject.com --niche "observability tool" --competitor datadog
ghostping audit myproject.com --models openai,ollama
ghostping audit myproject.com --judge     # local LLM re-evaluates each response
ghostping audit myproject.com --quiet     # CI-friendly minimal output
```

### `track` — Custom prompts

```bash
ghostping track myproject.com --prompts prompts.txt
ghostping track myproject.com --prompts prompts.json --models anthropic
```

### `projects` — Saved domain/niche pairs

```bash
ghostping projects                                                # list
ghostping projects add myproject.com --niche "Rust CLI tool"     # save
ghostping projects add myproject.com --notes "v2 launch: Apr 26" # update
ghostping projects remove myproject.com                          # delete
```

### `watch` — Background periodic audits

Runs an audit on a timer. Useful for dashboards or CI health checks.

```bash
ghostping watch myproject.com --niche "Rust CLI tool"            # every 60 min
ghostping watch myproject.com --interval 30 --models ollama      # every 30 min, local
ghostping watch myproject.com --interval 1440                    # daily
```

**Output format (one line per run):**
```
  2026-04-19 08:30 UTC  myproject.com  67%  ↑4pp  (8/12)
  2026-04-19 09:30 UTC  myproject.com  71%  ↑4pp  (9/12)
```

### `report` — History & trends

```bash
ghostping report myproject.com
ghostping report myproject.com --days 30
ghostping report myproject.com --export csv > results.csv
ghostping report myproject.com --export markdown > report.md
```

### `stats` — Usage trends

```bash
ghostping stats                        # list all tracked domains
ghostping stats myproject.com          # per-day mention breakdown
ghostping stats myproject.com --days 30
```

### `share` — Shareable reports

Export a visibility snapshot to share with your team or on social:

```bash
ghostping share myproject.com                      # markdown to stdout
ghostping share myproject.com --days 30 > report.md
ghostping share myproject.com --format json > report.json
```

### `prompts` — Community template marketplace

```bash
ghostping prompts list                  # browse all available templates
ghostping prompts search rust           # search by keyword or tag
ghostping prompts install rust-crate    # install & customize locally
```

### `plugins` — Plugin management

```bash
ghostping plugins                       # list installed plugins
ghostping plugins enable rust-crate     # mark as active
```

Once installed, apply a plugin with `--plugin`:

```bash
ghostping generate "best rust cli tool" --plugin rust-crate --about "myproject.io is..."
ghostping optimize myproject.com --niche "Rust CLI" --plugin rust-crate --auto-apply
```

### `chat` — Guided TUI assistant

Interactive goal-oriented terminal interface. State a goal, answer 1–2 clarifying questions, and the agent proposes and runs an optimize/generate/audit plan.

```bash
ghostping chat                # launch TUI (arrow keys to scroll, Enter to submit, Ctrl+C to quit)
ghostping chat --models ollama
```

The chat mode is **not** a free-form conversation — it's a focused flow:
1. Enter your domain
2. Enter your niche
3. Choose: audit / optimize / generate
4. Review results inline, then pick what to do next

### `docs` — Command reference

```bash
ghostping docs                         # print full docs as markdown
ghostping docs > COMMANDS.md           # save to file
```

### `quickstart` / `docs` / `config` / `doctor`

```bash
ghostping quickstart    # guided step-by-step beginner flow
ghostping docs          # full command reference as markdown
ghostping docs > COMMANDS.md
ghostping config        # create ~/.ghostping/config.toml
ghostping doctor        # verify config, providers, Ollama connectivity
```

---

## Plugin System

Ghostping supports **prompt plugins** — reusable template packs that specialize content generation for specific niches (Rust crates, Python packages, SaaS products, etc.).

### Built-in templates

| Name | Best for |
|------|----------|
| `rust-crate` | Rust crates and CLI tools |
| `python-package` | Python packages (PyPI) |
| `saas-product` | SaaS products and web apps |
| `open-source` | Any open-source project |
| `technical-blog` | Developer blogs and tutorials |
| `personal-brand` | Indie hackers and personal brands |

### Installing a template

```bash
ghostping prompts install rust-crate
# Files written to ~/.ghostping/plugins/rust-crate/
# Edit generate.prompt.md to customize
```

### Creating your own plugin

```
~/.ghostping/plugins/my-plugin/
  plugin.toml           # name, version, description, tags
  generate.prompt.md    # system prompt for content generation
  discover.prompt.md    # system prompt for prompt discovery (optional)
```

`plugin.toml`:
```toml
[meta]
name = "my-plugin"
version = "1.0.0"
description = "GEO for my niche"
author = "your-name"

[templates]
generate = "generate.prompt.md"
discover  = "discover.prompt.md"
```

Templates support `{about}`, `{niche}`, `{domain}`, `{competitors}` variables.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full plugin authoring guide.

---

## CI / Scripting

Use `--quiet` to suppress progress output and get machine-readable results:

```bash
# In a shell script
RATE=$(ghostping audit myproject.com --quiet 2>/dev/null | grep "Mention rate" | grep -o "[0-9]*%")

# In GitHub Actions
- name: Check GEO visibility
  run: ghostping audit ${{ env.DOMAIN }} --quiet --models ollama
```

---

## Configuration

Config file: `~/.ghostping/config.toml` — run `ghostping config` to create it.

```toml
[providers.openai]
api_key     = "sk-..."
model       = "gpt-4o-mini"
enabled     = true
temperature = 0          # deterministic, cacheable

[providers.anthropic]
api_key     = "sk-ant-..."
model       = "claude-3-5-haiku-20241022"
enabled     = true
temperature = 0

[providers.xai]
api_key     = "xai-..."
model       = "grok-2-latest"
enabled     = false

[providers.perplexity]
api_key     = "pplx-..."
model       = "sonar"
enabled     = false

# Free, unlimited local inference
[providers.ollama]
base_url  = "http://localhost:11434"
model     = "llama3.2"
enabled   = false

[judge]
enabled   = false
base_url  = "http://localhost:11434"
model     = "llama3.2"

[defaults]
days        = 7
concurrency = 5
```

Project config: `ghostping.toml` in your project root — run `ghostping init` to create it.

```toml
[project]
name = "MyProject"
website = "https://example.com"
category = "developer tool"

[providers]
default = "mock"
models = ["mock", "ollama:llama3.2", "openai:gpt-4o-mini"]

[audit]
samples_per_prompt = 3
temperature = 0.2
store_raw_responses = true
```

---

## Migrating from llmention

Ghostping was previously named **llmention**. If you used llmention before:

- Binary `llmention` → `ghostping` (reinstall or `cargo install --git https://github.com/commonfields/ghostping`)
- Config `~/.llmention/` auto-migrates to `~/.ghostping/` on first run (original kept as backup)
- Project `llmention.toml` is still read as a fallback, but new projects use `ghostping.toml` — just rename the file when convenient
- GitHub repo moved from `wiramahendra/llMention` to `commonfields/ghostping` — update your install scripts and bookmarks

No data loss: audits, history, and plugins are copied forward automatically.

---

## How It Actually Works

Ghostping operates in two phases:

### 1. Measurement (audit, track, watch)
The tool sends prompts about your brand to configured LLMs and parses responses for:
- **Mentions** — does the model mention your brand?
- **Citations** — does it cite your website/content?
- **Sentiment** — positive, neutral, or negative?

Results are stored locally in SQLite. Run audits over time to track trends.

### 2. Optimization (generate, optimize)
- **`generate`**: Creates LLM-citable markdown content for a target query
- **`optimize`**: Autonomous 5-step agent that discovers weak topics → audits → generates content → evaluates citability

**Important:** Ghostping improves the *probability* of mentions and citations. It cannot guarantee them. GEO success depends on:
- Your content quality and relevance
- Model training data and behavior
- Competitor presence in your niche
- Ongoing iteration and testing

---

## Built With

- **Rust** — native binary, no runtime required
- **Tauri** — optional desktop GUI
- **SQLite** — local data storage
- **Ollama** — free local LLM inference
- **clap** — CLI argument parsing
- **tokio** — async runtime

---

## Project Structure

```
src/
  bin/ghostping.rs        CLI entrypoint (clap, 15 commands)
  agent/
    optimizer.rs          5-step GEO agent with iterative refinement
    refiner.rs            GEO critic — critiques and rewrites low-scoring content
    plan.rs               OptimizationPlan structs
  geo/
    generator.rs          GEO content generation (plugin-aware)
    evaluator.rs          Before/after citability scoring
    prompts.rs            Template loading, default_prompts()
    templates/            Embedded .prompt.md files (incl. refine.prompt.md)
  tui/
    chat.rs               Ratatui guided chat mode (ghostping chat)
  marketplace/
    registry.rs           Built-in template catalog (6 niches)
    builtin.rs            Embedded template strings
  plugins/
    manifest.rs           PluginManifest / PluginMeta structs
    loader.rs             Plugin discovery from ~/.ghostping/plugins/
  providers/              LlmProvider trait + OpenAI, Anthropic, xAI, Perplexity, Ollama
  tracker.rs              Parallel query orchestrator
  parser.rs               Mention/citation/sentiment detection
  cache.rs                24-hour file cache
  storage.rs              SQLite (mentions + projects + stats)
  report.rs               Terminal output + CSV/Markdown/JSON export
  types.rs                Shared types

templates/community/      Example community plugins (submit PRs here)
  rust-crate/             Rust crate optimizer template

tauri-app/                Optional desktop GUI (Tauri v2 + React)
  src/                    React frontend (TypeScript)
  src-tauri/              Rust backend (Tauri commands)

scripts/
  install.sh              Unix installer
  install.ps1             Windows installer

.github/workflows/
  release.yml             Multi-platform GitHub Releases CI
```

---

## Contributing

```bash
cargo test        # 23 unit tests
cargo clippy
cargo build --release
ls -lh target/release/ghostping   # must stay under 10 MB
```

To add a new provider: implement `LlmProvider` in `src/providers/`, add config fields in `src/config.rs`, wire it in `tracker::build_providers`.

To add a community template: see [CONTRIBUTING.md](CONTRIBUTING.md) — create a folder under `templates/community/<name>/` with a `plugin.toml` and prompt files.

PRs welcome.

---

## Roadmap

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | `audit`, `track`, `report`, `config`, `doctor` | ✅ Done |
| 2 | `generate` — GEO-optimized markdown | ✅ Done |
| 3 | `optimize` — 5-step GEO agent | ✅ Done |
| 3 | `projects`, `watch`, `--quiet`, desktop app skeleton | ✅ Done |
| 4 | `prompts`, `plugins`, `share`, `stats`, `docs` | ✅ Done |
| 4 | Plugin system + community template marketplace | ✅ Done |
| 5 | `quickstart`, launch polish, EXAMPLES.md | ✅ Done |
| 6 | `chat` TUI, iterative refinement (`--max-rounds`), Refiner module | ✅ Done |
| 7 | Ghostping rebrand (binary, config, docs) | ✅ Done |
| 7 | Self-hosted web dashboard | Planned |
| 7 | Community prompt registry (web-hosted) | Planned |

---

## License

MIT — see [LICENSE](LICENSE).
