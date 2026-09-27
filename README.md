# Ghostping

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust 1.75+](https://img.shields.io/badge/rust-1.75%2B-orange.svg)](https://www.rust-lang.org)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](https://github.com/commonfields/ghostping/releases)

> **The private, local-first GEO companion for indie builders — track, generate, and optimize your visibility in AI answers.**

Ghostping measures how often LLMs mention, cite, and recommend your brand, then generates content to improve those odds. Your audit history lives in local SQLite — no SaaS, no subscriptions.

```
  Mention rate:          67.0% (8/12 responses mentioned)
  Recommendation rate:   25.0% (3/12 responses recommended)
  Citation rate:         16.7% (2 of 12 responses with a project citation)
  Coverage:              12/12 planned queries succeeded
```

---

## How it works

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│   init   │──▶│ prompts  │──▶│  audit   │──▶│  report  │──▶│ generate │
│ project  │   │ discover │   │   run    │   │          │   │ content  │
└──────────┘   └──────────┘   └────┬─────┘   └──────────┘   └──────────┘
                                   │                             │
                                   ▼                             ▼
                            ┌────────────┐               publish it yourself
                            │ audit show │               (site, docs, blog)
                            │  compare   │──▶ re-audit ──▶ compare again
                            └────────────┘
```

One audit run = `prompts × samples × providers` queries against configured LLM providers. Every response is parsed for mentions, recommendations, and citations, stored in `~/.ghostping/evidence.db`, and summarized as rates. Failed queries are counted explicitly — a run with failures is marked `completed_with_errors`, never silently presented as complete.

```
ghostping CLI / TUI / Tauri app
        │  (all drive the same core library)
        ▼
┌───────────────┐  ┌──────────────┐  ┌─────────────┐
│ audit_engine  │  │ parser       │  │ providers   │
│ fan-out +     │  │ mention /    │  │ openai,     │
│ store results │  │ recommend /  │  │ anthropic,  │
└───────┬───────┘  │ cite /       │  │ gemini, xai,│
        │          │ sentiment    │  │ perplexity, │
        ▼          └──────────────┘  │ ollama, mock│
┌───────────────┐                    └─────────────┘
│ evidence.db   │──▶ report_generator ──▶ markdown reports
│ (SQLite)      │
└───────────────┘
```

---

## The honest pitch

- **Local-first.** Audit history, prompts, and reports stay in SQLite on your machine. No telemetry, no sign-up, no cloud DB.
- **Be aware:** measuring visibility means *sending prompts to LLM providers*. Cloud audits (OpenAI, Anthropic, Gemini, xAI, Perplexity) transmit your prompts to that provider — the CLI warns you before it happens. Only Ollama (`localhost`) and `mock` keep everything on your machine.
- **Developer-first.** Scriptable CLI, native ~8.5 MB binary, `--json` output for the evidence workflow.
- **No lock-in.** Plugins for prompt templates. Your data is plain SQLite.

**What Ghostping does:** measures mention/recommendation/citation rates across a prompt set, and drafts citable content for the gaps.

**What it doesn't do:** guarantee citations. GEO depends on your content quality, model training data, and retraining schedules. Scores are estimates — treat them as directional, not definitive.

---

## Installation

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/commonfields/ghostping/main/scripts/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/commonfields/ghostping/main/scripts/install.ps1 | iex

# Or build from source (needs Rust 1.75+)
cargo install --git https://github.com/commonfields/ghostping
git clone https://github.com/commonfields/ghostping && cd ghostping && cargo build --release
# Binary at target/release/ghostping
```

> Homebrew: a `Formula/ghostping.rb` exists in-repo and is filled in during releases. Until release artifacts are published, build from source.

Optional desktop app (Tauri + React, drives the same core library through the legacy workflow):

```bash
cd tauri-app && npm install && npm run tauri dev
```

---

## Quick start (recommended: evidence workflow)

```bash
ghostping quickstart                                        # guided walkthrough
ghostping init --name "MyProject" --website "https://example.com" --yes
ghostping prompts discover                                  # build your prompt set
ghostping audit run --models mock --samples 3               # free end-to-end test
ghostping audit run --models ollama --samples 3             # free local measurement
ghostping audit run --models openai,anthropic --samples 3   # cloud (shows a data notice)
ghostping report --output ./reports/                        # markdown evidence report
ghostping generate --output ./generated/                    # draft content for the gaps
ghostping audit compare --before 1 --after 2                # before/after delta
```

- `--models mock` validates the workflow with synthetic **TEST DATA** — clearly labeled everywhere, never real visibility. No API keys, no cost.
- Cloud runs print a notice: prompts go to the selected provider; history stays local. Pass `--yes` to acknowledge in scripts.
- Zero-cost local option: `ollama pull llama3.2`, set `enabled = true` under `[providers.ollama]` in `~/.ghostping/config.toml`, use `--models ollama`.

Legacy domain workflow (older commands, `mentions.db`, no multi-sample evidence):

```bash
ghostping config                                        # create ~/.ghostping/config.toml
ghostping doctor                                        # verify providers / Ollama
ghostping audit-legacy myproject.com --niche "Rust CLI tool"
ghostping optimize myproject.com --niche "Rust CLI tool" --auto-apply
```

---

## Commands

Evidence workflow (recommended, uses `ghostping.toml` + `evidence.db`):

| Command | Short explanation |
|---|---|
| `init` | Create `ghostping.toml` (name, website, category). `--yes` for scripts, `--force` to overwrite. |
| `prompts discover [--limit]` | Generate project-specific prompts and store them. |
| `prompts list` | Show stored prompts. |
| `prompts templates list\|search\|install` | Browse/install community prompt packs into `~/.ghostping/plugins/`. |
| `audit run [--samples N] [--temperature T] [--models M] [--json] [--yes]` | Run prompts × samples × providers, store responses + citations. Fails loudly if all queries fail; marks partial runs `completed_with_errors`. |
| `audit list [--limit]` | Past runs with mention rate, status, and `[mock test data]` tags. |
| `audit show <id>` | Run detail: coverage, citation split, per-query failure diagnostics. |
| `audit compare --before A --after B [--format json]` | Rate deltas with mock/partial-data warnings. |
| `report [--run ID] [--output DIR] [--full] [--force]` | Markdown evidence report (metrics, model/prompt breakdown, competitors, citations, gaps). |
| `generate [--from-audit latest\|ID] [--output DIR] [--force]` | Draft markdown assets for detected content gaps. |
| `diagnose <url>` | Basic crawlability check (reachability, robots.txt, sitemap, llms.txt). |

Legacy + utility commands (uses `mentions.db` unless noted):

| Command | Short explanation |
|---|---|
| `track <domain> [--prompts FILE] [--judge]` | Run custom prompts from a file, record mentions. |
| `audit-legacy <domain> [--niche] [--competitor] [--judge]` | One-shot scan with built-in prompts. |
| `report-legacy <domain> [--days] [--export csv\|markdown]` | Trend report from history. |
| `optimize <domain> --niche N [--competitors] [--steps] [--dry-run] [--auto-apply] [--plugin]` | 5-step agent: discover → audit → draft → refine → score. Writes to `./geo/` with `--auto-apply`. |
| `generate-legacy "query" [--about] [--niche] [--output] [--evaluate] [--plugin]` | Single-query content draft; `--evaluate` estimates citability lift. |
| `projects [add\|remove]` | Saved domain/niche pairs. |
| `watch <domain> [--interval MIN]` | Re-audit on a timer, notify on drops. |
| `share <domain> [--days] [--format]` | Export a snapshot (markdown/json) to stdout. |
| `stats [domain] [--days]` | Per-day mention/citation breakdown. |
| `publish <domain> [--note]` / `results <domain> [--all]` | Stamp a checkpoint when you publish, then measure lift later. |
| `schedule <domain> [--interval daily\|weekly\|H] [--uninstall]` | Install/remove background audits (launchd/cron). |
| `chat` | Guided TUI: answer 2 questions, runs audit/optimize/generate. |
| `config` / `doctor` / `quickstart` / `docs` | Setup, connectivity check, walkthrough, full command reference. |

---

## Metrics, precisely

For one audit run over successful responses:

- **Mention rate** — % of responses explicitly mentioning your brand.
- **Recommendation rate** — % actively recommending it (stricter than mentioned; keyword heuristic, see `audit_engine.rs`).
- **Citation rate** — % of responses containing ≥1 citation to *your* domain. One response counts once no matter how many links it holds, so this can never exceed 100%. Total extracted URLs are reported separately.
- **Coverage** — `succeeded/planned` queries. Any shortfall is shown and the run is marked `completed_with_errors` or `failed`.
- **Visibility score** — weighted blend (mention 35 / recommend 25 / citation 20 / position+sentiment 20) for rough ranking only. Position/sentiment components are coarse heuristics, not measurements.

Mock runs are synthetic fixtures for pipeline testing. They are labeled `TEST DATA` in terminal output, `audit list/show`, `compare`, and every report — do not quote them as results.

---

## Configuration

Global (`~/.ghostping/config.toml`, `ghostping config` creates it): provider API keys, models, Ollama base URL, judge settings, defaults. Env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `PERPLEXITY_API_KEY`) fill empty keys.

