# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-06

### Release Summary
This is the first public release candidate for Ghostping v0.3.0, featuring a completely normalized CLI with clean command names and an evidence-based workflow. The CLI has been stabilized with production-ready commands for project initialization, prompt discovery, multi-sample auditing, report generation, and content gap analysis.

### Final Pre-Release Patch
- Fixed release-blocking build and clippy warnings
- Added cloud-provider audit notices before prompts are sent to external providers
- Added provider-specific missing API key errors with environment variable and config guidance
- Validated the release binary from a clean temporary directory with the mock provider workflow
- Corrected validation language: real provider implementations were reviewed, but live provider tests remain pending until API keys are provided

### Changed
- Promoted v0.2 evidence engine workflow to primary CLI commands
- `init2` → `init`: Initialize project with ghostping.toml
- `prompts2 discover/list` → `prompts discover/list`: Prompt management
- `audit2 run/list/show` → `audit run/list/show`: Evidence-based audits
- `report2` → `report`: Generate markdown reports from audit results
- `generate2` → `generate`: Generate content assets from audit gaps
- `diagnose2` → `diagnose`: URL crawlability diagnostics
- `compare` → `audit compare`: Compare two audit runs
- Renamed legacy commands to `audit-legacy`, `report-legacy`, `generate-legacy`

### Deprecated
- Temporary `*2` command names are deprecated but still work with warnings
- Legacy domain-based workflow is preserved as `*-legacy` commands

### Added
- Project-level configuration via `ghostping.toml`
- Multi-sample audits with statistical significance
- Raw evidence storage for transparency
- Prompt categorization with intent and funnel stage
- Content gap analysis from audit results
- Before/after audit comparison
- Mock provider for testing without API keys
- Comprehensive documentation in `docs/v0.2-evidence-engine-guide.md`
- Release validation script at `scripts/validate-release.sh`

### Known Limitations
- **AI visibility results are probabilistic**: Scores represent likelihood based on configured prompts and samples, not guarantees of future model behavior
- **Results depend on prompt sets**: Visibility scores are only as comprehensive as your configured prompt sets
- **Real improvement takes time**: Publishing content is step one; model retraining and indexing happens on varying schedules (days to months)
- **Citation behavior varies significantly**: Different providers (OpenAI, Anthropic, Ollama) exhibit different citation patterns
- **Mock provider is for testing only**: The mock provider validates workflows but does not measure actual visibility in real AI systems
- **Live provider validation pending API keys**: OpenAI, Anthropic, xAI/Grok, Perplexity, and Gemini implementations were reviewed, but live tests require valid API keys

### Migration Notes
If you were using the temporary `*2` commands from v0.2.x:
- `init2` → `init`
- `prompts2` → `prompts`
- `audit2` → `audit run`
- `report2` → `report`
- `generate2` → `generate`
- `diagnose2` → `diagnose`

The old `*2` commands will continue to work with a deprecation warning.

### Release Checklist
- [x] Version updated to 0.3.0 in Cargo.toml
- [x] CHANGELOG.md updated
- [x] README.md updated with new commands
- [x] Documentation in docs/v0.2-evidence-engine-guide.md
- [x] Code formatting checked (`cargo fmt --check`)
- [x] Clippy checked without warnings (`cargo clippy --all-targets --all-features`)
- [x] Unit tests pass (`cargo test`)
- [x] Binary builds successfully (`cargo build --release`)
- [x] Release smoke test passes with mock provider
- [ ] Git tag created: `git tag v0.3.0`
- [ ] Git push with tags: `git push --tags`

## [0.2.0] - 2026-05-05

### Added
- Initial evidence-first GEO engine implementation
- `init2` command for project initialization
- `prompts2` command for prompt discovery
- `audit2` command for multi-sample audits
- `report2` command for markdown report generation
- `generate2` command for content generation from gaps
- `compare` command for audit comparison
- `diagnose2` command for URL diagnostics
- Extended SQLite schema with audit_runs, prompts, citations tables
- Mock provider for testing

## [0.1.0] - 2026-05-01

### Added
- Initial release of Ghostping
- Domain-based visibility tracking (`track`, `audit`)
- Quick audit with 12 smart prompts
- Autonomous GEO optimization agent (`optimize`)
- Content generation (`generate`)
- Project management (`projects`)
- Ollama support for fully local execution
- Plugin system for custom templates
- Desktop app (Tauri-based)

[Unreleased]: https://github.com/commonfields/ghostping/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/commonfields/ghostping/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/commonfields/ghostping/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/commonfields/ghostping/releases/tag/v0.1.0
