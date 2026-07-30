#!/usr/bin/env bash
#
# Tests the partial-scheduling rollback in action.yml.
#
#   bash .github/actions/run-mobile-integration-tests/schedule-test-run/rollback.test.sh
#
# The trap block is EXTRACTED FROM action.yml rather than copied, so this test can
# never drift from the shipped logic. `aws` is faked to record stop-run calls.
#
# Covered: success (must not roll back), command failure, and cancellation via
# SIGTERM. SIGINT is handled by the same trap and disarm logic, but cannot be
# exercised here: POSIX makes a backgrounded child ignore SIGINT, so the harness
# could never deliver it. In the runner the step's bash is a foreground process,
# where SIGINT is deliverable; the EXIT trap is the catch-all regardless.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="$HERE/action.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BLOCK=$(sed -n '/CREATED_RUN_ARNS=""/,/^        trap rollback_created_runs ERR INT TERM EXIT$/p' "$ACTION" | sed 's/^        //')
if [ -z "$BLOCK" ]; then
  echo "FAIL: could not extract the rollback block from action.yml (did its shape change?)"
  exit 1
fi

# The scenario script: mimics scheduling two runs, with a configurable interruption
# between them, then publishing outputs and disarming — as action.yml does.
cat > "$TMP/scenario.sh" <<SCENARIO
aws() { if [ "\$2" = "stop-run" ]; then echo "\$4" >> "\$STOPPED_LOG"; fi; return 0; }
$BLOCK
record_created_run() { CREATED_RUN_ARNS="\$CREATED_RUN_ARNS \$1"; }

record_created_run "arn:run-1"
case "\$MODE" in
  cancel) sleep 30 ;;
  fail)   false ;;
esac
record_created_run "arn:run-2"
trap - ERR INT TERM EXIT
echo "PUBLISHED"
SCENARIO

fails=0
check() { # name expected_stopped expected_published mode [signal]
  local name="$1" want_stopped="$2" want_pub="$3" mode="$4" sig="${5:-}"
  local log="$TMP/stopped.$$" out="$TMP/out.$$"
  : > "$log"
  MODE="$mode" STOPPED_LOG="$log" bash -e -o pipefail "$TMP/scenario.sh" > "$out" 2>&1 &
  local pid=$!
  if [ -n "$sig" ]; then sleep 1; kill -"$sig" "$pid" 2>/dev/null; fi
  wait "$pid" 2>/dev/null
  local stopped published
  stopped=$(tr -d '[:space:]' < "$log")
  published=$(grep -c PUBLISHED "$out" || true)
  if [ "$stopped" = "$want_stopped" ] && [ "$published" = "$want_pub" ]; then
    echo "  ok  $name"
  else
    echo "  FAIL $name (stopped='$stopped' want='$want_stopped'; published=$published want=$want_pub)"
    fails=$((fails + 1))
  fi
}

echo "rollback.test.sh"
check "success does not roll back"            ""            1 ok
check "command failure rolls back"            "arn:run-1"   0 fail
check "cancellation (SIGTERM) rolls back"     "arn:run-1"   0 cancel TERM

if [ "$fails" -ne 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
