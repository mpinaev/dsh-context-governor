#!/usr/bin/env bash
#
# End-to-end compatibility probe.
#
# Boots a throwaway DSH instance on a spare port with this plugin mounted, waits
# for the plugin ready line, asks its status route and checks the response shape.
# No session is created there, so the shared session store is not touched.
#
# Usage: ./scripts/compat-check.sh [port]
# Exit code 0 means the running harness served the plugin.
set -euo pipefail

PORT="$1"
if [ -z "$PORT" ]; then PORT=3099; fi
LOG="$(mktemp /tmp/dsh-compat-XXXXXX.log)"
GUARD="x-dsh-context-governor: 1"

cleanup() {
  if [ -n "${PID:-}" ]; then
    kill "$PID" 2>/dev/null || true
    sleep 2
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$LOG"
}
trap cleanup EXIT

echo "booting dsh web on port $PORT (log: $LOG)"
dsh web --port "$PORT" --no-open >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 60); do
  if grep -q "context-governor.*ready" "$LOG" 2>/dev/null; then break; fi
  sleep 1
done

if ! grep -q "context-governor.*ready" "$LOG"; then
  echo "FAIL: the plugin never reported ready"
  grep -i "context-governor" "$LOG" || true
  exit 1
fi

if grep -qiE "incompatible|is incompatible with dsh" "$LOG"; then
  echo "FAIL: the version gate rejected the plugin"
  grep -i "incompatible" "$LOG" || true
  exit 1
fi

BODY="$(curl -s --max-time 10 -H "$GUARD" "http://127.0.0.1:$PORT/context-governor/api/status?ver=compat&tz=0&lang=en")"
echo "status: $BODY"

for KEY in compactThreshold windowTokens route provider balance; do
  case "$BODY" in
    *"$KEY"*) ;;
    *) echo "FAIL: status payload has no $KEY"; exit 1 ;;
  esac
done

echo "OK: plugin mounted and answered on port $PORT"
