#!/usr/bin/env bats

# Local-only end-to-end tests. NOT run in CI — invoke with `npm run test:e2e:local`.
#
# This suite is the home for e2e tests that depend on resources CI does not
# reliably provide: a GPU, a large model download, or extra system tooling.
# Keeping them out of `test:e2e` (the CI suite) avoids flaky and slow/fat CI
# jobs. Add any such resource-heavy e2e coverage here rather than in e2e.bats.
#
# Current contents: /v1/audio/speech encoding + the TTS discovery endpoints,
# which require:
#   - ffmpeg + ffprobe on PATH (the mp3/opus/aac/flac encoding path shells out
#     to the system ffmpeg binary; ffprobe validates the encoded output).
#   - Network access: first run downloads TTS_EN_SUPERTONIC_Q4_0 (~132 MB) over
#     P2P from the QVAC registry.
#   - npm run build, jq, @qvac/sdk installed as devDependency.
#
# ⚠ BASH 3.2 COMPATIBILITY (macOS default): every `[[ ... ]]` assertion must be
# the LAST command of the @test, or chained with `\` / `|| return 1` so its exit
# code reaches the test's last line. See test/e2e.bats for the rationale.

QVAC="node ${BATS_TEST_DIRNAME}/../dist/index.js"
E2E_PORT=19940
BASE="http://127.0.0.1:${E2E_PORT}"

TTS_ALIAS="test-tts"

# ── Server lifecycle (once per file) ──────────────────────────────────

setup_file() {
  export FILE_TMPDIR="${BATS_FILE_TMPDIR}"
  mkdir -p "${FILE_TMPDIR}/project"

  cat > "${FILE_TMPDIR}/project/qvac.config.json" <<'CONF'
{
  "serve": {
    "models": {
      "test-tts": {
        "model": "TTS_EN_SUPERTONIC_Q4_0",
        "type": "tts",
        "preload": true,
        "config": {
          "ttsEngine": "supertonic",
          "language": "en",
          "voice": "F1",
          "ttsNumInferenceSteps": 5
        }
      }
    },
    "openai": {
      "audio": {
        "speech": {
          "voices": { "alloy": "test-tts" }
        }
      }
    }
  }
}
CONF

  cd "${FILE_TMPDIR}/project"
  ${QVAC} serve openai -p "${E2E_PORT}" --cors >"${FILE_TMPDIR}/serve.log" 2>&1 &
  echo "$!" > "${FILE_TMPDIR}/server_pid"

  # Supertonic Q4_0 is ~132 MB; allow a generous download+load window.
  local max_wait="${E2E_MAX_WAIT:-600}"
  local elapsed=0
  while [[ "${elapsed}" -lt "${max_wait}" ]]; do
    local count
    count=$(curl -sf "${BASE}/v1/audio/models" 2>/dev/null | jq '.data | length' 2>/dev/null || echo 0)
    [[ "${count}" -ge 1 ]] && break
    sleep 2
    elapsed=$((elapsed + 2))
  done

  if [[ "${elapsed}" -ge "${max_wait}" ]]; then
    echo "FATAL: TTS model did not load within ${max_wait}s" >&2
    set +e
    echo "── serve.log ────────────────────────────────────────────────" >&2
    cat "${FILE_TMPDIR}/serve.log" >&2 || echo "  (serve.log unreadable)" >&2
    echo "── end serve.log ────────────────────────────────────────────" >&2
    set -e
    return 1
  fi
}

teardown_file() {
  local pid_file="${BATS_FILE_TMPDIR}/server_pid"
  if [[ -f "${pid_file}" ]]; then
    kill "$(cat "${pid_file}")" 2>/dev/null || true
    wait "$(cat "${pid_file}")" 2>/dev/null || true
  fi
}

# ── Helpers ───────────────────────────────────────────────────────────

