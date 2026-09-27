# CLI exit contracts (evidence workflow)

Commands intended for scripts and CI follow these contracts. Unless noted,
success is exit `0`; any `Err` propagates through `main` as a non-zero exit
with the error on stderr. `scripts/check-cli-contracts.sh` exercises every
row below against the real binary in an isolated HOME.

| Command / state | Exit | Notes |
|---|---|---|
| `audit run` fully successful (`completed`) | 0 | Summary on stdout; `--json` prints only the summary JSON |
| `audit run` all queries failed (`failed`) | non-zero | Engine returns `Err`; run marked `failed`; nothing to report |
| `audit run` partial (`completed_with_errors`) | **2** | Results print normally, then exit 2 so CI detects the shortfall |
| `audit run` with no stored prompts | non-zero | Requires `prompts discover` first |
| `audit run` with no usable provider | non-zero | Missing keys fail before any network request |
| `audit show <missing-id>` | non-zero | `bail!("Audit run {id} not found.")` |
| `audit compare` with unknown ids | non-zero | Pre-existing `bail!` |
| `report --run <missing-id>` | non-zero | Pre-existing `anyhow!` |
| `report --format <not-markdown>` | non-zero | Only `markdown` is implemented; unknown values are rejected, never silently ignored |
| `audit compare --format <not-markdown|json>` | non-zero | Same rule |
| `generate --from-audit <bad-id>` | non-zero | Unparseable ids error; valid-but-empty runs bail |
| `track --prompts <missing-file>` | non-zero | Pre-existing read error |
| `schedule --interval <garbage>` | non-zero (`exit(1)`) | Unknown intervals rejected at parse |
| `schedule` with cron-invalid custom hours (not 1–24) | non-zero | `cron_line` validates; launchd path unaffected |
| Stale forms (`audit` bare, `audit <domain>`, `report <domain>`, `prompts install <x>`) | non-zero | clap rejects unknown/missing subcommands; the contracts script asserts this so automation cannot silently depend on removed syntax |
| Ordinary empty result sets (`audit list` with no runs, `share` with no data) | 0 with a guidance message | Informational emptiness is NOT an error; only missing *required* inputs fail |

Design rule: exit 0 means "the command did what was asked". A run that
could not collect all planned evidence did not — hence exit 2, distinct
from exit 1 (usage/config errors) so callers can distinguish them.
