#!/bin/bash
# Ghostping Release Validation Script
# Run this before releasing a new version

set -euo pipefail

echo "=========================================="
echo "Ghostping Release Validation"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "Cargo.toml" ]; then
    echo -e "${RED}Error: Must run from project root${NC}"
    exit 1
fi

echo "1. Checking code formatting..."
if cargo fmt --check 2>&1 | grep -q "diff"; then
    echo -e "${RED}✗ Code formatting issues found. Run: cargo fmt${NC}"
    exit 1
else
    echo -e "${GREEN}✓ Code is properly formatted${NC}"
fi

echo ""
echo "2. Running tests..."
if cargo test 2>&1 | grep -q "FAILED"; then
    echo -e "${RED}✗ Tests failed${NC}"
    exit 1
else
    echo -e "${GREEN}✓ All tests passed${NC}"
fi

echo ""
echo "3. Building release binary..."
cargo build --release
echo -e "${GREEN}✓ Release binary built${NC}"
echo "   Binary size: $(ls -lh target/release/ghostping | awk '{print $5}')"

echo ""
echo "4. Running smoke tests..."
SMOKE_DIR="/tmp/ghostping-smoke-test-$$"
mkdir -p "$SMOKE_DIR"
cd "$SMOKE_DIR"

# Get the binary path
BINARY="$(cd - >/dev/null && pwd)/target/release/ghostping"

# Test init
echo "   Testing: ghostping init..."
$BINARY init --name "SmokeTest" --website "https://example.com" --category "test" --yes > /dev/null 2>&1
echo -e "   ${GREEN}✓ init${NC}"

# Test prompts discover
echo "   Testing: ghostping prompts discover..."
$BINARY prompts discover > /dev/null 2>&1
echo -e "   ${GREEN}✓ prompts discover${NC}"

# Test prompts list
echo "   Testing: ghostping prompts list..."
$BINARY prompts list > /dev/null 2>&1
echo -e "   ${GREEN}✓ prompts list${NC}"

# Test audit run
echo "   Testing: ghostping audit run..."
$BINARY audit run --models mock --samples 1 > /dev/null 2>&1
echo -e "   ${GREEN}✓ audit run${NC}"

# Test audit list
echo "   Testing: ghostping audit list..."
$BINARY audit list > /dev/null 2>&1
echo -e "   ${GREEN}✓ audit list${NC}"

# Test audit show
echo "   Testing: ghostping audit show..."
$BINARY audit show 1 > /dev/null 2>&1
echo -e "   ${GREEN}✓ audit show${NC}"

# Test report
echo "   Testing: ghostping report..."
$BINARY report --output ./reports/ > /dev/null 2>&1
echo -e "   ${GREEN}✓ report${NC}"

# Test generate
echo "   Testing: ghostping generate..."
$BINARY generate --output ./generated/ > /dev/null 2>&1
echo -e "   ${GREEN}✓ generate${NC}"

# Second audit for compare
echo "   Testing: second audit run for compare..."
$BINARY audit run --models mock --samples 1 > /dev/null 2>&1
echo -e "   ${GREEN}✓ second audit run${NC}"

# Test compare
echo "   Testing: ghostping audit compare..."
$BINARY audit compare --before 1 --after 2 > /dev/null 2>&1
echo -e "   ${GREEN}✓ audit compare${NC}"

# Test diagnose
echo "   Testing: ghostping diagnose..."
$BINARY diagnose https://example.com > /dev/null 2>&1
echo -e "   ${GREEN}✓ diagnose${NC}"

# Cleanup
cd - > /dev/null
rm -rf "$SMOKE_DIR"

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
