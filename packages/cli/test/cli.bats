#!/usr/bin/env bats

# CLI smoke tests + serve validation (no models needed, fast).
# Requires: npm run build (tests run against dist/index.js), jq

# Intentionally unquoted on use — BATS `run` needs word splitting for the command.
QVAC="node ${BATS_TEST_DIRNAME}/../dist/index.js"

# ── Shared server lifecycle ───────────────────────────────────────────
# Three server variants started once, shared across all serve tests.

setup_file() {
  export FILE_TMPDIR="${BATS_FILE_TMPDIR}"

  for name in default auth nocors; do
    local dir="${FILE_TMPDIR}/${name}"
    mkdir -p "${dir}"
    echo '{ "serve": { "models": {} } }' > "${dir}/qvac.config.json"
  done

  cd "${FILE_TMPDIR}/default"
  ${QVAC} serve openai -p 19920 --cors &
  echo "$!" > "${FILE_TMPDIR}/pid_default"

  cd "${FILE_TMPDIR}/auth"
  ${QVAC} serve openai -p 19921 --api-key "test-secret-key-12345" &
  echo "$!" > "${FILE_TMPDIR}/pid_auth"

  cd "${FILE_TMPDIR}/nocors"
  ${QVAC} serve openai -p 19922 &
  echo "$!" > "${FILE_TMPDIR}/pid_nocors"

  for port in 19920 19922; do
    for _ in $(seq 1 20); do
      curl -sf "http://127.0.0.1:${port}/v1/models" >/dev/null 2>&1 && break
      sleep 0.25
    done
  done

  for _ in $(seq 1 20); do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:19921/v1/models" 2>/dev/null)
    [[ "${code}" == "401" ]] && break
    sleep 0.25
  done
}

teardown_file() {
  for name in default auth nocors; do
    local pid_file="${BATS_FILE_TMPDIR}/pid_${name}"
    [[ -f "${pid_file}" ]] && kill "$(cat "${pid_file}")" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}

assert_error() {
  local body="$1" expected_code="$2"
  echo "${body}" | jq -e ".error.code == \"${expected_code}\"" >/dev/null
  echo "${body}" | jq -e '.error.message | type == "string"' >/dev/null
}

http_status() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

# ── CLI: version & help ───────────────────────────────────────────────

@test "qvac --version prints semver" {
  run ${QVAC} --version
  [[ "${status}" -eq 0 ]]
  [[ "${output}" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]
}

@test "qvac --help lists commands" {
  run ${QVAC} --help
  [[ "${status}" -eq 0 ]]
  [[ "${output}" =~ "bundle" ]]
  [[ "${output}" =~ "serve" ]]
}

@test "qvac serve openai --help shows options" {
  run ${QVAC} serve openai --help
  [[ "${status}" -eq 0 ]]
  [[ "${output}" =~ "--port" ]]
  [[ "${output}" =~ "--api-key" ]]
  [[ "${output}" =~ "--cors" ]]
  [[ "${output}" =~ "OpenAI-compatible" ]]
}

@test "qvac bundle sdk --help shows options" {
  run ${QVAC} bundle sdk --help
  [[ "${status}" -eq 0 ]]
  [[ "${output}" =~ "--config" ]]
  [[ "${output}" =~ "--sdk-path" ]]
}

# ── CLI: doctor ───────────────────────────────────────────────────────

@test "qvac doctor --help shows options" {
  run ${QVAC} doctor --help
  [[ "${status}" -eq 0 ]]
  [[ "${output}" =~ "--json" ]]
  [[ "${output}" =~ "QVAC SDK system requirements" ]]
}

@test "qvac doctor --json emits valid JSON with ok boolean" {
  run ${QVAC} doctor --json
  [[ "${status}" -eq 0 || "${status}" -eq 1 ]]
  echo "${output}" | jq -e '.ok | type == "boolean"' >/dev/null
  echo "${output}" | jq -e '.sections | length >= 1' >/dev/null
}

# ── CLI: error handling ───────────────────────────────────────────────

@test "cli: missing config file exits 1" {
  run ${QVAC} serve openai -c nonexistent.json
  [[ "${status}" -eq 1 ]]
  [[ "${output}" =~ "Config file not found" ]]
}

@test "cli: invalid config file exits 1" {
  local dir
  dir=$(mktemp -d)
  echo "not json" > "${dir}/qvac.config.json"
  cd "${dir}"
  run ${QVAC} serve openai
  [[ "${status}" -eq 1 ]]
  rm -rf "${dir}"
}

# ── Serve: models endpoint ────────────────────────────────────────────

@test "GET /v1/models returns empty list" {
  local body
  body=$(curl -sf "http://127.0.0.1:19920/v1/models")
  echo "${body}" | jq -e '.object == "list"' >/dev/null
  echo "${body}" | jq -e '.data | length == 0' >/dev/null
}

@test "GET /v1/models/:id returns 404 for unknown model" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/models/nonexistent")
  [[ $(http_status "http://127.0.0.1:19920/v1/models/nonexistent") == "404" ]]
  assert_error "${body}" "model_not_found"
}

