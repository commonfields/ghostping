#!/bin/bash
# CLI exit-contract checks for the evidence workflow.
# Exercises every row of docs/engineering/cli-exit-contracts.md against the
# real binary in an isolated HOME with no network and no API secrets.
# Fails closed: any unexpected exit status fails the script.
#
# Usage: GHOSTPING_BIN=target/debug/ghostping bash scripts/check-cli-contracts.sh
# Run from the repo root.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${GHOSTPING_BIN:-${REPO_ROOT}/target/debug/ghostping}"

if [ ! -x "${BIN}" ]; then
    echo "FAIL: binary not executable at ${BIN} (build it first: cargo build --bin ghostping)"
    exit 1
fi

PASS=0
FAIL=0

expect_exit() {
    local want="$1" name="$2"
    shift 2
    set +e
    "$@" >/dev/null 2>&1
    local got=$?
    set -e
    local ok=0
    case "${want}" in
        zero) [ "${got}" -eq 0 ] && ok=1 ;;
        nonzero) [ "${got}" -ne 0 ] && ok=1 ;;
        2) [ "${got}" -eq 2 ] && ok=1 ;;
    esac
    if [ "${ok}" -eq 1 ]; then
        echo "PASS: ${name} (exit ${got})"
        PASS=$((PASS + 1))
    else
        echo "FAIL: ${name} (wanted ${want}, got ${got})"
        FAIL=$((FAIL + 1))
    fi
}

new_sandbox() {
    SANDBOX_HOME="$(mktemp -d "${TMPDIR:-/tmp}/contracts-home-XXXXXX")"
    SANDBOX_PROJ="$(mktemp -d "${TMPDIR:-/tmp}/contracts-proj-XXXXXX")"
    export HOME="${SANDBOX_HOME}"
    export CARGO_HOME="${REAL_HOME}/.cargo"
    export RUSTUP_HOME="${REAL_HOME}/.rustup"
    cd "${SANDBOX_PROJ}" || exit 1
}

drop_sandbox() {
    cd "${REPO_ROOT}" || exit 1
    rm -rf "${SANDBOX_HOME}" "${SANDBOX_PROJ}"
}

REAL_HOME="${HOME}"

# ── Happy path: full mock workflow exits 0 ──────────────────────────────────
new_sandbox
expect_exit zero "init" "${BIN}" init --name C --website "https://example.com" --yes
expect_exit zero "prompts discover" "${BIN}" prompts discover
expect_exit zero "audit run (mock)" "${BIN}" audit run --models mock --samples 1
expect_exit zero "audit list" "${BIN}" audit list
expect_exit zero "audit show 1" "${BIN}" audit show 1
expect_exit zero "report" "${BIN}" report --output ./reports/
expect_exit zero "generate" "${BIN}" generate --output ./generated/
expect_exit zero "second audit run" "${BIN}" audit run --models mock --samples 1
expect_exit zero "audit compare" "${BIN}" audit compare --before 1 --after 2
drop_sandbox

# ── Meaningful failures exit non-zero ───────────────────────────────────────
new_sandbox
"${BIN}" init --name C --website "https://example.com" --yes >/dev/null 2>&1
expect_exit nonzero "audit run with no prompts" "${BIN}" audit run --models mock --samples 1
"${BIN}" prompts discover >/dev/null 2>&1
expect_exit nonzero "audit run with no usable provider" "${BIN}" audit run --models openai --samples 1
expect_exit nonzero "audit show missing id" "${BIN}" audit show 999
expect_exit nonzero "report missing run" "${BIN}" report --run 999 --output ./reports/
expect_exit nonzero "report invalid format" "${BIN}" report --format json --output ./reports/
expect_exit nonzero "compare unknown ids" "${BIN}" audit compare --before 1 --after 999
expect_exit nonzero "compare invalid format" "${BIN}" audit compare --before 1 --after 1 --format yaml
expect_exit nonzero "generate bad from-audit" "${BIN}" generate --from-audit nope --output ./generated/
expect_exit nonzero "schedule bad interval" "${BIN}" schedule example.com --interval bogus
expect_exit nonzero "track missing prompts file" "${BIN}" track example.com --prompts ./no-such-file.txt
drop_sandbox