Project (`ghostping.toml`, `ghostping init` creates it):

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

Data locations: `~/.ghostping/evidence.db` (evidence workflow), `~/.ghostping/mentions.db` (legacy), `~/.ghostping/cache/`, `~/.ghostping/plugins/`. Pre-rebrand `~/.llmention/` migrates automatically (original kept).

---

## Project structure

```
src/
  bin/ghostping.rs      CLI (24 top-level commands)
  audit_engine.rs       multi-sample audit runner (planned/succeeded/failed)
  audit_storage.rs      evidence.db DAL + rate math
  report_generator.rs   markdown evidence reports
  tracker.rs / storage.rs / report.rs   legacy domain workflow (mentions.db)
  agent/                optimize loop (discover → audit → draft → refine → score)
  geo/                  legacy generator + evaluator + default prompts
  parser.rs             mention / recommendation / citation / sentiment heuristics
  providers/            openai, anthropic, gemini, xai, perplexity, ollama, mock
  prompt_discovery.rs   evidence prompt templates
  content_generator.rs  gap-based markdown drafts
  project_config.rs     ghostping.toml
  plugins/ marketplace/ prompt packs (6 builtins) + ~/.ghostping installs
  scheduler.rs          launchd / cron install
  tui/                  guided chat mode
  cache.rs config.rs types.rs
templates/community/    example plugin (rust-crate)
tauri-app/              desktop GUI (React + Tauri, legacy workflow)
website/                landing page (Next.js)
scripts/                install.sh, install.ps1, validate-release.sh
.github/workflows/      release.yml (tag builds + Homebrew formula update)
```

