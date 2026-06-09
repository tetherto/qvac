#!/usr/bin/env bats

# End-to-end tests with real models (LLM, embedding, whisper transcription + translation).
# Requires: npm run build, jq, @qvac/sdk installed as devDependency.
# These tests download small models and run real inference — expect ~5-10 min on first run.
#
# ⚠ BASH 3.2 COMPATIBILITY (macOS default) ⚠
#
# Assertions in this file must work under macOS's stock bash 3.2 (where
# `set -e` does NOT propagate failures from a standalone `[[ ... ]]` — the
# test silently continues past the failed assertion). CI runs bash 5.x and
# *does* propagate, so a local-vs-CI green/red divergence is the symptom.
#
# Required pattern: every `[[ ... ]]` assertion must be the LAST command of
# the @test, OR chained so that its exit code reaches the test's last line:
#
#   ✅  [[ "${a}" == 1 ]] \
#         && [[ "${b}" == 2 ]] \
#         && [[ "${c}" == 3 ]]
#
#   ✅  [[ "${status}" -eq 1 ]] || return 1
#       <followup non-assertion commands>
#
#   ❌  [[ "${a}" == 1 ]]
#       [[ "${b}" == 2 ]]              # bash 3.2 hides failure of line above
#       <followup commands>            # also hide failures of [[ ]] above

# Intentionally unquoted on use — BATS `run` needs word splitting for the command.
QVAC="node ${BATS_TEST_DIRNAME}/../dist/index.js"
E2E_PORT=19930
BASE="http://127.0.0.1:${E2E_PORT}"

LLM_ALIAS="test-llm"
EMBED_ALIAS="test-embed"
WHISPER_ALIAS="test-whisper"
WHISPER_TRANSLATE_ALIAS="test-whisper-translate"

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
  ${QVAC} serve openai -p "${E2E_PORT}" --cors >"${FILE_TMPDIR}/serve.log" 2>&1 &
  echo "$!" > "${FILE_TMPDIR}/server_pid"

  local max_wait="${E2E_MAX_WAIT:-300}"
  local elapsed=0
  while [[ "${elapsed}" -lt "${max_wait}" ]]; do
    local count
    count=$(curl -sf "${BASE}/v1/models" 2>/dev/null | jq '.data | length' 2>/dev/null || echo 0)
    [[ "${count}" -ge 4 ]] && break
    sleep 2
    elapsed=$((elapsed + 2))
  done

  if [[ "${elapsed}" -ge "${max_wait}" ]]; then
    echo "FATAL: models did not load within ${max_wait}s" >&2

    # ── Failure diagnostics ──────────────────────────────────────────
    # Disable errexit for the whole block. Any single command failing here
    # (curl returning non-zero against a dead server, cat on a missing file,
    # kill -0 on a stale pid) would otherwise abort the block under bats'
    # `set -eET` and we'd lose everything that comes after — most importantly
    # the serve.log dump, which is the actual reason we got here.
    set +e

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

assert_error() {
  local body="$1" expected_code="$2"
  echo "${body}" | jq -e ".error.code == \"${expected_code}\"" >/dev/null
}

json_post() {
  curl -s "${BASE}$1" -H "Content-Type: application/json" -d "$2"
}

json_post_capture() {
  curl -sS -D "${FILE_TMPDIR}/resp.hdr" -o "${FILE_TMPDIR}/resp.body" "${BASE}$1" -H "Content-Type: application/json" -d "$2"
}

# ── Models ────────────────────────────────────────────────────────────

@test "GET /v1/models lists all 4 loaded models" {
  local body
  body=$(curl -sf "${BASE}/v1/models")
  echo "${body}" | jq -e '.object == "list"' >/dev/null
  echo "${body}" | jq -e '.data | length == 4' >/dev/null

  local ids
  ids=$(echo "${body}" | jq -r '[.data[].id] | sort | join(",")')
  [[ "${ids}" == "test-embed,test-llm,test-whisper,test-whisper-translate" ]] || return 1

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
    "{\"model\":\"${LLM_ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hello and nothing else.\"}],\"max_tokens\":512}")

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

