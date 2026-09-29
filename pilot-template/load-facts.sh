#!/bin/bash
# Load pilot facts from facts.template.csv (or a filled copy) via `facts add`.
# Usage: ./load-facts.sh [facts.csv]
# Runs in the Ghostping project directory. Row failures abort (set -e).
# NOTE: plain comma splitting — values must not contain literal commas.
# For real data with commas, enter those facts with `facts add` directly.
set -euo pipefail
CSV="${1:-facts.template.csv}"
tail -n +2 "$CSV" | while IFS=, read -r subject predicate value value_type source valid_from valid_until notes; do
    args=(add --subject "$subject" --predicate "$predicate" --value "$value"
        --type "$value_type" --source "$source")
    [ -n "$valid_from" ] && args+=(--valid-from "$valid_from")
    [ -n "$valid_until" ] && args+=(--valid-until "$valid_until")
    [ -n "$notes" ] && args+=(--notes "$notes")
    ghostping facts "${args[@]}"
done
