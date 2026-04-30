#!/usr/bin/env bats

# End-to-end tests with real models (LLM, embedding, whisper).
# Requires: npm run build, jq, @qvac/sdk installed as devDependency.
# These tests download small models and run real inference — expect ~5-10 min on first run.

# Intentionally unquoted on use — BATS `run` needs word splitting for the command.
QVAC="node ${BATS_TEST_DIRNAME}/../dist/index.js"
E2E_PORT=19930
BASE="http://127.0.0.1:${E2E_PORT}"

LLM_ALIAS="test-llm"
EMBED_ALIAS="test-embed"
WHISPER_ALIAS="test-whisper"

# ── Server lifecycle (once per file) ──────────────────────────────────

setup_file() {
  export FILE_TMPDIR="${BATS_FILE_TMPDIR}"

  mkdir -p "${FILE_TMPDIR}/project"

  cat > "${FILE_TMPDIR}/project/qvac.config.json" <<'CONF'
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
      }
    }
  }
}
CONF

  # Generate a 1-second silent WAV (16kHz mono 16-bit PCM).
  # The output path is passed via env var to avoid inline shell expansion inside JS.
  WAV_OUT="${FILE_TMPDIR}/silence.wav" node -e '
    const b = Buffer.alloc(32044);
    b.write("RIFF", 0); b.writeUInt32LE(32036, 4);
    b.write("WAVE", 8); b.write("fmt ", 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
    b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34); b.write("data", 36);
    b.writeUInt32LE(32000, 40);
    require("fs").writeFileSync(process.env.WAV_OUT, b);
  '

  cd "${FILE_TMPDIR}/project"
  ${QVAC} serve openai -p "${E2E_PORT}" --cors &
  echo "$!" > "${FILE_TMPDIR}/server_pid"

  local max_wait=300
  local elapsed=0
  while [[ "${elapsed}" -lt "${max_wait}" ]]; do
    local count
    count=$(curl -sf "${BASE}/v1/models" 2>/dev/null | jq '.data | length' 2>/dev/null || echo 0)
    [[ "${count}" -ge 3 ]] && break
    sleep 2
    elapsed=$((elapsed + 2))
  done

  if [[ "${elapsed}" -ge "${max_wait}" ]]; then
    echo "FATAL: models did not load within ${max_wait}s" >&2
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

assert_error() {
  local body="$1" expected_code="$2"
  echo "${body}" | jq -e ".error.code == \"${expected_code}\"" >/dev/null
}

json_post() {
  curl -s "${BASE}$1" -H "Content-Type: application/json" -d "$2"
}

# ── Models ────────────────────────────────────────────────────────────

@test "GET /v1/models lists all 3 loaded models" {
  local body
  body=$(curl -sf "${BASE}/v1/models")
  echo "${body}" | jq -e '.object == "list"' >/dev/null
  echo "${body}" | jq -e '.data | length == 3' >/dev/null

  local ids
  ids=$(echo "${body}" | jq -r '[.data[].id] | sort | join(",")')
  [[ "${ids}" == "test-embed,test-llm,test-whisper" ]]

  echo "${body}" | jq -e '.data | all(.object == "model")' >/dev/null
  echo "${body}" | jq -e '.data | all(.owned_by == "qvac")' >/dev/null
}

@test "GET /v1/models/:id returns model details" {
  local body
  body=$(curl -sf "${BASE}/v1/models/${LLM_ALIAS}")
  echo "${body}" | jq -e ".id == \"${LLM_ALIAS}\"" >/dev/null
  echo "${body}" | jq -e '.object == "model"' >/dev/null
  echo "${body}" | jq -e '.created | type == "number"' >/dev/null
}

# ── Chat completions (blocking) ──────────────────────────────────────

@test "chat: blocking completion returns valid response" {
  local body
  body=$(json_post "/v1/chat/completions" \
    "{\"model\":\"${LLM_ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hello and nothing else.\"}],\"max_tokens\":16}")

  echo "${body}" | jq -e '.id | startswith("chatcmpl-")' >/dev/null
  echo "${body}" | jq -e '.object == "chat.completion"' >/dev/null
  echo "${body}" | jq -e ".model == \"${LLM_ALIAS}\"" >/dev/null
  echo "${body}" | jq -e '.choices | length == 1' >/dev/null
  echo "${body}" | jq -e '.choices[0].index == 0' >/dev/null
  echo "${body}" | jq -e '.choices[0].message.role == "assistant"' >/dev/null
  echo "${body}" | jq -e '.choices[0].message.content | length > 0' >/dev/null
  echo "${body}" | jq -e '.choices[0].finish_reason == "stop"' >/dev/null
  echo "${body}" | jq -e '.usage.completion_tokens | type == "number"' >/dev/null
}

@test "chat: respects max_completion_tokens" {
  local body
  body=$(json_post "/v1/chat/completions" \
    "{\"model\":\"${LLM_ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"Write a very long story about a cat.\"}],\"max_completion_tokens\":8}")

  echo "${body}" | jq -e '.choices[0].message.content | length > 0' >/dev/null
}

# ── Chat completions (streaming / SSE) ───────────────────────────────

