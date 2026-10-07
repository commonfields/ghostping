#!/usr/bin/env bash
# OpenRecord installer for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/commonfields/openrecord/main/scripts/install.sh | bash
set -euo pipefail

REPO="commonfields/openrecord"
BIN="openrecord"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

# ── Detect platform ──────────────────────────────────────────────────────────

detect_archive() {
    local os="$1" arch="$2"
    case "$os" in
        Linux)
            case "$arch" in
                x86_64) echo "openrecord-linux-x86_64.tar.gz" ;;
                *) echo "Error: unsupported architecture $arch on Linux." >&2; return 1 ;;
            esac
            ;;
        Darwin)
            case "$arch" in
                x86_64) echo "openrecord-macos-x86_64.tar.gz" ;;
                arm64) echo "openrecord-macos-aarch64.tar.gz" ;;
                *) echo "Error: unsupported architecture $arch on macOS." >&2; return 1 ;;
            esac
            ;;
        *)
            echo "Error: unsupported OS $os. Use install.ps1 on Windows." >&2
            return 1
            ;;
    esac
}

# ── Checksum verification ────────────────────────────────────────────────────
# Verifies <archive_path> against the hash recorded for <archive_name> in
# <checksums_file> (the release's checksums.txt manifest). Fails closed:
# missing entry, missing tool, or mismatch all abort the install with a
# non-zero status. No silent fallback to unchecked execution.

sha256_of_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        echo "Error: no SHA-256 tool found (need sha256sum or shasum)." >&2
        return 1
    fi
}

expected_sha256() {
    local checksums_file="$1" archive_name="$2"
    local expected
    expected="$(awk -v name="$archive_name" '$2 == name {print $1}' "$checksums_file" | head -n 1)"
    if [ -z "$expected" ]; then
        echo "Error: no checksum entry for $archive_name in $checksums_file." >&2
        return 1
    fi
    printf '%s' "$expected"
}

verify_archive() {
    local archive_path="$1" checksums_file="$2" archive_name="$3"
    local expected actual
    expected="$(expected_sha256 "$checksums_file" "$archive_name")" || return 1
    actual="$(sha256_of_file "$archive_path")" || return 1
    if [ "$expected" != "$actual" ]; then
        echo "Error: checksum mismatch for $archive_name." >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        return 1
    fi
}

fetch_latest_tag() {
    local tag
    tag="$(curl -fsSL -H "User-Agent: openrecord-installer" \
        "https://api.github.com/repos/$REPO/releases/latest" \
        | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
    if [ -z "$tag" ]; then
        echo "Error: could not determine latest release. Check your internet connection." >&2
        return 1
    fi
    printf '%s' "$tag"
}

main() {
    local os arch archive latest tmp url
    os="$(uname -s)"
    arch="$(uname -m)"
    archive="$(detect_archive "$os" "$arch")" || exit 1

    echo "Fetching latest release..."
    latest="$(fetch_latest_tag)" || exit 1

    echo "Installing openrecord $latest ($arch)..."

    tmp="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '$tmp'" EXIT

    url="https://github.com/$REPO/releases/download/$latest/$archive"
    echo "Downloading $url..."
    curl -fsSL -H "User-Agent: openrecord-installer" "$url" -o "$tmp/$archive"

    echo "Downloading checksum manifest..."
    curl -fsSL -H "User-Agent: openrecord-installer" \
        "https://github.com/$REPO/releases/download/$latest/checksums.txt" \
        -o "$tmp/checksums.txt"

    echo "Verifying checksum..."
    verify_archive "$tmp/$archive" "$tmp/checksums.txt" "$archive" || exit 1
    echo "Checksum OK."

    echo "Extracting..."
    tar xzf "$tmp/$archive" -C "$tmp"

    mkdir -p "$INSTALL_DIR"
    mv "$tmp/$BIN" "$INSTALL_DIR/$BIN"
    chmod +x "$INSTALL_DIR/$BIN"

    echo ""
    echo "  ✓ openrecord $latest installed to $INSTALL_DIR/$BIN"

    if ! command -v "$BIN" &>/dev/null; then
        echo ""
        echo "  Note: $INSTALL_DIR is not in your PATH."
        echo "  Add it by running:"
        echo '    echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.bashrc'
        echo "  (or ~/.zshrc for Zsh)"
    fi

    echo ""
    echo "  Quick start:"
    echo "    openrecord quickstart"
    echo "    openrecord init --name \"MyProject\" --website \"https://example.com\" --yes"
    echo "    openrecord prompts discover && openrecord audit run --models mock --samples 3"
    echo ""
}

# Allow test scripts to source the functions without running the install.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
    main "$@"
fi
