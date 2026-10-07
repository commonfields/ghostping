#!/bin/bash
# Regression coverage for scripts/validate-release.sh:
#  1. A failing `cargo fmt --check` must fail validation (no grep false-pass).
#  2. A failing `cargo test` must fail validation.
#  3. Validation must not write to the developer's real HOME.
#
# Uses a stub `cargo` on PATH so no real build is needed. Run from repo root:
#   bash scripts/test-validate-release.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VALIDATE="${REPO_ROOT}/scripts/validate-release.sh"

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

# make_stub_cargo <dir> <fail-at: fmt|test|build|none>
make_stub_cargo() {
    local dir="$1" fail_at="$2"
    cat > "${dir}/cargo" <<EOF
#!/bin/bash
# Stub cargo for validate-release regression tests.
FAIL_AT="${fail_at}"
SUB="\$1"
case "\${SUB}" in
    fmt)   [ "\${FAIL_AT}" = "fmt" ] && exit 1 || exit 0 ;;
    clippy) exit 0 ;;
    test)  [ "\${FAIL_AT}" = "test" ] && { echo "test result: FAILED. 0 passed"; exit 101; } || exit 0 ;;
    build) [ "\${FAIL_AT}" = "build" ] && exit 1 || exit 0 ;;
    *) exit 0 ;;
esac
EOF
    chmod +x "${dir}/cargo"
}

run_case() {
    local name="$1" fail_at="$2" expect_exit="$3"
    local work stub_home fake_home
    work="$(mktemp -d "${TMPDIR:-/tmp}/vr-test-work-XXXXXX")"
    stub_home="$(mktemp -d "${TMPDIR:-/tmp}/vr-test-stub-XXXXXX")"
    fake_home="$(mktemp -d "${TMPDIR:-/tmp}/vr-test-home-XXXXXX")"
    make_stub_cargo "${work}" "${fail_at}"
    mkdir -p "${fake_home}/.openrecord"
    echo "sentinel" > "${fake_home}/.openrecord/sentinel.txt"

    # Run validation from the repo root with stub cargo first on PATH and an
    # isolated-as-real HOME. It must never write into fake_home.
    set +e
    ( cd "${REPO_ROOT}" && PATH="${work}:${PATH}" HOME="${fake_home}" bash "${VALIDATE}" >"${work}/out.log" 2>&1 )
    local status=$?
    set -e

    if [ "${expect_exit}" = "nonzero" ]; then
        if [ "${status}" -ne 0 ]; then report "${name} exits non-zero" "nonzero" "nonzero";
        else report "${name} exits non-zero" "nonzero" "zero"; fi
    else
        report "${name} exit status" "${expect_exit}" "${status}"
    fi

    # Isolation: fake HOME must contain only the sentinel afterwards.
    local extra
    extra="$(find "${fake_home}" -mindepth 1 ! -path "${fake_home}/.openrecord" ! -path "${fake_home}/.openrecord/sentinel.txt" | head -5)"
    if [ -z "${extra}" ] && [ "$(cat "${fake_home}/.openrecord/sentinel.txt")" = "sentinel" ]; then
        report "${name} leaves real HOME untouched" "untouched" "untouched"
    else
        report "${name} leaves real HOME untouched" "untouched" "modified: ${extra}"
    fi

    rm -rf "${work}" "${stub_home}" "${fake_home}"
}

# fmt failure must propagate (guards against grep-based false passes).
run_case "fmt-failure-propagates" "fmt" "nonzero"
# test failure must propagate even though output text varies.
run_case "test-failure-propagates" "test" "nonzero"

echo ""
echo "Passed: ${PASS}, Failed: ${FAIL}"
[ "${FAIL}" -eq 0 ]
