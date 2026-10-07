#!/bin/bash
# One opt-in Effect provider contract request; never part of CI.
set -euo pipefail
if [ "${OPENRECORD_LIVE_PROVIDER:-}" != "1" ] && [ "${OPENRECORD_LIVE_PROVIDER:-}" != "true" ]; then
  echo "refusing: set OPENRECORD_LIVE_PROVIDER=1 to allow one provider request" >&2
  exit 2
fi
export NINE_ROUTER_ENABLED=true
export OPENRECORD_LIVE_PROVIDER=true
if [ $# -lt 1 ]; then
  echo "usage: $0 <explicit-model-id> [prompt]" >&2
  exit 2
fi
export PROVIDER_LIVE_MODEL="$1"
if [ $# -gt 1 ]; then export PROVIDER_LIVE_PROMPT="$2"; fi
exec pnpm --filter @openrecord/worker exec tsx ../../packages/providers/scripts/live-9router.ts
