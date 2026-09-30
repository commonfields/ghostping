#!/bin/bash
# Opt-in LIVE 9Router check (real network, real credentials).
# Refuses to run unless explicitly enabled. Never runs in CI, pnpm test,
# or cargo test. Never prints NINE_ROUTER_API_KEY.
#
# Usage:
#   GHOSTPING_LIVE_PROVIDER=1 \
#   NINE_ROUTER_API_KEY=... \
#   NINE_ROUTER_MODEL=... \
#   [NINE_ROUTER_BASE_URL=...] \
#   bash scripts/live-9router-check.sh ["prompt"]
set -euo pipefail

if [ "${GHOSTPING_LIVE_PROVIDER:-}" != "1" ]; then
  echo "refusing: set GHOSTPING_LIVE_PROVIDER=1 to allow live provider traffic" >&2
  exit 2
fi
if [ -z "${NINE_ROUTER_API_KEY:-}" ]; then
  echo "refusing: NINE_ROUTER_API_KEY is required" >&2
  exit 2
fi
if [ -z "${NINE_ROUTER_MODEL:-}" ]; then
  echo "refusing: NINE_ROUTER_MODEL pin is required" >&2
  exit 2
fi

BIN="${GHOSTPING_WORKER_BIN:-./target/release/ghostping-worker}"
if [ ! -x "$BIN" ]; then
  BIN="./target/debug/ghostping-worker"
fi
if [ ! -x "$BIN" ]; then
  echo "refusing: ghostping-worker binary not built (run cargo build first)" >&2
  exit 2
fi

PROMPT="${1:-How much does Notion Plus cost per member per month?}"
RUN_ID="LIVE-$(date +%s)"

JOB="$(python3 -c 'import json,sys; print(json.dumps({"contract_version":"ghostping-worker-job-v1","run_id":sys.argv[1],"provider":"9router","model":None,"prompt":sys.argv[2]}))' "$RUN_ID" "$PROMPT")"
OUT="$(echo "$JOB" | NINE_ROUTER_API_KEY="$NINE_ROUTER_API_KEY" NINE_ROUTER_MODEL="$NINE_ROUTER_MODEL" NINE_ROUTER_BASE_URL="${NINE_ROUTER_BASE_URL:-http://localhost:20128/v1}" "$BIN")"

python3 -c '
import json,sys
r = json.loads(sys.argv[1])
print("status:", r.get("status"))
print("provider:", r.get("provider"))
print("requested_model:", r.get("requested_model"))
print("observed_model:", r.get("observed_model"))
print("failure_class:", r.get("failure_class"))
print("failure_detail_safe:", r.get("failure_detail_safe"))
print("raw_digest:", r.get("raw_digest"))
a = r.get("answer_text") or ""
print("answer_preview:", a[:200])
usage = (r.get("raw_response") or {}).get("usage")
print("usage:", json.dumps(usage))
' "$OUT"
