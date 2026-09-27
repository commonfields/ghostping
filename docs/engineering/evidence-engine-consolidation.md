# Evidence-engine consolidation

Product invariant: Ghostping has **one authoritative definition of an audit** —
the evidence engine (`audit_engine.rs`, `audit_storage.rs`, `evidence.db`).
The legacy `tracker.rs` / `storage.rs` / `mentions.db` path is a second,
older definition. This note inventories every consumer, classifies it, and
records the smallest safe consolidation slice. No silent behavior changes.

## Consumer inventory

### `AuditStorage` / `evidence.db` (canonical)

| Consumer | What it does |
|---|---|
| `prompts discover` / `prompts list` | Writes/reads `prompts` rows |
| `audit run` (`AuditEngine::run_audit`) | **Authoritative audit execution.** Writes `audit_runs`, `audit_results`, `citations`, `audit_errors`; statuses `completed` / `completed_with_errors` / `failed`; planned/succeeded/failed accounting |
| `audit list` / `audit show` / `audit compare` | Read evidence records (show prefers live recomputation) |
| `report` (`ReportGenerator` + CLI inline report) | Reads evidence records; labels mock TEST DATA |
| `generate` (`ContentGenerator`) | Reads evidence gaps; writes `generated_assets` |
| `schedule`-generated jobs (post-consolidation) | Execute `ghostping audit run` from the project dir → evidence records |

### `Storage` / `mentions.db` + `tracker::run_track` (legacy)

| Consumer | Classification | Rationale |
|---|---|---|
| `track` | DEPRECATE_EXPLICITLY | Custom-prompt runner; output now stamped `legacy-tracker`. Migration = evidence `audit run` with stored prompts; deferred (needs prompt-file import). |
| `audit-legacy` | DEPRECATE_EXPLICITLY | One-shot scan; output stamped legacy. Migration = `audit run`. |
| `report-legacy`, `share`, `stats` | DEPRECATE_EXPLICITLY | Read legacy history only. Kept for old data; never write evidence. |
| `optimize`, `generate-legacy` (+ `--evaluate`) | BLOCKED_WITH_REASON | Blocked on evidence citation provenance + calibrated scoring (current citability math is heuristic). Must not be ported until scores are trustworthy. |
| `projects`, `publish`, `results` | ADAPT_TO_EVIDENCE | Project/checkpoint bookkeeping is engine-agnostic; future slices should source baselines from evidence summaries instead of legacy stats. |
| `watch` | ADAPT_TO_EVIDENCE | Same loop shape as `schedule`; future slice: drive `audit run` in a project dir. Left on legacy loop for now (behavior unchanged). |
| `chat` (TUI) | ADAPT_TO_EVIDENCE | Audit/optimize launchers call legacy paths. Blocked on TUI evidence UX (project selection, progress display). |
| Tauri `run_audit` | ADAPT_TO_EVIDENCE (migration sketched, not executed) | Reuses `tracker::run_track` → same legacy definition, no *new* definition created. A blind port to `AuditEngine` would change the frontend contract: `TrackSummary` carries per-model mention lists and percent rates; `AuditSummary` carries fractions and no per-model mention detail. Porting requires a frontend contract update + a verifiable Tauri build; both are subsequent slices. |
| Tauri `run_generate` / `run_optimize` | BLOCKED_WITH_REASON | Same blockers as CLI `optimize`/`generate-legacy`. |
| `doctor` | ADAPT_TO_EVIDENCE | Currently checks `mentions.db` existence; should also report `evidence.db` runs. Cosmetic; deferred. |
| `schedule`-generated jobs | PORT_NOW (done) | Previously emitted `audit <domain> [--niche]` — syntax that no longer exists, so every scheduled job failed. Now emit `audit run` from the project dir (see `scheduler.rs::ScheduledAudit`). |

## Consolidation slice implemented

1. **Scheduled jobs produce evidence.** `ScheduledAudit::argv()` is exactly
   `ghostping audit run [--models M] --yes`, executed from the project
   directory (launchd `WorkingDirectory`, cron `cd ... && ...`). Covered by
   fixture tests that execute the generated argv/shell against a stub.
2. **Legacy identity is explicit.** `TrackSummary.source` is always
   `"legacy-tracker"` (`tracker::AUDIT_SOURCE_LEGACY`); legacy terminal
   output carries a `Legacy workflow (...)` line pointing at `audit run`.
3. **Legacy history stays readable, never authoritative.** Old `mentions.db`
   rows are importable history; no new code path writes legacy rows that
   could be read as evidence-engine audits (separate databases, separate
   summary types, separate status vocabularies).

## Contract tests

- `tests/evidence_contract.rs`: end-to-end (isolated HOME, mock provider)
  proves the canonical path writes evidence records; legacy rows in the same
  HOME do not leak into evidence summaries; legacy summaries carry the
  legacy source marker.
- Scheduler fixture tests (`scheduler.rs`): generated argv executes; cron
  wrapper cds to the project dir; XML/shell escaping holds for adversarial
  input; invalid cron intervals are rejected.

## Deliberately left in place

- All `*-legacy` commands keep working with identical behavior plus an
  identity line. Removal is a later major-version decision, not this slice.
- `watch`, `chat`, Tauri, and `optimize` remain on the legacy path, marked
  ADAPT/BLOCKED above with reasons. Consolidation is therefore **partial
  by design**: one authoritative *new-evidence* path exists, and every
  remaining legacy writer is labeled — but two writers still exist. Do not
  claim full consolidation until the ADAPT items land.