require_ffmpeg() {
  command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not on PATH (required for this suite)" >&2; return 1; }
  command -v ffprobe >/dev/null 2>&1 || { echo "ffprobe not on PATH (required for this suite)" >&2; return 1; }
}

# Synthesize `$2` (response_format) into ${FILE_TMPDIR}/out; capture headers in
# ${FILE_TMPDIR}/hdr. $1 is the input text.
speak() {
  curl -sS -D "${FILE_TMPDIR}/hdr" -o "${FILE_TMPDIR}/out" "${BASE}/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${TTS_ALIAS}\",\"input\":\"$1\",\"response_format\":\"$2\"}"
}

content_type() {
  grep -i '^content-type:' "${FILE_TMPDIR}/hdr" | tail -1 | tr -d '\r' | sed 's/^[Cc]ontent-[Tt]ype:[[:space:]]*//'
}

# Assert ffprobe sees an audio stream of the expected codec in the output file.
assert_codec() {
  local expected="$1" got
  got=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "${FILE_TMPDIR}/out" 2>/dev/null)
  [[ "${got}" == "${expected}" ]] || { echo "expected codec ${expected}, ffprobe saw '${got}'" >&2; return 1; }
}

# ── Discovery endpoints ───────────────────────────────────────────────

@test "GET /v1/audio/models lists the loaded TTS model" {
  local body
  body=$(curl -sf "${BASE}/v1/audio/models")
  echo "${body}" | jq -e '.object == "list"' >/dev/null
  echo "${body}" | jq -e '.data | length == 1' >/dev/null
  echo "${body}" | jq -e '.data | all(.object == "model")' >/dev/null
  echo "${body}" | jq -e ".data[0].id == \"${TTS_ALIAS}\"" >/dev/null
}

@test "GET /v1/audio/voices returns the configured voices" {
  local body
  body=$(curl -sf "${BASE}/v1/audio/voices")
  echo "${body}" | jq -e '.object == "list"' >/dev/null
  echo "${body}" | jq -e '.voices | index("alloy") != null' >/dev/null
  echo "${body}" | jq -e '.data | any(.id == "alloy")' >/dev/null
}

# ── Native formats (no ffmpeg required) ───────────────────────────────

@test "speech: wav returns audio/wav with a RIFF body" {
  speak "Hello from QVAC." "wav"
  local ct
  ct=$(content_type)
  [[ "${ct}" == "audio/wav" ]] || return 1
  # RIFF magic at byte 0
  local magic
  magic=$(head -c 4 "${FILE_TMPDIR}/out")
  [[ "${magic}" == "RIFF" ]]
}

@test "speech: pcm returns audio/L16 with the sample rate" {
  speak "Hello from QVAC." "pcm"
  content_type | grep -q '^audio/L16; rate=[0-9]\+; channels=1$'
}

# ── Encoded formats (ffmpeg required) ─────────────────────────────────

@test "speech: mp3 encodes to audio/mpeg" {
  require_ffmpeg
  speak "Hello from QVAC." "mp3"
  local ct
  ct=$(content_type)
  [[ "${ct}" == "audio/mpeg" ]] || return 1
  assert_codec "mp3"
}

@test "speech: opus encodes to audio/ogg" {
  require_ffmpeg
  speak "Hello from QVAC." "opus"
  local ct
  ct=$(content_type)
  [[ "${ct}" == "audio/ogg" ]] || return 1
  assert_codec "opus"
}

@test "speech: aac encodes to audio/aac" {
  require_ffmpeg
  speak "Hello from QVAC." "aac"
  local ct
  ct=$(content_type)
  [[ "${ct}" == "audio/aac" ]] || return 1
  assert_codec "aac"
}

@test "speech: flac encodes to audio/flac" {
  require_ffmpeg
  speak "Hello from QVAC." "flac"
  local ct
  ct=$(content_type)
  [[ "${ct}" == "audio/flac" ]] || return 1
  assert_codec "flac"
}