@test "chat: finish_reason=length when max_tokens exceeded (blocking)" {
  local body
  body=$(json_post "/v1/chat/completions" \
    "{\"model\":\"${LLM_ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"Count from 1 to 100.\"}],\"max_tokens\":1}")

  echo "${body}" | jq -e '.choices[0].finish_reason == "length"' >/dev/null
  echo "${body}" | jq -e '.usage.completion_tokens == 1' >/dev/null
}

@test "chat: finish_reason=length when max_tokens exceeded (streaming)" {
  local raw
  raw=$(curl -sN "${BASE}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${LLM_ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"Count from 1 to 100.\"}],\"stream\":true,\"max_tokens\":1}")

  local last_chunk
  last_chunk=$(echo "${raw}" | grep "^data: {" | tail -1 | sed 's/^data: //')
  echo "${last_chunk}" | jq -e '.choices[0].finish_reason == "length"' >/dev/null
  echo "${last_chunk}" | jq -e '.usage.completion_tokens == 1' >/dev/null
}

# ── Chat completions (streaming / SSE) ───────────────────────────────

@test "chat: SSE stream returns valid chunks" {
  local raw
  raw=$(curl -sN "${BASE}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${LLM_ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi.\"}],\"stream\":true,\"max_tokens\":512}")

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
  [[ "${reason}" == "stop" || "${reason}" == "tool_calls" ]] || return 1

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

# ── Translations (Whisper translate-to-English) ─────────────────────

@test "translations: returns JSON with text field" {
  local body
  body=$(curl -s "${BASE}/v1/audio/translations" \
    -F "model=${WHISPER_TRANSLATE_ALIAS}" \
    -F "file=@${BATS_FILE_TMPDIR}/silence.wav;filename=silence.wav")

  echo "${body}" | jq -e '.text | type == "string"' >/dev/null
}

@test "translations: response_format=text returns plain text" {
  local body
  body=$(curl -s "${BASE}/v1/audio/translations" \
    -F "model=${WHISPER_TRANSLATE_ALIAS}" \
    -F "response_format=text" \
    -F "file=@${BATS_FILE_TMPDIR}/silence.wav;filename=silence.wav")

  ! echo "${body}" | jq -e '.' >/dev/null 2>&1 || [[ $(echo "${body}" | jq -r 'type' 2>/dev/null) == "string" ]]
}

@test "translations: rejects transcription-only alias" {
  local body
  body=$(curl -s "${BASE}/v1/audio/translations" \
    -F "model=${WHISPER_ALIAS}" \
    -F "file=@${BATS_FILE_TMPDIR}/silence.wav;filename=silence.wav")
  assert_error "${body}" "invalid_model_type"
}

# ── Vector stores ─────────────────────────────────────────────────────
# Each test is self-contained (creates the store/file it needs and cleans
# up) so they survive `bats -f <pattern>` filtering and can run in any
# order. The happy-path "upload → attach → search → delete" lives in a
# single @test to keep the dependent steps together without leaking state
# via files.

VS_DOC_FILE="${BATS_FILE_TMPDIR:-/tmp}/vs_doc.txt"

@test "vector_stores: CRUD — create, list, get, update, delete" {
  local create
  create=$(json_post "/v1/vector_stores" '{"name":"crud","metadata":{"by":"e2e.bats"}}')
  echo "${create}" | jq -e '.object == "vector_store"' >/dev/null
  echo "${create}" | jq -e '.id | startswith("vs_")' >/dev/null
  echo "${create}" | jq -e '.name == "crud"' >/dev/null
  local id
  id=$(echo "${create}" | jq -r '.id')

  local list
  list=$(curl -sf "${BASE}/v1/vector_stores")
  echo "${list}" | jq -e '.object == "list"' >/dev/null
  echo "${list}" | jq -e --arg id "${id}" 'any(.data[]; .id == $id)' >/dev/null

  local get_before
  get_before=$(curl -sf "${BASE}/v1/vector_stores/${id}")
  echo "${get_before}" | jq -e --arg id "${id}" '.id == $id' >/dev/null
  echo "${get_before}" | jq -e '.status == "in_progress"' >/dev/null

  local update
  update=$(json_post "/v1/vector_stores/${id}" '{"name":"crud-updated"}')
  echo "${update}" | jq -e '.name == "crud-updated"' >/dev/null

  local del
  del=$(curl -s -X DELETE "${BASE}/v1/vector_stores/${id}")
  echo "${del}" | jq -e --arg id "${id}" '.id == $id' >/dev/null
  echo "${del}" | jq -e '.object == "vector_store.deleted"' >/dev/null
  echo "${del}" | jq -e '.deleted == true' >/dev/null

  local status_after
  status_after=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/v1/vector_stores/${id}")
  [[ "${status_after}" == "404" ]]
}

@test "vector_stores: upload → attach → search end-to-end" {
  cat > "${VS_DOC_FILE}" <<'TXT'
Local e2e document about planets, moons and the solar system.
Another note about OpenAI vector stores and RAG.
TXT

  local vs
  vs=$(json_post "/v1/vector_stores" '{"name":"flow"}' | jq -r '.id')

  local upload file
  upload=$(curl -sf "${BASE}/v1/files" \
    -F "file=@${VS_DOC_FILE};type=text/plain" \
    -F "purpose=assistants")
  echo "${upload}" | jq -e '.object == "file"' >/dev/null
  echo "${upload}" | jq -e '.id | startswith("file-")' >/dev/null
  echo "${upload}" | jq -e '.status == "uploaded"' >/dev/null
  echo "${upload}" | jq -e '.purpose == "assistants"' >/dev/null
  file=$(echo "${upload}" | jq -r '.id')

  curl -sf "${BASE}/v1/files" | jq -e --arg id "${file}" 'any(.data[]; .id == $id)' >/dev/null
  curl -sf "${BASE}/v1/files/${file}" | jq -e --arg id "${file}" '.id == $id and .object == "file"' >/dev/null

  local attach
  attach=$(json_post "/v1/vector_stores/${vs}/files" "{\"file_id\":\"${file}\"}")
  echo "${attach}" | jq -e '.object == "vector_store.file"' >/dev/null
  echo "${attach}" | jq -e --arg id "${file}" '.id == $id' >/dev/null
  echo "${attach}" | jq -e --arg vs "${vs}" '.vector_store_id == $vs' >/dev/null
  echo "${attach}" | jq -e '.status == "completed"' >/dev/null
  echo "${attach}" | jq -e '.last_error == null' >/dev/null
  echo "${attach}" | jq -e '.usage_bytes | type == "number"' >/dev/null

  # Bytes are dropped from the in-memory file store after attach.
  local file_status_after
  file_status_after=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/v1/files/${file}")
  [[ "${file_status_after}" == "404" ]] || return 1

  curl -sf "${BASE}/v1/vector_stores/${vs}" | jq -e '.status == "completed"' >/dev/null

  local search
  search=$(json_post "/v1/vector_stores/${vs}/search" \
    '{"query":"planets and solar system","max_num_results":5}')
  echo "${search}" | jq -e '.object == "vector_store.search_results.page"' >/dev/null
  echo "${search}" | jq -e '.data | type == "array"' >/dev/null
  echo "${search}" | jq -e '.data | length > 0' >/dev/null
  echo "${search}" | jq -e '
    any(.data[];
      (.content // []) | map(select(.type == "text") | .text // "") | join(" ")
        | test("planets|moons|OpenAI|vector stores"; "i"))
  ' >/dev/null

  curl -s -X DELETE "${BASE}/v1/vector_stores/${vs}" >/dev/null
}

@test "vector_stores: search with missing query returns 400 missing_query" {
  local vs body
  vs=$(json_post "/v1/vector_stores" '{}' | jq -r '.id')
  body=$(json_post "/v1/vector_stores/${vs}/search" '{}')
  assert_error "${body}" "missing_query"
  curl -s -X DELETE "${BASE}/v1/vector_stores/${vs}" >/dev/null
}

@test "vector_stores: attach with unknown file_id returns 404 file_not_found" {
  local vs body
  vs=$(json_post "/v1/vector_stores" '{}' | jq -r '.id')
  body=$(json_post "/v1/vector_stores/${vs}/files" '{"file_id":"file-doesnotexist"}')
  assert_error "${body}" "file_not_found"
  curl -s -X DELETE "${BASE}/v1/vector_stores/${vs}" >/dev/null
}

@test "vector_stores: attach with missing file_id returns 400 missing_file_id" {
  local vs body
  vs=$(json_post "/v1/vector_stores" '{}' | jq -r '.id')
  body=$(json_post "/v1/vector_stores/${vs}/files" '{}')
  assert_error "${body}" "missing_file_id"
  curl -s -X DELETE "${BASE}/v1/vector_stores/${vs}" >/dev/null
}

@test "vector_stores: attach binary upload returns 400 unsupported_file_type" {
  local vs upload file body
  vs=$(json_post "/v1/vector_stores" '{"name":"binary-sad"}' | jq -r '.id')

  # PNG magic header — contains NUL bytes so looksBinary catches it.
  local png_path="${BATS_TEST_TMPDIR}/bin.png"
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR' > "${png_path}"

  upload=$(curl -sf "${BASE}/v1/files" \
    -F "file=@${png_path};type=image/png" \
    -F "purpose=assistants")
  file=$(echo "${upload}" | jq -r '.id')

  body=$(json_post "/v1/vector_stores/${vs}/files" "{\"file_id\":\"${file}\"}")
  assert_error "${body}" "unsupported_file_type"

  curl -s -X DELETE "${BASE}/v1/vector_stores/${vs}" >/dev/null
}

@test "vector_stores: invalid id returns 400 invalid_vector_store_id" {
  local body
  body=$(curl -s "${BASE}/v1/vector_stores/bad%2Fid")
  assert_error "${body}" "invalid_vector_store_id"
}

# ── Responses API ─────────────────────────────────────────────────────

@test "responses: startup log documents volatile store" {
  grep -q 'responses: in-memory only' "${FILE_TMPDIR}/serve.log"
}

@test "responses: blocking completion returns response shape and stub header" {
  json_post_capture "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"input\":\"Reply with exactly OK.\"}"
  grep -qi 'X-QVAC-Stub: responses-volatile' "${FILE_TMPDIR}/resp.hdr"
  jq -e '.id | startswith("resp_")' "${FILE_TMPDIR}/resp.body" >/dev/null
  jq -e '.object == "response"' "${FILE_TMPDIR}/resp.body" >/dev/null
  jq -e '.output_text | length > 0' "${FILE_TMPDIR}/resp.body" >/dev/null
  jq -e '.usage.output_tokens | type == "number"' "${FILE_TMPDIR}/resp.body" >/dev/null
}

@test "responses: streaming returns response.completed and stub header" {
  curl -sN -D "${FILE_TMPDIR}/resp.hdr" -o "${FILE_TMPDIR}/resp.body" "${BASE}/v1/responses" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${LLM_ALIAS}\",\"input\":\"Say hi.\",\"stream\":true,\"max_output_tokens\":512}"
  grep -qi 'X-QVAC-Stub: responses-volatile' "${FILE_TMPDIR}/resp.hdr"
  grep -q 'response.created' "${FILE_TMPDIR}/resp.body"
  grep -q 'response.completed' "${FILE_TMPDIR}/resp.body"
  # OpenAI Responses spec terminates on response.completed; no [DONE] sentinel.
  ! grep -q 'data: \[DONE\]' "${FILE_TMPDIR}/resp.body"
}

@test "responses: store retrieve delete and input_items" {
  json_post_capture "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"input\":\"ping\",\"store\":true}"
  local rid
  rid=$(jq -r '.id' "${FILE_TMPDIR}/resp.body")
  [[ "${rid}" == resp_* ]] || return 1

  curl -sS -D "${FILE_TMPDIR}/g.hdr" -o "${FILE_TMPDIR}/g.body" "${BASE}/v1/responses/${rid}"
  grep -qi 'X-QVAC-Stub: responses-volatile' "${FILE_TMPDIR}/g.hdr"
  jq -e ".id == \"${rid}\"" "${FILE_TMPDIR}/g.body" >/dev/null

  curl -sS -D "${FILE_TMPDIR}/i.hdr" -o "${FILE_TMPDIR}/i.body" "${BASE}/v1/responses/${rid}/input_items"
  grep -qi 'X-QVAC-Stub: responses-volatile' "${FILE_TMPDIR}/i.hdr"
  jq -e '.object == "list"' "${FILE_TMPDIR}/i.body" >/dev/null
  jq -e '.data | length >= 1' "${FILE_TMPDIR}/i.body" >/dev/null

  curl -sS -D "${FILE_TMPDIR}/d.hdr" -o "${FILE_TMPDIR}/d.body" -X DELETE "${BASE}/v1/responses/${rid}"
  jq -e '.deleted == true' "${FILE_TMPDIR}/d.body" >/dev/null

  local gone
  gone=$(curl -s "${BASE}/v1/responses/${rid}")
  assert_error "${gone}" "response_not_found"
}

@test "responses: previous_response_id chains context" {
  # Pin sampling (temperature=0, seed) and give a generous token budget so the tiny reasoning
  # LLM has room for both its <think> block and an actual answer. Test exercises chain wiring,
  # not the model's creativity, so XYZZY recall must be deterministic.
  json_post_capture "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"input\":\"Remember the code word is XYZZY.\",\"store\":true,\"max_output_tokens\":512,\"temperature\":0,\"seed\":1}"
  local rid
  rid=$(jq -r '.id' "${FILE_TMPDIR}/resp.body")

  local body2
  body2=$(json_post "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"previous_response_id\":\"${rid}\",\"input\":\"What is the code word? Reply with one word only.\",\"max_output_tokens\":512,\"temperature\":0,\"seed\":1}")
  echo "${body2}" | jq -e '(.output_text | test("XYZZY"; "i"))' >/dev/null
}

@test "responses: previous_response_id walks deeper than one step (chain depth 3)" {
  # Each StoredResponse only carries its own NEW input items, so without a recursive walk
  # depth-3 chains would silently lose the grandparent turn. This test asserts the resp_1
  # fact (XYZZY) survives through resp_2 (innocuous) into resp_3.
  json_post_capture "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"input\":\"Remember the code word is XYZZY.\",\"store\":true,\"max_output_tokens\":512,\"temperature\":0,\"seed\":1}"
  local rid1
  rid1=$(jq -r '.id' "${FILE_TMPDIR}/resp.body")

  json_post_capture "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"previous_response_id\":\"${rid1}\",\"input\":\"Got it.\",\"store\":true,\"max_output_tokens\":256,\"temperature\":0,\"seed\":1}"
  local rid2
  rid2=$(jq -r '.id' "${FILE_TMPDIR}/resp.body")

  local body3
  body3=$(json_post "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"previous_response_id\":\"${rid2}\",\"input\":\"What is the code word? Reply with one word only.\",\"max_output_tokens\":512,\"temperature\":0,\"seed\":1}")
  echo "${body3}" | jq -e '(.output_text | test("XYZZY"; "i"))' >/dev/null
}

@test "responses: bogus previous_response_id returns 404" {
  local body
  body=$(json_post "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"previous_response_id\":\"resp_nonexistent123\",\"input\":\"hi\"}")
  assert_error "${body}" "previous_response_not_found"
}

@test "responses: rejects conversation id" {
  local body
  body=$(json_post "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"conversation\":\"conv_1\",\"input\":\"hi\"}")
  assert_error "${body}" "conversation_not_supported"
}

@test "responses: rejects background mode" {
  local body
  body=$(json_post "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"background\":true,\"input\":\"hi\"}")
  assert_error "${body}" "background_not_supported"
}

@test "responses: rejects built-in web_search tool" {
  local body
  body=$(json_post "/v1/responses" "{\"model\":\"${LLM_ALIAS}\",\"input\":\"hi\",\"tools\":[{\"type\":\"web_search\"}]}")
  assert_error "${body}" "invalid_tool_type"
}

# ── Cross-endpoint model type validation ──────────────────────────────

@test "cross-type: chat endpoint rejects embedding model" {
  local body
  body=$(json_post "/v1/chat/completions" \
    "{\"model\":\"${EMBED_ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
  assert_error "${body}" "invalid_model_type"
}

# ── Legacy completions (blocking) ────────────────────────────────────

@test "legacy completions: blocking returns text_completion shape" {
  local body
  body=$(json_post "/v1/completions" \
    "{\"model\":\"${LLM_ALIAS}\",\"prompt\":\"Say hello and nothing else.\",\"max_tokens\":512}")

  echo "${body}" | jq -e '.id | startswith("cmpl-")' >/dev/null
  echo "${body}" | jq -e '.object == "text_completion"' >/dev/null
  echo "${body}" | jq -e ".model == \"${LLM_ALIAS}\"" >/dev/null
  echo "${body}" | jq -e '.choices | length == 1' >/dev/null
  echo "${body}" | jq -e '.choices[0].index == 0' >/dev/null
  echo "${body}" | jq -e '.choices[0].text | type == "string"' >/dev/null
  echo "${body}" | jq -e '.choices[0].text | length > 0' >/dev/null
  echo "${body}" | jq -e '.choices[0].logprobs == null' >/dev/null
  echo "${body}" | jq -e '.choices[0].finish_reason == "stop"' >/dev/null
  echo "${body}" | jq -e '.usage.completion_tokens | type == "number"' >/dev/null
}

@test "legacy completions: respects max_tokens" {
  local body
  body=$(json_post "/v1/completions" \
    "{\"model\":\"${LLM_ALIAS}\",\"prompt\":\"Write a very long story about a cat.\",\"max_tokens\":8}")

  echo "${body}" | jq -e '.choices[0].text | length > 0' >/dev/null
}

# ── Legacy completions (multi-prompt fan-out) ────────────────────────

@test "legacy completions: multi-prompt blocking returns N choices with matching indices" {
  local body
  body=$(json_post "/v1/completions" \
    "{\"model\":\"${LLM_ALIAS}\",\"prompt\":[\"Reply with the word \\\"alpha\\\".\",\"Reply with the word \\\"beta\\\".\"],\"max_tokens\":512}")

  echo "${body}" | jq -e '.object == "text_completion"' >/dev/null
  echo "${body}" | jq -e '.choices | length == 2' >/dev/null
  echo "${body}" | jq -e '.choices[0].index == 0' >/dev/null
  echo "${body}" | jq -e '.choices[1].index == 1' >/dev/null
  echo "${body}" | jq -e '.choices[0].text | length > 0' >/dev/null
  echo "${body}" | jq -e '.choices[1].text | length > 0' >/dev/null
  echo "${body}" | jq -e '.choices[0].finish_reason == "stop"' >/dev/null
  echo "${body}" | jq -e '.choices[1].finish_reason == "stop"' >/dev/null
}

@test "legacy completions: multi-prompt with stream:true returns 400 unsupported_streaming" {
  local body
  body=$(json_post "/v1/completions" \
    "{\"model\":\"${LLM_ALIAS}\",\"prompt\":[\"a\",\"b\"],\"stream\":true,\"max_tokens\":4}")
  assert_error "${body}" "unsupported_streaming"
}

@test "legacy completions: rejects token-id prompts" {
  local body
  body=$(json_post "/v1/completions" \
    "{\"model\":\"${LLM_ALIAS}\",\"prompt\":[15496,11,995],\"max_tokens\":4}")
  assert_error "${body}" "invalid_prompt"
}

@test "legacy completions: rejects missing prompt" {
  local body
  body=$(json_post "/v1/completions" \
    "{\"model\":\"${LLM_ALIAS}\",\"max_tokens\":4}")
  assert_error "${body}" "invalid_prompt"
}

# ── Legacy completions (streaming / SSE) ─────────────────────────────

@test "legacy completions: SSE stream returns valid text_completion chunks" {
  local raw
  raw=$(curl -sN "${BASE}/v1/completions" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${LLM_ALIAS}\",\"prompt\":\"Say hi.\",\"stream\":true,\"max_tokens\":512}")

  echo "${raw}" | grep -q "data: \[DONE\]"

  local first_chunk
  first_chunk=$(echo "${raw}" | grep "^data: {" | head -1 | sed 's/^data: //')
  echo "${first_chunk}" | jq -e '.id | startswith("cmpl-")' >/dev/null
  echo "${first_chunk}" | jq -e '.object == "text_completion"' >/dev/null
  echo "${first_chunk}" | jq -e ".model == \"${LLM_ALIAS}\"" >/dev/null
  echo "${first_chunk}" | jq -e '.choices[0].text | type == "string"' >/dev/null
  echo "${first_chunk}" | jq -e '.choices[0].logprobs == null' >/dev/null

  local last_chunk
  last_chunk=$(echo "${raw}" | grep "^data: {" | tail -1 | sed 's/^data: //')
  echo "${last_chunk}" | jq -e '.choices[0].finish_reason == "stop"' >/dev/null
  echo "${last_chunk}" | jq -e '.usage.completion_tokens | type == "number"' >/dev/null

  local content_count
  content_count=$(echo "${raw}" | grep "^data: {" | sed 's/^data: //' | \
    jq -r 'select(.choices[0].text != null and .choices[0].text != "") | .choices[0].text' 2>/dev/null | wc -l)
  [[ "${content_count}" -gt 0 ]]
}

# ── Legacy completions: cross-type rejection ─────────────────────────

@test "cross-type: legacy completions endpoint rejects embedding model" {
  local body
  body=$(json_post "/v1/completions" \
    "{\"model\":\"${EMBED_ALIAS}\",\"prompt\":\"hi\"}")
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

@test "cross-type: translations endpoint rejects chat model" {
  local body
  body=$(curl -s "${BASE}/v1/audio/translations" \
    -F "model=${LLM_ALIAS}" \
    -F "file=@${BATS_FILE_TMPDIR}/silence.wav;filename=audio.wav")
  assert_error "${body}" "invalid_model_type"
}

@test "cross-type: responses endpoint rejects embedding model" {
  local body
  body=$(json_post "/v1/responses" "{\"model\":\"${EMBED_ALIAS}\",\"input\":\"hello\"}")
  assert_error "${body}" "invalid_model_type"
}

# ── Model lifecycle ───────────────────────────────────────────────────
# Run last — unloading a model affects subsequent tests.

@test "DELETE /v1/models/:id unloads model" {
  local body
  body=$(curl -s -X DELETE "${BASE}/v1/models/${WHISPER_TRANSLATE_ALIAS}")
  echo "${body}" | jq -e ".id == \"${WHISPER_TRANSLATE_ALIAS}\"" >/dev/null
  echo "${body}" | jq -e '.deleted == true' >/dev/null

  body=$(curl -s -X DELETE "${BASE}/v1/models/${WHISPER_ALIAS}")
  echo "${body}" | jq -e ".id == \"${WHISPER_ALIAS}\"" >/dev/null
  echo "${body}" | jq -e '.deleted == true' >/dev/null

  local list
  list=$(curl -sf "${BASE}/v1/models")
  echo "${list}" | jq -e '.data | length == 2' >/dev/null
  echo "${list}" | jq -e "[.data[].id] | index(\"${WHISPER_ALIAS}\") | not" >/dev/null
  echo "${list}" | jq -e "[.data[].id] | index(\"${WHISPER_TRANSLATE_ALIAS}\") | not" >/dev/null
}
