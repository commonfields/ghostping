#!/bin/bash
# Ghostping Release Validation Script
# Run this before releasing a new version.
#
# Design notes:
# - Every required check preserves its command exit status. A failing check
#   fails the whole script (fail-closed). No grep-based pass/fail detection.
# - HOME is isolated so smoke tests never touch the developer's real
#   ~/.ghostping configuration, history, or cache. CARGO_HOME/RUSTUP_HOME are
#   preserved so the Rust toolchain keeps working under the isolated HOME.
# - All smoke-test artifacts live under one temp project dir, removed on exit.
# - Each step logs to a file; on failure the tail of the log is shown.

set -euo pipefail

# ── Isolation ────────────────────────────────────────────────────────────────
REAL_HOME="${HOME:?HOME must be set}"
ISOLATED_HOME="$(mktemp -d "${TMPDIR:-/tmp}/ghostping-release-home-XXXXXX")"
SMOKE_PROJECT="$(mktemp -d "${TMPDIR:-/tmp}/ghostping-smoke-XXXXXX")"
LOGS_DIR="${SMOKE_PROJECT}/logs"
mkdir -p "${LOGS_DIR}"

export HOME="${ISOLATED_HOME}"
export CARGO_HOME="${CARGO_HOME:-${REAL_HOME}/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-${REAL_HOME}/.rustup}"

cleanup() {
    rm -rf "${ISOLATED_HOME}" "${SMOKE_PROJECT}"
}
trap cleanup EXIT

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Run a step, capturing output to a log file. Fails the script on non-zero exit.
# Usage: run_step "<label>" <log-name> <command...>
run_step() {
    local label="$1"; shift
    local log_name="$1"; shift
    local log_file="${LOGS_DIR}/${log_name}.log"
    printf '   -- %s ... ' "${label}"
    if "$@" >"${log_file}" 2>&1; then
        printf '%b\n' "${GREEN}ok${NC}"
    else
        local status=$?
        printf '%b\n' "${RED}FAILED (exit ${status})${NC}"
        printf '%b\n' "${RED}--- tail of ${log_file} ---${NC}"
        tail -n 30 "${log_file}" || true
        printf '%b\n' "${RED}--- end log ---${NC}"
        exit "${status}"
    fi
}

echo "=========================================="
echo "Ghostping Release Validation"
echo "=========================================="
echo ""
echo "Isolated HOME: ${ISOLATED_HOME}"
echo "Smoke project: ${SMOKE_PROJECT}"
echo ""

# Check if we're in the right directory
if [ ! -f "Cargo.toml" ]; then
    echo -e "${RED}Error: Must run from project root${NC}"
    exit 1
fi
REPO_ROOT="$(pwd)"

echo "1. Checking code formatting..."
run_step "cargo fmt --all -- --check" "fmt" cargo fmt --all -- --check
echo -e "${GREEN}✓ Code is properly formatted${NC}"

echo ""
echo "2. Running Clippy..."
run_step "cargo clippy" "clippy" cargo clippy --all-targets --all-features -- -D warnings
echo -e "${GREEN}✓ Clippy is clean${NC}"

echo ""
echo "3. Running tests..."
run_step "cargo test --locked" "test" cargo test --locked
echo -e "${GREEN}✓ All tests passed${NC}"

echo ""
echo "4. Building release binary..."
run_step "cargo build --release --locked" "build" cargo build --release --locked
echo -e "${GREEN}✓ Release binary built${NC}"
echo "   Binary size: $(ls -lh target/release/ghostping | awk '{print $5}')"

echo ""
echo "5. Running smoke tests (isolated HOME, no network API keys)..."
cd "${SMOKE_PROJECT}"

# The script runs from the repo root, captured above before cd.
BINARY="${REPO_ROOT}/target/release/ghostping"
if [ ! -x "${BINARY}" ]; then
    echo -e "${RED}Error: release binary not found at ${BINARY}${NC}"
    exit 1
fi

run_step "ghostping init" "smoke-init" "${BINARY}" init --name "SmokeTest" --website "https://example.com" --category "test" --yes
run_step "ghostping prompts discover" "smoke-discover" "${BINARY}" prompts discover
run_step "ghostping prompts list" "smoke-list" "${BINARY}" prompts list
run_step "ghostping audit run (mock)" "smoke-audit1" "${BINARY}" audit run --models mock --samples 1
run_step "ghostping audit list" "smoke-audit-list" "${BINARY}" audit list
run_step "ghostping audit show 1" "smoke-audit-show" "${BINARY}" audit show 1
run_step "ghostping report" "smoke-report" "${BINARY}" report --output ./reports/
run_step "ghostping generate" "smoke-generate" "${BINARY}" generate --output ./generated/
run_step "ghostping second audit run (mock)" "smoke-audit2" "${BINARY}" audit run --models mock --samples 1
run_step "ghostping audit compare" "smoke-compare" "${BINARY}" audit compare --before 1 --after 2
run_step "ghostping diagnose" "smoke-diagnose" "${BINARY}" diagnose https://example.com

echo -e "   ${GREEN}✓ all smoke tests passed${NC}"

cd "${REPO_ROOT}"

echo ""
echo "=========================================="
echo -e "${GREEN}✓ All validations passed!${NC}"
echo "=========================================="
echo ""
echo "Release checklist:"
echo "  ☐ Version updated in Cargo.toml"
echo "  ☐ CHANGELOG.md updated"
echo "  ☐ Git tag created: git tag vX.Y.Z"
echo "  ☐ Git push with tags: git push --tags"
echo ""