@test "chat: SSE stream returns valid chunks" {
  local raw
  raw=$(curl -sN "${BASE}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${LLM_ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi.\"}],\"stream\":true,\"max_tokens\":16}")

  echo "${raw}" | grep -q "data: \[DONE\]"

  local first_chunk
  first_chunk=$(echo "${raw}" | grep "^data: {" | head -1 | sed 's/^data: //')
  echo "${first_chunk}" | jq -e '.id | startswith("chatcmpl-")' >/dev/null
  echo "${first_chunk}" | jq -e '.object == "chat.completion.chunk"' >/dev/null
  echo "${first_chunk}" | jq -e ".model == \"${LLM_ALIAS}\"" >/dev/null
  echo "${first_chunk}" | jq -e '.choices[0].delta.role == "assistant"' >/dev/null

  local last_chunk
  last_chunk=$(echo "${raw}" | grep "^data: {" | tail -1 | sed 's/^data: //')
  local reason
  reason=$(echo "${last_chunk}" | jq -r '.choices[0].finish_reason')
  [[ "${reason}" == "stop" || "${reason}" == "tool_calls" ]]

  local content_count
  content_count=$(echo "${raw}" | grep "^data: {" | sed 's/^data: //' | \
    jq -r 'select(.choices[0].delta.content != null and .choices[0].delta.content != "") | .choices[0].delta.content' 2>/dev/null | wc -l)
  [[ "${content_count}" -gt 0 ]]
}

# ── Embeddings ────────────────────────────────────────────────────────

@test "embeddings: single input returns vector" {
  local body
  body=$(json_post "/v1/embeddings" \
    "{\"model\":\"${EMBED_ALIAS}\",\"input\":\"Hello world\"}")

  echo "${body}" | jq -e '.object == "list"' >/dev/null
  echo "${body}" | jq -e '.data | length == 1' >/dev/null
  echo "${body}" | jq -e '.data[0].object == "embedding"' >/dev/null
  echo "${body}" | jq -e '.data[0].index == 0' >/dev/null
  echo "${body}" | jq -e '.data[0].embedding | length > 0' >/dev/null
  echo "${body}" | jq -e '.data[0].embedding[0] | type == "number"' >/dev/null
  echo "${body}" | jq -e ".model == \"${EMBED_ALIAS}\"" >/dev/null
}

@test "embeddings: batch input returns multiple vectors" {
  local body
  body=$(json_post "/v1/embeddings" \
    "{\"model\":\"${EMBED_ALIAS}\",\"input\":[\"Hello\",\"World\"]}")

  echo "${body}" | jq -e '.data | length == 2' >/dev/null
  echo "${body}" | jq -e '.data[0].index == 0' >/dev/null
  echo "${body}" | jq -e '.data[1].index == 1' >/dev/null
  echo "${body}" | jq -e '.data[0].embedding | length > 0' >/dev/null
  local dim0 dim1
  dim0=$(echo "${body}" | jq '.data[0].embedding | length')
  dim1=$(echo "${body}" | jq '.data[1].embedding | length')
  [[ "${dim0}" == "${dim1}" ]]
}

# ── Transcriptions ────────────────────────────────────────────────────

@test "transcriptions: returns JSON with text field" {
  local body
  body=$(curl -s "${BASE}/v1/audio/transcriptions" \
    -F "model=${WHISPER_ALIAS}" \
    -F "file=@${BATS_FILE_TMPDIR}/silence.wav;filename=silence.wav")

  echo "${body}" | jq -e '.text | type == "string"' >/dev/null
}

@test "transcriptions: response_format=text returns plain text" {
  local body
  body=$(curl -s "${BASE}/v1/audio/transcriptions" \
    -F "model=${WHISPER_ALIAS}" \
    -F "response_format=text" \
    -F "file=@${BATS_FILE_TMPDIR}/silence.wav;filename=silence.wav")

  ! echo "${body}" | jq -e '.' >/dev/null 2>&1 || [[ $(echo "${body}" | jq -r 'type' 2>/dev/null) == "string" ]]
}

# ── Cross-endpoint model type validation ──────────────────────────────

@test "cross-type: chat endpoint rejects embedding model" {
  local body
  body=$(json_post "/v1/chat/completions" \
    "{\"model\":\"${EMBED_ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
  assert_error "${body}" "invalid_model_type"
}

@test "cross-type: embedding endpoint rejects chat model" {
  local body
  body=$(json_post "/v1/embeddings" \
    "{\"model\":\"${LLM_ALIAS}\",\"input\":\"hello\"}")
  assert_error "${body}" "invalid_model_type"
}

@test "cross-type: transcription endpoint rejects chat model" {
  local body
  body=$(curl -s "${BASE}/v1/audio/transcriptions" \
    -F "model=${LLM_ALIAS}" \
    -F "file=@${BATS_FILE_TMPDIR}/silence.wav;filename=audio.wav")
  assert_error "${body}" "invalid_model_type"
}

# ── Model lifecycle ───────────────────────────────────────────────────
# Run last — unloading a model affects subsequent tests.

@test "DELETE /v1/models/:id unloads model" {
  local body
  body=$(curl -s -X DELETE "${BASE}/v1/models/${WHISPER_ALIAS}")
  echo "${body}" | jq -e ".id == \"${WHISPER_ALIAS}\"" >/dev/null
  echo "${body}" | jq -e '.deleted == true' >/dev/null

  local list
  list=$(curl -sf "${BASE}/v1/models")
  echo "${list}" | jq -e '.data | length == 2' >/dev/null
  echo "${list}" | jq -e "[.data[].id] | index(\"${WHISPER_ALIAS}\") | not" >/dev/null
}
