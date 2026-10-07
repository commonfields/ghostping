#!/bin/bash
# Regression tests for scripts/install.sh checksum verification.
# Offline: exercises verify_archive / expected_sha256 / detect_archive with
# local fixture files. Run from repo root:
#   bash scripts/test-install.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Source functions without running main (install.sh guards on BASH_SOURCE).
# shellcheck disable=SC1091
source "${REPO_ROOT}/scripts/install.sh"

PASS=0
FAIL=0

report() {
    local name="$1" expected="$2" actual="$3"
    if [ "${expected}" = "${actual}" ]; then
        echo "PASS: ${name}"
        PASS=$((PASS + 1))
    else
        echo "FAIL: ${name} (expected ${expected}, got ${actual})"
        FAIL=$((FAIL + 1))
    fi
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/install-test-XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

echo "hello-openrecord" > "${WORK}/payload.bin"
ARCHIVE="openrecord-linux-x86_64.tar.gz"
cp "${WORK}/payload.bin" "${WORK}/${ARCHIVE}"
GOOD_HASH="$(sha256_of_file "${WORK}/${ARCHIVE}")"
printf '%s  %s\n' "${GOOD_HASH}" "${ARCHIVE}" > "${WORK}/checksums.txt"

# 1. Matching checksum verifies.
if verify_archive "${WORK}/${ARCHIVE}" "${WORK}/checksums.txt" "${ARCHIVE}" 2>/dev/null; then
    report "matching checksum verifies" "0" "0"
else
    report "matching checksum verifies" "0" "nonzero"
fi

# 2. Tampered archive fails closed.
echo "tampered" >> "${WORK}/${ARCHIVE}"
if verify_archive "${WORK}/${ARCHIVE}" "${WORK}/checksums.txt" "${ARCHIVE}" 2>/dev/null; then
    report "tampered archive fails closed" "nonzero" "0"
else
    report "tampered archive fails closed" "nonzero" "nonzero"
fi

# 3. Missing checksum entry fails closed (no silent unchecked install).
printf 'deadbeef  other-file.tar.gz\n' > "${WORK}/empty-checksums.txt"
if verify_archive "${WORK}/payload.bin" "${WORK}/empty-checksums.txt" "${ARCHIVE}" 2>/dev/null; then
    report "missing checksum entry fails closed" "nonzero" "0"
else
    report "missing checksum entry fails closed" "nonzero" "nonzero"
fi

# 4. Missing checksums manifest fails closed.
if verify_archive "${WORK}/payload.bin" "${WORK}/no-such-file.txt" "${ARCHIVE}" 2>/dev/null; then
    report "missing manifest fails closed" "nonzero" "0"
else
    report "missing manifest fails closed" "nonzero" "nonzero"
fi

# 5. Platform detection still maps supported targets.
report "darwin arm64 archive" "openrecord-macos-aarch64.tar.gz" "$(detect_archive Darwin arm64)"
report "linux x86_64 archive" "openrecord-linux-x86_64.tar.gz" "$(detect_archive Linux x86_64)"

# 6. Unsupported targets fail instead of producing a bad URL.
if detect_archive Linux arm64 >/dev/null 2>&1; then
    report "unsupported arch fails" "nonzero" "0"
else
    report "unsupported arch fails" "nonzero" "nonzero"
fi

echo ""
echo "Passed: ${PASS}, Failed: ${FAIL}"
[ "${FAIL}" -eq 0 ]