@test "DELETE /v1/models/:id returns 404 for unknown model" {
  local body
  body=$(curl -s -X DELETE "http://127.0.0.1:19920/v1/models/nonexistent")
  assert_error "${body}" "model_not_found"
}

# ── Serve: chat completions validation ────────────────────────────────

@test "chat: invalid JSON returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/chat/completions" \
    -H "Content-Type: application/json" -d '{not valid json}')
  assert_error "${body}" "invalid_json"
}

@test "chat: missing model returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"hi"}]}')
  assert_error "${body}" "missing_model"
}

@test "chat: missing messages returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/chat/completions" \
    -H "Content-Type: application/json" -d '{"model":"test"}')
  assert_error "${body}" "missing_messages"
}

@test "chat: unknown model returns 404" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"model":"nonexistent","messages":[{"role":"user","content":"hi"}]}')
  assert_error "${body}" "model_not_found"
}

# ── Serve: embeddings validation ──────────────────────────────────────

@test "embeddings: invalid JSON returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/embeddings" \
    -H "Content-Type: application/json" -d '{{bad')
  assert_error "${body}" "invalid_json"
}

@test "embeddings: missing model returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/embeddings" \
    -H "Content-Type: application/json" -d '{"input":"hello"}')
  assert_error "${body}" "missing_model"
}

@test "embeddings: missing input returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/embeddings" \
    -H "Content-Type: application/json" -d '{"model":"test"}')
  assert_error "${body}" "missing_input"
}

@test "embeddings: unknown model returns 404" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/embeddings" \
    -H "Content-Type: application/json" -d '{"model":"nonexistent","input":"hello"}')
  assert_error "${body}" "model_not_found"
}

# ── Serve: transcriptions validation ──────────────────────────────────

@test "transcriptions: JSON content-type returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/transcriptions" \
    -H "Content-Type: application/json" -d '{"model":"test"}')
  assert_error "${body}" "invalid_content_type"
}

@test "transcriptions: missing file returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/transcriptions" -F "model=test")
  assert_error "${body}" "missing_file"
}

@test "transcriptions: missing model returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/transcriptions" \
    -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "missing_model"
}

@test "transcriptions: unsupported srt format returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/transcriptions" \
    -F "model=test" -F "response_format=srt" -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "unsupported_response_format"
}

@test "transcriptions: unsupported vtt format returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/transcriptions" \
    -F "model=test" -F "response_format=vtt" -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "unsupported_response_format"
}

@test "transcriptions: unsupported verbose_json format returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/transcriptions" \
    -F "model=test" -F "response_format=verbose_json" -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "unsupported_response_format"
}

@test "transcriptions: invalid xml format returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/transcriptions" \
    -F "model=test" -F "response_format=xml" -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "invalid_response_format"
}

@test "transcriptions: unknown model returns 404" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/transcriptions" \
    -F "model=nonexistent" -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "model_not_found"
}

# ── Serve: routing ────────────────────────────────────────────────────

@test "GET /unknown returns 404" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/unknown")
  assert_error "${body}" "not_found"
}

@test "GET /v1/unknown returns 404" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/unknown")
  assert_error "${body}" "not_found"
}

# ── Serve: CORS ───────────────────────────────────────────────────────

@test "OPTIONS /v1/models returns 204 with CORS headers" {
  local headers
  headers=$(curl -sf -D- -o /dev/null -X OPTIONS "http://127.0.0.1:19920/v1/models")
  [[ "${headers}" =~ "204" ]]
  [[ "${headers}" =~ [Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin ]]
  [[ "${headers}" =~ "POST" ]]
}

@test "CORS headers present on regular GET" {
  local headers
  headers=$(curl -sf -D- -o /dev/null "http://127.0.0.1:19920/v1/models")
  [[ "${headers}" =~ [Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin ]]
}

@test "no-CORS: OPTIONS returns 204 without CORS headers" {
  local headers
  headers=$(curl -s -D- -o /dev/null -X OPTIONS "http://127.0.0.1:19922/v1/models")
  [[ "${headers}" =~ "204" ]]
  ! [[ "${headers}" =~ [Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin ]]
}

@test "no-CORS: regular GET has no CORS headers" {
  local headers
  headers=$(curl -sf -D- -o /dev/null "http://127.0.0.1:19922/v1/models")
  ! [[ "${headers}" =~ [Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin ]]
}

# ── Serve: auth ───────────────────────────────────────────────────────

@test "auth: no key returns 401" {
  local body
  body=$(curl -s "http://127.0.0.1:19921/v1/models")
  assert_error "${body}" "invalid_api_key"
}

@test "auth: wrong key returns 401" {
  local body
  body=$(curl -s -H "Authorization: Bearer wrong-key" "http://127.0.0.1:19921/v1/models")
  assert_error "${body}" "invalid_api_key"
}

@test "auth: correct key returns 200" {
  [[ $(http_status -H "Authorization: Bearer test-secret-key-12345" "http://127.0.0.1:19921/v1/models") == "200" ]]
}
