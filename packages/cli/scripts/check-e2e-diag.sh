#!/usr/bin/env bash
# Exercises the spawned-server failure-diagnostic block under three scenarios
# that don't require real model loading. Confirms the block runs cleanly, hits
# the right output markers, and stays inside its curl bounds when the server is
# non-responsive.
#
# Usage: bash packages/cli/scripts/check-e2e-diag.sh

set -uo pipefail

# ── The diagnostic block under test ────────────────────────────────────
# This is the diagnostic body wrapped as a function. The "FATAL" line and the
# `return 1` are dropped; this helper returns 0 so we can run the block multiple
# times and assert externally.
run_diag_block() {
  local FILE_TMPDIR="$1"
  local BASE="$2"

  local server_pid
  server_pid=$(cat "${FILE_TMPDIR}/server_pid" 2>/dev/null || echo "")
  if [[ -n "${server_pid}" ]] && kill -0 "${server_pid}" 2>/dev/null; then
    echo "  server pid ${server_pid} is still alive" >&2
  else
    echo "  server pid ${server_pid:-<unknown>} is NOT alive" >&2
  fi

  local diag_body diag_status diag_body_file
  diag_body_file="${FILE_TMPDIR}/diag-models.body"
  diag_status=$(curl -s --connect-timeout 2 --max-time 5 \
    -o "${diag_body_file}" -w '%{http_code}' \
    "${BASE}/v1/models" 2>/dev/null)
  [[ -z "${diag_status}" ]] && diag_status="000"
  if [[ -s "${diag_body_file}" ]]; then
    diag_body=$(cat "${diag_body_file}")
  else
    diag_body="<empty or no response>"
  fi
  echo "  GET /v1/models → HTTP ${diag_status}" >&2
  echo "  body: ${diag_body}" >&2

  echo "── serve.log ────────────────────────────────────────────────" >&2
  cat "${FILE_TMPDIR}/serve.log" >&2 || echo "  (serve.log unreadable)" >&2
  echo "── end serve.log ────────────────────────────────────────────" >&2
}

# ── Test harness ──────────────────────────────────────────────────────
FAILS=0
SCENARIO=""

fail() {
  echo "  ✗ ${SCENARIO}: $*" >&2
  FAILS=$((FAILS + 1))
}

assert_grep() {
  local pattern="$1" file="$2"
  grep -q -- "${pattern}" "${file}" || fail "missing pattern: ${pattern}"
}

# ── Scenario 1: no server_pid file, port closed ───────────────────────
SCENARIO="1: no pid file + closed port"
echo "── ${SCENARIO} ─────────────────────────────────────" >&2
TMP=$(mktemp -d)
printf 'startup line 1\nstartup line 2\n' > "${TMP}/serve.log"
OUT="${TMP}/diag.out"
run_diag_block "${TMP}" "http://127.0.0.1:1" 2>"${OUT}"
[[ $? -eq 0 ]] || fail "diag block exited non-zero"
assert_grep "is NOT alive" "${OUT}"
assert_grep "HTTP 000" "${OUT}"
assert_grep "startup line 1" "${OUT}"
rm -rf "${TMP}"

# ── Scenario 2: alive pid, port closed ────────────────────────────────
SCENARIO="2: alive pid + closed port"
echo "── ${SCENARIO} ─────────────────────────────────────" >&2
TMP=$(mktemp -d)
sleep 60 &
SLEEP_PID=$!
echo "${SLEEP_PID}" > "${TMP}/server_pid"
printf 'process is up, port is not\n' > "${TMP}/serve.log"
OUT="${TMP}/diag.out"
run_diag_block "${TMP}" "http://127.0.0.1:1" 2>"${OUT}"
[[ $? -eq 0 ]] || fail "diag block exited non-zero"
assert_grep "is still alive" "${OUT}"
assert_grep "HTTP 000" "${OUT}"
kill "${SLEEP_PID}" 2>/dev/null
wait "${SLEEP_PID}" 2>/dev/null
rm -rf "${TMP}"

# ── Scenario 3: listener that never replies (curl --max-time must trip) ─
SCENARIO="3: non-responsive listener (curl --max-time bound)"
echo "── ${SCENARIO} ─────────────────────────────────────" >&2
TMP=$(mktemp -d)
printf 'listener accepts but does not reply\n' > "${TMP}/serve.log"

