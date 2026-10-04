# Ghostping

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 24](https://img.shields.io/badge/node-%3E%3D24-green.svg)](https://nodejs.org)
[![Rust 1.75+](https://img.shields.io/badge/rust-1.75%2B-orange.svg)](https://www.rust-lang.org)

> **Know what AI tells customers about your company, trace important problems to evidence, correct what you control, and verify what changes afterward.**

Ghostping is an AI Representation Integrity system. A business records what it says is true, Ghostping observes what AI answers and owned web sources say, human reviewers judge the mismatches, operators record corrections, and re-observation verifies what changed — with explicit unknowns and no causal claims.

> Observation is not interpretation. Interpretation is not authority. Correlation is not causality. Unknown is not false.

---

## How it works

```
KNOW            OBSERVE            DIAGNOSE              ACT             VERIFY / RE-OBSERVE
Approved facts  AI answers via     Claims + human        Recorded        Source re-checks,
 questions  →   provider checks;   judgments → issues;   interventions   discovery scans,
                owned-site         candidates from       (manual)        AI rechecks →
                discovery          discovery                        recorded outcomes
```

One loop, fully evidenced: every state derives from append-only rows in PostgreSQL. Nothing is scored, nothing auto-remediates, and no dashboard ever claims a source change *caused* an AI answer change.

---

## Quick start

Prerequisites: Node 24, pnpm 10+, PostgreSQL (16 in CI/prod; local 14 works for dev).

```bash
git clone https://github.com/commonfields/ghostping && cd ghostping
pnpm install

# Database
export DATABASE_URL=postgres://localhost:5432/ghostping
createdb ghostping
pnpm db:migrate
pnpm db:seed   # optional Northstar demo business

# Run everything (three terminals)
pnpm --filter @ghostping/api dev       # :3001
pnpm --filter @ghostping/worker dev    # background check + discovery runs
pnpm --filter @ghostping/web dev       # :3000
```

Open `http://localhost:3000`, sign up, and walk the loop:

1. **Truth** — add approved facts (what your business stands behind).
2. **Checks** — ask buyer questions, run checks (`mock` is free and offline; one pinned live model via `9router`).
3. **Issues** — review AI claims, record verdicts; contradictions become issues.
4. **Representations** — track owned/third-party sources, verify them on demand.
5. **Discovery** — scan your own site for pages repeating known fact values (current, historical, or mixed).
6. **Record action → Verify source → Recheck AI** — act manually, record it, re-observe, compare. Outcomes are derived (`OBSERVED_CORRECTION`, `NO_OBSERVED_CHANGE`, `INDETERMINATE`), never asserted.

Demo shortcut: run checks with the `mock` provider — deterministic, offline, and free. No keys needed.

---

## Product principles

- **Evidence over scores.** No accuracy score, visibility score, or ranking anywhere. Concrete issues, concrete evidence, concrete before/after observations.
- **UNKNOWN is a state.** Missing evidence reads as unknown — never as absence, never as proof.
- **Humans judge, machines observe.** No LLM classifiers; reviewer verdicts are the only judgments.
- **Candidates are not verdicts.** Discovery finds pages that *appear* to contain known values; only explicitly tracked representations produce findings.
- **Tenancy everywhere.** Every row is account-scoped; cross-account reads behave as 404.

---

## Architecture

```
apps/web       React 19 + Vite + Tailwind — Overview, Checks, Issues, Truth, Representations, Discovery
apps/api       Effect HTTP API (HttpRouter + Schema boundary, session auth, account scoping)
apps/worker    Two bounded Effect fiber loops: AI CheckRuns + Discovery scans (leases, retries, 304 reuse)
packages/db    Effect repositories over @effect/sql-pg — the only persistence (PostgreSQL, 15 migrations)
packages/*     domain · contracts · config · protocol · providers (mock + 9router) ·
               representation (safe HTTP, extractors, comparators) · discovery (robots/sitemap/frontier/matcher) · truth
```

Key docs: [Effect runtime](docs/engineering/effect-runtime-v1.md) · [Evidence protocol](docs/protocol/README.md) · [Product remap](docs/product/product-remap-v1.md) · [Roadmap](docs/product/roadmap.md) (max 3 milestones).

---

## Configuration

```bash
DATABASE_URL=postgres://localhost:5432/ghostping  # required
PORT=3001                                         # API (default)
APP_BASE_URL=http://localhost:3000                # cookie `secure` flag
WORKER_POLL_MS=1000                               # worker idle poll
NINE_ROUTER_API_KEY=                              # only for the pinned live model
NINE_ROUTER_ENABLED=true                           # default false; mock otherwise
```

Live provider calls cost money and send prompts to the provider. `mock` is deterministic, offline, and free — use it for development and tests.

---

## CLI and desktop

The local-first Rust CLI (`src/`, `ghostping` binary: audits, prompt packs, TUI, scheduler) and the Tauri desktop app (`tauri-app/`) are **separate supported products** with their own release pipeline (see [CONTRIBUTING](CONTRIBUTING.md), `scripts/install.sh`, `Formula/ghostping.rb`). They share no runtime with the hosted stack above; their GEO rates are directional measurements, not evidence packets.

---

## Contributing

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # hosted stack
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --locked
```

One product-remap rule governs both: every milestone must reduce time-to-first-sale or compound the validated moat — otherwise it stays frozen. See [CONTRIBUTING](CONTRIBUTING.md).

---

## License

MIT — see [LICENSE](LICENSE).