# ── Stale documented forms must fail loudly (never silently pass) ───────────
new_sandbox
"${BIN}" init --name C --website "https://example.com" --yes >/dev/null 2>&1
expect_exit nonzero "bare 'audit' rejected" "${BIN}" audit
expect_exit nonzero "stale 'audit <domain>' rejected" "${BIN}" audit myproject.com
expect_exit nonzero "stale 'report <domain>' rejected" "${BIN}" report myproject.com
expect_exit nonzero "stale 'prompts install' rejected" "${BIN}" prompts install rust-crate
drop_sandbox

# ── Failed provider requests exit non-zero (offline: closed-loop Ollama) ────
new_sandbox
"${BIN}" init --name C --website "https://example.com" --yes >/dev/null 2>&1
"${BIN}" prompts discover >/dev/null 2>&1
mkdir -p "${HOME}/.ghostping"
cat > "${HOME}/.ghostping/config.toml" <<'EOF'
[providers.ollama]
base_url = "http://127.0.0.1:9"
model = "llama3.2"
enabled = true
EOF
expect_exit nonzero "audit run with unreachable provider" "${BIN}" audit run --models ollama:llama3.2 --samples 1
drop_sandbox

# ── Observation Kernel: imports and reports ────────────────────────────────
new_sandbox
"${BIN}" init --name C --website "https://example.com" --yes >/dev/null 2>&1
FIXDIR="${REPO_ROOT}/tests/fixtures"
expect_exit zero "observations report with zero observations" "${BIN}" observations report
expect_exit zero "observations import-gsc queries" "${BIN}" observations import-gsc --file "${FIXDIR}/gsc_queries.csv" --report generic-search --date 2026-09-01
expect_exit zero "observations import-gsc pages" "${BIN}" observations import-gsc --file "${FIXDIR}/gsc_pages.csv" --report generic-search --date 2026-09-01
expect_exit zero "observations import-gsc AI shape" "${BIN}" observations import-gsc --file "${FIXDIR}/gsc_ai_search_synthetic.csv" --report generative-ai-search --date 2026-09-01
expect_exit zero "observations re-import is idempotent" "${BIN}" observations import-gsc --file "${FIXDIR}/gsc_queries.csv" --report generic-search --date 2026-09-01
expect_exit zero "observations import-gsc range period" "${BIN}" observations import-gsc --file "${FIXDIR}/gsc_pages.csv" --report generic-search --start-date 2026-09-01 --end-date 2026-09-07
expect_exit zero "observations import-grounded fixture" "${BIN}" observations import-grounded --file "${FIXDIR}/gemini_grounded.json" --prompt "best rust cli" --group smoke
expect_exit zero "observations report after import" "${BIN}" observations report
expect_exit nonzero "observations import-gsc missing file" "${BIN}" observations import-gsc --file ./no-such.csv --report generic-search --date 2026-09-01
expect_exit nonzero "observations import-gsc bad date" "${BIN}" observations import-gsc --file "${FIXDIR}/gsc_queries.csv" --report generic-search --date 09-01-2026
expect_exit nonzero "observations import-gsc malformed" "${BIN}" observations import-gsc --file "${REPO_ROOT}/Cargo.toml" --report generic-search --date 2026-09-01
expect_exit nonzero "observations import-gsc missing report" "${BIN}" observations import-gsc --file "${FIXDIR}/gsc_queries.csv" --date 2026-09-01
expect_exit nonzero "observations import-gsc bad report" "${BIN}" observations import-gsc --file "${FIXDIR}/gsc_queries.csv" --report ai-magic --date 2026-09-01
expect_exit nonzero "ordinary export rejected for AI import" "${BIN}" observations import-gsc --file "${FIXDIR}/gsc_queries.csv" --report generative-ai-search --date 2026-09-01
drop_sandbox

echo ""
echo "Passed: ${PASS}, Failed: ${FAIL}"
[ "${FAIL}" -eq 0 ]
