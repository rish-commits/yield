#!/bin/bash
# Stands in for the claude CLI so the gating, caching and fallback paths can be
# tested deterministically, for free, without a model call.
printf 'CALL %s\n' "$(printf '%s ' "$@" | tr '\n' ' ')" >> "${YIELD_STUB_CALLS:-/dev/null}"
case "$(cat "${YIELD_STUB_MODE:-/dev/null}" 2>/dev/null || echo ok)" in
  none) echo '{"type":"result","is_error":false,"result":"NONE"}' ;;
  fail) echo "something broke" >&2; exit 1 ;;
  auth) echo '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}' ;;
  hang) sleep 60 ;;                       # never returns: exercises the hard kill
  *)    echo '{"type":"result","is_error":false,"result":"Could add how migrations are handled, or anything else that'"'"'s useful."}' ;;
esac
