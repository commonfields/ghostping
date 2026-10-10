# OpenRecord

[![CI](https://github.com/commonfields/openrecord/actions/workflows/ci.yml/badge.svg)](https://github.com/commonfields/openrecord/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/commonfields/openrecord?display_name=tag&sort=semver)](https://github.com/commonfields/openrecord/releases/latest)
[![License: MIT](https://img.shields.io/github/license/commonfields/openrecord)](LICENSE)

> Show clients exactly what AI said before and after your work.

OpenRecord is an evidence system for agencies that improve how AI describes or recommends their clients. Each business gets a workspace that records approved truth, observes what live AI surfaces answer, lets people review the gap, records the agency's corrective work, and re-checks weekly. Each client gets a shareable record: one read-only, revocable URL with the approved facts, the exact AI answers, their sources, the human judgments, and the observed before/after outcome.

It does not turn incomplete evidence into a score or claim that one change caused another:

> Observation is not interpretation. Interpretation is not authority. Correlation is not causality. Unknown is not false.

## Contents

- [Who it's for](#who-its-for)
- [How it works](#how-it-works)
- [The workspace](#the-workspace)
- [AI providers](#ai-providers)
- [Quick start](#quick-start)
- [What OpenRecord does and doesn't do](#what-openrecord-does-and-doesnt-do)
- [Security and privacy](#security-and-privacy)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Who it's for

- Agencies that improve how AI describes or recommends their clients, and need before-and-after evidence they can forward to those clients.
- The people at those agencies who agree the facts with each client, review what the AI said, and fix what they control.

What you get per client: one read-only, revocable URL showing three approved facts, the question asked about each, the exact answers one live AI surface gave, the sources cited, a human judgment per answer, and the weekly re-check with its observed outcome. The operator workflow is described in [the agency record runbook](docs/product/agency-record-v1-runbook.md).

## How it works

```mermaid
flowchart TB
    truth["Approved truth<br/>Facts the business stands behind"]
    observe["Observation<br/>What AI answers and sources say"]
    review["Human review<br/>Compare observations against approved truth"]
    correction["Recorded correction<br/>What was changed on surfaces you control"]
    verification["Verification<br/>Re-observe the source and AI, then derive OBSERVED_CORRECTION, NO_OBSERVED_CHANGE, or INDETERMINATE"]
    monitor["Continue observing<br/>No issue or unknown stays open for the next cycle"]

    truth --> observe --> review --> correction --> verification
    review --> monitor
```

The flow reads top to bottom, from the smallest input to the broadest result. Each stage has one responsibility: business truth, machine observation, human review, operator action, and verification. Evidence from every stage is kept, and later observations begin the same process again without implying causation.

### Design rules

- **Evidence over scores.** OpenRecord shows concrete observations and issues, not an opaque accuracy or visibility score.
- **Unknown stays unknown.** Missing, failed, or ambiguous evidence is never treated as false.
- **People make judgments.** Machines collect observations; reviewers decide what those observations mean.
- **Verification is not causation.** A before-and-after change can be recorded without claiming what caused it.

## The workspace

Every business has the same seven sections, in operational order:

- **Overview** — answers collected, supported share, wrong / partially-correct / needs-review counts, and checks run, each with a trend; verdict share per day; answers by provider; answers by question and by approved fact; citations returned with answers; and the client record's aggregate outcomes.
- **Prospect assay** — approve a public source for fetching, confirm machine-proposed facts, run repeated observations of one question, and review candidate findings. Nothing unconfirmed takes part in comparisons.
- **Search** — register the business website, run inspections, and work findings (missing titles, broken canonicals, blocked pages) through proposal, approval, fix, and verification.
- **Issues** — every claim that disagrees with approved truth, grouped and triaged, with review, re-check, and source verification on each.
- **Representations** — watched web sources against approved facts: in sync, drifted, or unknown, with latest-check state shown honestly.
- **Truth** — the approved facts with versions and provenance, including repository-managed facts that can only change through the manifest.
- **Checks** — the buyer questions, the providers asked, every run with its state, and re-running on demand.

**Clients** (agency section) holds the per-client records and their share links; **All businesses** is the portfolio view with attention, accuracy, and last-checked state per business.

## AI providers

Providers are explicit and never substituted: a check asks exactly the configured provider and model, or it fails visibly.

- **Mock** (default) — deterministic, offline, needs no credentials. Answers are synthetic and labelled as such; they can never produce an observed correction.
- **9Router** — live multi-model gateway. Requires an endpoint, API key, and comma-separated `NINE_ROUTER_MODELS` allowlist; see [`.env.example`](.env.example). Every check must request one allowlisted direct model.
- **Gemini API with Google Search grounding** — the client record's live surface only (not a general check provider). Set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`, default `gemini-2.5-flash`) for the worker.

New providers are added as explicit adapters with declared capabilities; absent grounding, citation, or identity metadata is never fabricated into evidence.

## Quick start

### Use the web app

This is the product. Prerequisites: Node.js 24 (see [`.node-version`](.node-version)), pnpm, and PostgreSQL 16.

```bash
git clone https://github.com/commonfields/openrecord.git
cd openrecord
pnpm install --frozen-lockfile
```

Prepare the database (credentials must match `compose.yaml`):

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord"
pnpm db:migrate
# Minimal seed (one business, no login): pnpm db:seed
# Full five-company demo (login demo@northstar.test / password123): pnpm db:seed:demo
```

Start each service in its own terminal from the repository root.
Every terminal needs `DATABASE_URL` (prefix each command or re-export it):

```bash
# Terminal 1: HTTP API on port 3001
DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord" pnpm --filter @openrecord/api dev

# Terminal 2: AI-check and discovery workers
DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord" pnpm --filter @openrecord/worker dev

# Terminal 3: web app on port 3000
DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord" pnpm --filter @openrecord/web dev
```

Open [http://localhost:3000](http://localhost:3000), create an account, and add a client under **Clients**. Without a `GEMINI_API_KEY`, record checks fail visibly as unsupported; nothing falls back to another model. For an offline local walkthrough only, start the API with `RECORD_PROVIDER=mock RECORD_ALLOW_FIXTURE=1`: those answers are synthetic, labelled as such, and can never produce an observed correction.

### The `openrecord` CLI is a separate, legacy tool

The repository also ships a Rust CLI under [`src/`](src) with its own release pipeline. It is a
**different product** with different rules: it produces visibility and accuracy **scores**, generates
content, and targets a different audience. It shares no runtime, data, or auth with the web app
described above.

It is frozen and not part of the evidence system. If you are evaluating OpenRecord or contributing to
the product, use the web app instructions above.

The hosted Effect adapters and environment configuration are the evidence product's execution boundary.
The Rust `LlmProvider` trait, `openrecord.toml`, per-user CLI configuration, and Tauri app belong to the
legacy runtime. They are not alternative provider backends for the hosted worker. Shared evidence
protocol fixtures do not imply shared execution, persistence, or permissions.

On macOS or Linux, the last published CLI release installs with:

```bash
curl -fsSL https://raw.githubusercontent.com/commonfields/openrecord/main/scripts/install.sh | bash
```

On Windows, use [`scripts/install.ps1`](scripts/install.ps1). To build from source instead:

```bash
cargo build --release --locked
./target/release/openrecord quickstart
```

### For developers

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

Live 9Router checks require an endpoint, API key, and comma-separated `NINE_ROUTER_MODELS` allowlist; see [`.env.example`](.env.example) for the complete configuration. Configuration fails closed when any value is invalid, and every check must request one allowlisted direct model. OpenRecord never substitutes another model. `NINE_ROUTER_MODEL` remains a temporary single-model compatibility option and is ignored when `NINE_ROUTER_MODELS` is set.

## What OpenRecord does and doesn't do

Does:

- Store the facts a business stands behind, with explicit authority.
- Collect AI answers and web-source evidence with provenance.
- Leave review decisions to people, and record corrections on surfaces you control.
- Re-observe and derive `OBSERVED_CORRECTION`, `NO_OBSERVED_CHANGE`, or `INDETERMINATE`.

Doesn't:

- Produce accuracy or visibility scores from incomplete evidence.
- Treat missing, failed, or ambiguous evidence as false. It stays `UNKNOWN` and open for the next cycle.
- Claim that a correction caused a later AI answer.

## Security and privacy

- Your data lives in your own PostgreSQL database.
- Each account only sees its own businesses and evidence.
- Live AI providers are off by default. Enabling one may cost money and sends prompts to an external service.
- Provider credentials are never stored as evidence and should never be committed.
- Source collection is bounded; discovery does not crawl without limits.
- A recorded correction proves that work was recorded, not that it was deployed, indexed, or responsible for a later AI answer.

## Documentation

- [Hosted observation capabilities](docs/engineering/hosted-observation-capabilities-v1.md)
- [Evidence protocol](docs/protocol/README.md)
- [Representation graph](docs/representation-graph/README.md)
- [Truth projection](docs/truth/README.md)
- [Product roadmap](docs/product/roadmap.md)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and how to submit changes.

## License

OpenRecord is available under the [MIT License](LICENSE).