---

## Contributing

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --locked        # 53 unit tests
cargo build --release --locked
bash scripts/test-validate-release.sh   # release-script regression tests
bash scripts/validate-release.sh        # full gate (fmt, clippy, test, build, isolated smoke)
```

New provider: implement `LlmProvider` in `src/providers/`, add config in `src/config.rs`, wire into `build_providers_for_project`. New template: folder under `templates/community/<name>/` with `plugin.toml` + prompt files (see `CONTRIBUTING.md`).

---

## Roadmap

| Area | Status |
|---|---|
| Evidence workflow (`init`, `prompts`, `audit run`, `report`, `generate`, `compare`) | ✅ Done |
| Audit correctness (explicit failures, bounded citation rate, mock labeling) | ✅ Done |
| Legacy workflow (`track`, `audit-legacy`, `optimize`, `watch`, `chat`, …) | ✅ Done, maintained |
| Prompt plugins + marketplace skeleton | ✅ Done |
| Desktop app, landing page | ✅ Skeleton (see limitations below) |
| PR CI (fmt/clippy/test/smoke on every PR) | Planned |
| Release hardening (installer checksums, reliable formula update, Linux ARM64) | Planned |
| Desktop parity with evidence workflow | Planned |
| Calibrated scoring to replace heuristic weights | Planned |

Known limitations (tracked, not hidden): Tauri app drives the legacy workflow only and its manifests/icons need attention; `install.sh/ps1` don't verify checksums; `Formula/ghostping.rb` needs published SHAs; generated content drafts contain `[TODO]` scaffolds to fill in; visibility scores are directional estimates.

---

## License

MIT — see [LICENSE](LICENSE).
