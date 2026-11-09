#!/bin/sh
# The Factory UI's API, as Ryan, through the running UI (F20/F21): the token is the last line of ui.log.
#   sh ui.sh view                  → view.json
#   sh ui.sh block <issue> on|off  → set or clear Blocked (the only sanctioned way to unblock)
#   sh ui.sh link                  → the UI's link (contains the token: never paste it anywhere public)
set -eu
S="$HOME/Library/Application Support/penmoss-factory"
T=$(tail -1 "$S/ui.log" | grep -oE '[A-Za-z0-9_-]{20,}' | tail -1)
U=http://127.0.0.1:7878
case "${1:-}" in
  view) curl -sf -b "penmoss-factory-ui=$T" "$U/view.json" ;;
  block)
    on=$([ "${3:-}" = on ] && echo true || echo false)
    curl -sf -b "penmoss-factory-ui=$T" -H "Origin: $U" -H 'Content-Type: application/json' \
      -d "{\"kind\":\"block\",\"issue\":$2,\"on\":$on}" "$U/action"; echo ;;
  link) tail -1 "$S/ui.log" | grep -oE 'http://[^ ]+' ;;
  *) echo "usage: ui.sh view | block <issue> on|off | link" >&2; exit 2 ;;
esac
