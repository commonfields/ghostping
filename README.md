# Ghostping

[![CI](https://github.com/commonfields/ghostping/actions/workflows/ci.yml/badge.svg)](https://github.com/commonfields/ghostping/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/commonfields/ghostping?display_name=tag&sort=semver&color=7c3aed)](https://github.com/commonfields/ghostping/releases/latest)
[![License: MIT](https://img.shields.io/github/license/commonfields/ghostping?color=2563eb)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![pnpm 10.12.1](https://img.shields.io/badge/pnpm-10.12.1-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Rust stable](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)

> Find what AI gets wrong about your business, trace it to evidence, correct what you control, and verify what changes.

Ghostping is an evidence system for AI representation integrity. It records what a business says is true, observes what AI systems and web sources say, lets people review the difference, and measures the result of corrective work.

It does not turn incomplete evidence into a score or claim that one change caused another:

> Observation is not interpretation. Interpretation is not authority. Correlation is not causality. Unknown is not false.

## How it works

```mermaid
%%{init: {"flowchart": {"useMaxWidth": true, "htmlLabels": true, "curve": "basis"}}}%%
flowchart LR
    truth["<b>1. Truth</b><br/>Approved facts"]
    observe["<b>2. Observe</b><br/>AI and source evidence"]
    review["<b>3. Review</b><br/>Human judgment"]
    correct["<b>4. Correct</b><br/>Record action"]
    verify["<b>5. Verify</b><br/>Recheck source and AI"]

    truth --> observe --> review
    review -->|Issue found| correct --> verify
    review -. No issue or unknown .-> observe
    verify -. Re-observe .-> observe

    classDef truth fill:#DCFCE7,stroke:#15803D,color:#14532D,stroke-width:2px;
    classDef observe fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A,stroke-width:2px;
    classDef review fill:#FEF3C7,stroke:#D97706,color:#78350F,stroke-width:2px;
    classDef correct fill:#FCE7F3,stroke:#DB2777,color:#831843,stroke-width:2px;
    classDef verify fill:#EDE9FE,stroke:#7C3AED,color:#4C1D95,stroke-width:2px;

    class truth truth;
    class observe observe;
    class review review;
    class correct correct;
    class verify verify;
    linkStyle default stroke:#64748B,stroke-width:2px;
```

The diagram scales to the available width and keeps each responsibility distinct: business truth, machine observation, human review, operator action, and verification. Ghostping stores the evidence behind every stage in PostgreSQL and derives outcomes as `OBSERVED_CORRECTION`, `NO_OBSERVED_CHANGE`, or `INDETERMINATE`.

### Design rules

- **Evidence over scores.** Ghostping shows concrete observations and issues, not an opaque accuracy or visibility score.
- **Unknown stays unknown.** Missing, failed, or ambiguous evidence is never treated as false.
- **People make judgments.** Machines collect observations; reviewers decide what those observations mean.
- **Verification is not causation.** A before-and-after change can be recorded without claiming what caused it.

## Hosted quick start

### Prerequisites

- Node.js 24, as pinned in [`.node-version`](.node-version)
- pnpm 10.12.1
- PostgreSQL 16 recommended, matching CI

### 1. Install dependencies

```bash
git clone https://github.com/commonfields/ghostping.git
cd ghostping
pnpm install --frozen-lockfile
```

### 2. Prepare the database

```bash
createdb ghostping
export DATABASE_URL="postgres://localhost:5432/ghostping"
pnpm db:migrate
```

Optional: load five deterministic product-surface demo businesses.

```bash
pnpm db:seed
```

### 3. Start the hosted services

Run each service in a separate terminal from the repository root. Keep `DATABASE_URL` available in the API and worker terminals.

```bash
# Terminal 1: HTTP API on port 3001
pnpm --filter @ghostping/api dev

# Terminal 2: AI-check and discovery workers
pnpm --filter @ghostping/worker dev

# Terminal 3: web app on port 3000
pnpm --filter @ghostping/web dev
```

Open [http://localhost:3000](http://localhost:3000), create an account and business, add approved facts, and run a check. The default `mock` provider is deterministic, offline, and requires no credentials.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | None | PostgreSQL connection used by the API, worker, migrations, and seed command. |
| `PORT` | No | `3001` | Hosted API port. |
| `APP_BASE_URL` | No | `http://localhost:3000` | Web origin used to decide whether session cookies require `Secure`. |
| `WORKER_POLL_MS` | No | `1000` | Idle worker poll interval; accepted range is 1–60,000 ms. |
| `NINE_ROUTER_ENABLED` | No | `false` | Enables the live provider path. Keep disabled for local development and tests. |
| `NINE_ROUTER_BASE_URL` | When customized | `http://localhost:20128/v1` | 9Router-compatible endpoint; only HTTPS or an exact loopback HTTP address is accepted. |
| `NINE_ROUTER_API_KEY` | When live provider is enabled | None | Provider credential. Never commit or log it. |
| `NINE_ROUTER_MODELS` | When live provider is enabled | None | Comma-separated allowlist of explicit direct model IDs. Empty entries and duplicates are rejected. |
| `NINE_ROUTER_MODEL` | No | None | Temporary compatibility path for one model; ignored when `NINE_ROUTER_MODELS` is set. |
| `NINE_ROUTER_TIMEOUT_MS` | No | `60000` | Live request timeout; accepted range is 1–300,000 ms. |
| `PROVIDER_RESPONSE_MAX_BYTES` | No | `2097152` | Maximum captured provider response size; hard-capped at 16 MiB. |

Live provider calls may cost money and send prompts to an external service. Enabling the provider fails closed when its endpoint, key, or model allowlist is invalid. Each 9Router CheckRun must explicitly request one allowlisted model; Ghostping never substitutes another model. Use the mock provider for normal development and automated tests.

## Architecture

| Area | Responsibility |
| --- | --- |
| [`apps/web`](apps/web) | React 19, Vite, Tailwind CSS, and Radix UI workspace for overview, issues, representations, truth, and checks. |
| [`apps/api`](apps/api) | Effect HTTP API with server-side sessions, request validation, and account-scoped repositories. |
| [`apps/worker`](apps/worker) | Two independent, bounded Effect loops for AI check runs and owned-site discovery. |
| [`packages/db`](packages/db) | PostgreSQL migrations and Effect repositories; the only hosted persistence layer. |
| [`packages/domain`](packages/domain), [`packages/contracts`](packages/contracts), [`packages/protocol`](packages/protocol) | Canonical domain rules, API contracts, evidence schemas, digests, fixtures, and outcome derivation. |
| [`packages/providers`](packages/providers), [`packages/representation`](packages/representation), [`packages/discovery`](packages/discovery) | Provider adapters, safe source collection, deterministic comparison, and bounded discovery. |
| [`packages/truth`](packages/truth) | Authority manifests and deterministic truth projection. |

The hosted stack uses 15 ordered PostgreSQL migrations. Evidence and workflow records are append-oriented where history matters; derived views can be recomputed from their source records. The worker contains failures within each loop so a discovery failure does not stop queued AI checks, or vice versa.

## Security and evidence boundaries

- Authentication uses server-side sessions and `HttpOnly`, `SameSite=Lax` cookies.
- Authorization is enforced in account-scoped server repositories, not inferred from client state.
- Provider credentials are loaded as redacted configuration and are never stored as evidence.
- Live provider access is disabled by default and requires an explicit model pin.
- Source collection is bounded and validated; discovery does not recursively crawl without limits.
- A recorded intervention proves that work was recorded, not that it was deployed, indexed, retrieved, or responsible for a later AI answer.

## Local CLI and desktop app

This repository also contains a local-first Rust CLI in [`src`](src) and a Tauri desktop app in [`tauri-app`](tauri-app). They have their own configuration, storage, and release lifecycle; they do not share a runtime with the hosted TypeScript stack.

Install the latest CLI release on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/commonfields/ghostping/main/scripts/install.sh | bash
```

The installer downloads the matching release archive and verifies it against the published SHA-256 manifest before installation. Windows users can use [`scripts/install.ps1`](scripts/install.ps1). To build locally instead:

```bash
cargo build --release --locked
./target/release/ghostping quickstart
```

The CLI's GEO measurements are directional local measurements, not hosted evidence packets.

## Development and verification

Run the same primary gates enforced by CI:

```bash
# Hosted TypeScript workspace
pnpm typecheck
pnpm lint
pnpm test
pnpm build

# Rust CLI and protocol reader
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --locked
cargo build --release --locked
```

Database integration tests use PostgreSQL when `DATABASE_URL` or `TEST_DATABASE_URL` is present. CI runs them against PostgreSQL 16 with live providers disabled.

When protocol schemas or fixtures change, regenerate and verify the committed artifacts:

```bash
pnpm --filter @ghostping/protocol schemas
pnpm --filter @ghostping/protocol fixtures
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before changing provider, prompt-plugin, CLI, or desktop behavior.

## Documentation

- [Evidence protocol](docs/protocol/README.md)
- [Representation graph](docs/representation-graph/README.md)
- [Truth projection](docs/truth/README.md)
- [Hosted Effect architecture](docs/engineering/hosted-effect-architecture-v1.md)
- [Product roadmap](docs/product/roadmap.md)
- [CLI exit contracts](docs/engineering/cli-exit-contracts.md)

## License

Ghostping is available under the [MIT License](LICENSE).
