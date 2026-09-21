#!/usr/bin/env bash
# Ghostping installer for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/commonfields/ghostping/main/scripts/install.sh | bash
set -euo pipefail

REPO="commonfields/ghostping"
BIN="ghostping"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

# ── Detect platform ──────────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64) ARCHIVE="ghostping-linux-x86_64.tar.gz" ;;
      *)
        echo "Error: unsupported architecture $ARCH on Linux." >&2
        echo "Please build from source: cargo install --git https://github.com/$REPO" >&2
        exit 1
        ;;
    esac
    ;;
  Darwin)
    case "$ARCH" in
      x86_64) ARCHIVE="ghostping-macos-x86_64.tar.gz" ;;
      arm64)  ARCHIVE="ghostping-macos-aarch64.tar.gz" ;;
      *)
        echo "Error: unsupported architecture $ARCH on macOS." >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Error: unsupported OS $OS. Use install.ps1 on Windows." >&2
    exit 1
    ;;
esac

# ── Get latest release ───────────────────────────────────────────────────────

echo "Fetching latest release..."
LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

if [ -z "$LATEST" ]; then
  echo "Error: could not determine latest release. Check your internet connection." >&2
  exit 1
fi

echo "Installing ghostping $LATEST ($ARCH)..."

# ── Download and install ─────────────────────────────────────────────────────

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/$REPO/releases/download/$LATEST/$ARCHIVE"
echo "Downloading $URL..."
curl -fsSL "$URL" -o "$TMP/$ARCHIVE"

echo "Extracting..."
tar xzf "$TMP/$ARCHIVE" -C "$TMP"

mkdir -p "$INSTALL_DIR"
mv "$TMP/$BIN" "$INSTALL_DIR/$BIN"
chmod +x "$INSTALL_DIR/$BIN"

# ── Verify installation ──────────────────────────────────────────────────────

echo ""
echo "  ✓ ghostping $LATEST installed to $INSTALL_DIR/$BIN"

if ! command -v "$BIN" &>/dev/null; then
  echo ""
  echo "  Note: $INSTALL_DIR is not in your PATH."
  echo "  Add it by running:"
  echo '    echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.bashrc'
  echo "  (or ~/.zshrc for Zsh)"
fi

echo ""
echo "  Quick start:"
echo "    ghostping config"
echo "    ghostping audit myproject.com --niche 'your niche'"
echo "    ghostping optimize myproject.com --niche 'your niche' --auto-apply"
echo ""
