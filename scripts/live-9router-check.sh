#!/bin/bash
# One opt-in Effect provider contract request; never part of CI.
set -euo pipefail
if [ "${GHOSTPING_LIVE_PROVIDER:-}" != "1" ] && [ "${GHOSTPING_LIVE_PROVIDER:-}" != "true" ]; then
  echo "refusing: set GHOSTPING_LIVE_PROVIDER=1 to allow one provider request" >&2
  exit 2
fi
export NINE_ROUTER_ENABLED=true
export GHOSTPING_LIVE_PROVIDER=true
if [ $# -gt 0 ]; then export PROVIDER_LIVE_PROMPT="$1"; fi
exec pnpm --filter @ghostping/worker exec tsx ../../packages/providers/scripts/live-9router.ts
