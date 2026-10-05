# Ghostping

[![CI](https://github.com/commonfields/ghostping/actions/workflows/ci.yml/badge.svg)](https://github.com/commonfields/ghostping/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/commonfields/ghostping?display_name=tag&sort=semver)](https://github.com/commonfields/ghostping/releases/latest)
[![License: MIT](https://img.shields.io/github/license/commonfields/ghostping)](LICENSE)

> Find what AI gets wrong about your business, trace it to evidence, correct what you control, and verify what changes.

Ghostping is an evidence system for AI representation integrity. It records what a business says is true, observes what AI systems and web sources say, lets people review the difference, and verifies corrective work.

It does not turn incomplete evidence into a score or claim that one change caused another:

> Observation is not interpretation. Interpretation is not authority. Correlation is not causality. Unknown is not false.

## Contents

- [Who it's for](#who-its-for)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [What Ghostping does and doesn't do](#what-ghostping-does-and-doesnt-do)
- [Security and privacy](#security-and-privacy)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Who it's for

- Businesses that want to know what AI systems say about them, with evidence attached.
- Teams responsible for business facts who need one place to record what the business stands behind.
- Reviewers who decide which differences matter and what to fix on surfaces they control.

What you get: a record of approved facts, observations with provenance, human-reviewed issues, documented corrections, and re-observation results.

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

- **Evidence over scores.** Ghostping shows concrete observations and issues, not an opaque accuracy or visibility score.
- **Unknown stays unknown.** Missing, failed, or ambiguous evidence is never treated as false.
- **People make judgments.** Machines collect observations; reviewers decide what those observations mean.
- **Verification is not causation.** A before-and-after change can be recorded without claiming what caused it.

## Quick start

### Check what AI says from your terminal

On macOS or Linux, install the latest CLI release:

```bash
curl -fsSL https://raw.githubusercontent.com/commonfields/ghostping/main/scripts/install.sh | bash
```

The installer verifies the download before installing. On Windows, use [`scripts/install.ps1`](scripts/install.ps1). To build from source instead:

```bash
cargo build --release --locked
./target/release/ghostping quickstart
```

### Use the hosted web app

Prerequisites: Node.js 24 (see [`.node-version`](.node-version)), pnpm, and PostgreSQL 16.

```bash
git clone https://github.com/commonfields/ghostping.git
cd ghostping
pnpm install --frozen-lockfile
```

Prepare the database (credentials must match `compose.yaml`):

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://ghostping:ghostping@localhost:5432/ghostping"
pnpm db:migrate
# Minimal seed (one business, no login): pnpm db:seed
# Full five-company demo (login demo@northstar.test / password123): pnpm db:seed:demo
```

Start each service in its own terminal from the repository root.
Every terminal needs `DATABASE_URL` (prefix each command or re-export it):

```bash
# Terminal 1: HTTP API on port 3001
DATABASE_URL="postgres://ghostping:ghostping@localhost:5432/ghostping" pnpm --filter @ghostping/api dev

# Terminal 2: AI-check and discovery workers
DATABASE_URL="postgres://ghostping:ghostping@localhost:5432/ghostping" pnpm --filter @ghostping/worker dev

# Terminal 3: web app on port 3000
DATABASE_URL="postgres://ghostping:ghostping@localhost:5432/ghostping" pnpm --filter @ghostping/web dev
```

Open [http://localhost:3000](http://localhost:3000), create an account and business, add approved facts, and run a check. The default mock provider is deterministic, offline, and needs no credentials. Live providers are optional and off by default.

### For developers

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## What Ghostping does and doesn't do

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

- [Evidence protocol](docs/protocol/README.md)
- [Representation graph](docs/representation-graph/README.md)
- [Truth projection](docs/truth/README.md)
- [Product roadmap](docs/product/roadmap.md)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and how to submit changes.

## License

Ghostping is available under the [MIT License](LICENSE).
