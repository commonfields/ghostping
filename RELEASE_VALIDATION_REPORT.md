# Ghostping v0.3.0 Release Validation Report

**Date:** 2026-05-07  
**Version:** 0.3.0  
**Status:** Ready to tag after final review

## Summary

Ghostping v0.3.0 is ready as a release candidate. The normalized evidence-first CLI works from a clean directory, the release binary passes the mock-provider workflow, and the codebase now builds and lints without warnings.

Real cloud provider implementations were code-reviewed for request shape, timeout handling, and API-key handling. Live OpenAI, Anthropic, xAI/Grok, Perplexity, and Gemini provider tests were not completed because valid API keys were not available in this environment.

## Code Quality

| Check | Result |
| --- | --- |
| `cargo fmt --check` | Pass |
| `cargo clippy --all-targets --all-features` | Pass, no warnings |
| `cargo build` | Pass, no warnings |
| `cargo test` | Pass, 40 unit tests |
| `cargo build --release` | Pass |
| `scripts/validate-release.sh` | Pass with isolated temporary `HOME` |

The release validation script was tightened with `set -euo pipefail` and now runs `cargo build --release` directly so build failures cannot be hidden by `tail`.

## Provider Trust Review

| Provider | Implementation Review | Live Test | Notes |
| --- | --- | --- | --- |
| Mock | Passed | Passed | Validates workflow behavior only, not real AI visibility |
| Ollama | Passed | Not run | Localhost Ollama was not available during validation |
| OpenAI | Passed | Pending API key | Missing-key error and cloud warning validated |
| Anthropic | Passed | Pending API key | Provider-specific missing-key path implemented |
| xAI/Grok | Passed | Pending API key | Provider-specific missing-key path implemented |
| Perplexity | Passed | Pending API key | Provider-specific missing-key path implemented |
| Gemini | Passed | Pending API key | Provider-specific missing-key path implemented |

Cloud audit runs now print this notice before provider requests:

> Notice: this audit will send prompts to the selected cloud provider using your configured API key. Project data and audit history remain local, but provider requests are processed by the selected provider.

The notice is emitted to `stderr`, so JSON output on `stdout` is not polluted. Mock audits do not show cloud warnings. Local Ollama audits do not warn when the configured base URL is localhost.

## Missing API Key Errors

Missing cloud API keys now fail before network requests with provider-specific guidance. Example validated for OpenAI:

```text
Error: Missing OpenAI API key. Set OPENAI_API_KEY or configure providers.openai.api_key in ~/.ghostping/config.toml. For local testing without API keys, run: ghostping audit run --models mock --samples 3
```

No API key values, partial secrets, or config dumps are printed.

## Fresh Release Binary Smoke Test

Smoke test directory: `/tmp/ghostping-v030-smoke-clean`  
Isolated app home: `/tmp/ghostping-v030-home`  
Binary: `/Users/wira/Desktop/ghostping/target/release/ghostping`

| Command | Result |
| --- | --- |
| `init --name ReleaseSmoke --website https://example.com --category "developer tool" --yes --force` | Pass |
| `prompts discover` | Pass, stored 18 prompts |
| `prompts list` | Pass |
| `audit run --models mock --samples 3` | Pass, run 1 with 54 mock queries |
| `audit list` | Pass |
| `audit show 1` | Pass |
| `report --output ./reports/` | Pass, report file created |
| `generate --output ./generated/` | Pass, generated content file created |
| second `audit run --models mock --samples 3` | Pass, run 2 with 54 mock queries |
| `audit compare --before 1 --after 2` | Pass |
| `diagnose https://example.com` | Pass command execution; network sandbox reported homepage unreachable |

Generated files were verified under the clean smoke directory:

- `/tmp/ghostping-v030-smoke-clean/reports/releasesmoke_audit_1_20260507_112434.md`
- `/tmp/ghostping-v030-smoke-clean/generated/this-is-a-mock-response-for-testing.md`

Audit data and config were written to the isolated temporary app home:

- `/tmp/ghostping-v030-home/.ghostping/config.toml`
- `/tmp/ghostping-v030-home/.ghostping/evidence.db`
- `/tmp/ghostping-v030-home/.ghostping/mentions.db`

## Known Limitations

- Mock provider validation proves CLI workflow behavior, storage, reports, generation, and comparison. It does not measure real AI visibility.
- Live cloud provider tests remain pending until valid provider API keys are supplied.
- `diagnose` depends on network access. In this sandbox, `https://example.com` was unreachable, but the command handled the condition and exited successfully.
- AI visibility scores remain probabilistic and depend on configured prompts, samples, provider behavior, and future model indexing/retraining.

## Release Readiness

Cargo.toml is set to `version = "0.3.0"`. The v0.3.0 release can proceed after reviewing the working tree and committing these final release-quality changes.