# Python http.server with a handler that sleeps forever: accepts the
# connection and reads the request, then blocks. Tests the read-side bound,
# not just connect.
DIAG_PORT=19999
python3 - "${DIAG_PORT}" "${TMP}/server_started" >/dev/null 2>&1 <<'PY' &
import sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(120)
    def log_message(self, *a, **k):
        pass
port = int(sys.argv[1])
marker = sys.argv[2]
srv = HTTPServer(("127.0.0.1", port), H)
open(marker, "w").close()
srv.serve_forever()
PY
SRV_PID=$!
echo "${SRV_PID}" > "${TMP}/server_pid"

# Wait briefly for the server to actually start listening.
for _ in $(seq 1 20); do
  [[ -f "${TMP}/server_started" ]] && break
  sleep 0.1
done

OUT="${TMP}/diag.out"
START=$(date +%s)
run_diag_block "${TMP}" "http://127.0.0.1:${DIAG_PORT}" 2>"${OUT}"
RC=$?
END=$(date +%s)
ELAPSED=$((END - START))

[[ "${RC}" -eq 0 ]] || fail "diag block exited non-zero"
# Curl total budget is --max-time 5 + ~2s slack for shell/echo. Anything
# >8s means the bound failed.
if [[ "${ELAPSED}" -gt 8 ]]; then
  fail "diag block took ${ELAPSED}s, expected <=8s"
else
  echo "  diag block completed in ${ELAPSED}s (within curl bound)" >&2
fi
assert_grep "is still alive" "${OUT}"
assert_grep "HTTP 000" "${OUT}"

kill "${SRV_PID}" 2>/dev/null
wait "${SRV_PID}" 2>/dev/null
rm -rf "${TMP}"

# ── Scenario 4: real `qvac serve openai` + diag block ────────────────
# Mirrors the real-model e2e config and spawned serve command. We deliberately
# fire the diag while the server is still warming so the block runs against a
# realistic partial state.
SCENARIO="4: live qvac serve + diag block"
echo "── ${SCENARIO} ─────────────────────────────────────" >&2

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QVAC_BIN="${CLI_DIR}/dist/index.js"

if [[ ! -f "${QVAC_BIN}" ]]; then
  echo "  SKIP: ${QVAC_BIN} not built (run 'npm run build' in packages/cli)" >&2
else
  TMP=$(mktemp -d)
  REAL_PORT=19931
  mkdir -p "${TMP}/project"
  cat > "${TMP}/project/qvac.config.json" <<'CONF'
{
  "serve": {
    "models": {
      "test-llm": {
        "model": "QWEN3_600M_INST_Q4",
        "preload": true,
        "config": { "ctx_size": 2048 }
      },
      "test-embed": {
        "model": "EMBEDDINGGEMMA_300M_Q4_0",
        "preload": true
      },
      "test-whisper": {
        "model": "WHISPER_EN_TINY_Q8_0",
        "preload": true
      },
      "test-whisper-translate": {
        "model": "WHISPER_EN_TINY_Q8_0",
        "type": "whispercpp-audio-translation",
        "preload": true
      }
    }
  }
}
CONF
  (cd "${TMP}/project" && node "${QVAC_BIN}" serve openai -p "${REAL_PORT}" --cors >"${TMP}/serve.log" 2>&1) &
  SP=$!
  echo "${SP}" > "${TMP}/server_pid"

  # Give the HTTP listener a few seconds to bind. Models may still be
  # warming — that's intentional; we want the diag to see a partial state.
  sleep 5

  OUT="${TMP}/diag.out"
  run_diag_block "${TMP}" "http://127.0.0.1:${REAL_PORT}" 2>"${OUT}"
  [[ $? -eq 0 ]] || fail "diag block exited non-zero"
  assert_grep "GET /v1/models" "${OUT}"
  assert_grep "── serve.log" "${OUT}"
  assert_grep "── end serve.log" "${OUT}"

  echo "  --- preview: actual diag output ---" >&2
  cat "${OUT}" >&2
  echo "  --- end preview ---" >&2

  kill "${SP}" 2>/dev/null
  wait "${SP}" 2>/dev/null
  rm -rf "${TMP}"
fi

# ── Summary ───────────────────────────────────────────────────────────
echo "" >&2
if [[ "${FAILS}" -eq 0 ]]; then
  echo "All scenarios passed." >&2
  exit 0
else
  echo "${FAILS} check(s) failed." >&2
  exit 1
fi
