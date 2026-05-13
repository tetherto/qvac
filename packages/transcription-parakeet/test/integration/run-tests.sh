#!/bin/bash
# Shell wrapper for bare integration tests.
# Bare.exit() hangs when native addon handles keep the event loop alive,
# so run-with-exit.js writes an .exit-code file when tests finish.
# This script monitors for that file and terminates bare cleanly.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXIT_CODE_FILE="$SCRIPT_DIR/.exit-code"
TIMEOUT=${INTEGRATION_TEST_TIMEOUT:-600}

rm -f "$EXIT_CODE_FILE"

bare "$SCRIPT_DIR/run-with-exit.js" &
BARE_PID=$!

ELAPSED=0
while [ ! -f "$EXIT_CODE_FILE" ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if ! kill -0 "$BARE_PID" 2>/dev/null; then
    wait "$BARE_PID" 2>/dev/null
    BARE_EC=$?
    if [ -f "$EXIT_CODE_FILE" ]; then
      break
    fi
    exit "$BARE_EC"
  fi
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "# integration-test timeout (${TIMEOUT}s) — forcing exit"
    kill "$BARE_PID" 2>/dev/null
    sleep 1
    kill -9 "$BARE_PID" 2>/dev/null
    exit 1
  fi
done

EC=$(cat "$EXIT_CODE_FILE")
rm -f "$EXIT_CODE_FILE"
kill "$BARE_PID" 2>/dev/null
sleep 1
kill -9 "$BARE_PID" 2>/dev/null
wait "$BARE_PID" 2>/dev/null
exit "$EC"
