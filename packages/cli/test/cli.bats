#!/usr/bin/env bats

# CLI smoke tests + serve validation (no models needed, fast).
# Requires: npm run build (tests run against dist/index.js), jq

# Intentionally unquoted on use — BATS `run` needs word splitting for the command.
QVAC="node ${BATS_TEST_DIRNAME}/../dist/index.js"

# ── Shared server lifecycle ───────────────────────────────────────────
# Three server variants started once, shared across all serve tests.

setup_file() {
  export FILE_TMPDIR="${BATS_FILE_TMPDIR}"

  for name in default auth nocors puburl; do
    local dir="${FILE_TMPDIR}/${name}"
    mkdir -p "${dir}"
    echo '{"serve":{"models":{"fake-transcribe":{"type":"whispercpp-transcription","src":"hyper://example.invalid/model","preload":false}}}}' > "${dir}/qvac.config.json"
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

  cd "${FILE_TMPDIR}/puburl"
  ${QVAC} serve openai -p 19923 --public-base-url "http://127.0.0.1:19923" &
  echo "$!" > "${FILE_TMPDIR}/pid_puburl"

  for port in 19920 19922 19923; do
    for _ in $(seq 1 20); do
      curl -sf "http://127.0.0.1:${port}/v1/models" >/dev/null 2>&1 && break
      sleep 0.25
    done
  done

  for _ in $(seq 1 20); do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:19921/v1/models" 2>/dev/null || echo "000")
    [[ "${code}" == "401" ]] && break
    sleep 0.25
  done

  # Minimal 1x1 PNG for multipart /v1/images/edits tests.
  node -e "
    const fs = require('fs');
    const p = '${FILE_TMPDIR}/tiny.png';
    const b = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    fs.writeFileSync(p, b);
  "
}

teardown_file() {
  for name in default auth nocors puburl; do
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
  [[ "${output}" =~ "verify" ]]
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

@test "qvac verify deps --help shows options" {
  run ${QVAC} verify deps --help
  [[ "${status}" -eq 0 ]]
  [[ "${output}" =~ "--base" ]]
  [[ "${output}" =~ "--head" ]]
  [[ "${output}" =~ "--lockfile" ]]
}

@test "qvac verify deps requires base and head" {
  run ${QVAC} verify deps --base HEAD
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "--head" ]]
}

@test "qvac verify deps rejects unsupported lockfiles" {
  run ${QVAC} verify deps --base HEAD --head HEAD --lockfile bun.lock
  [[ "${status}" -eq 2 ]]
  [[ "${output}" =~ "Unsupported lockfile" ]]
  [[ "${output}" =~ "package-lock.json" ]]
}

@test "qvac verify bundle --help shows options" {
  run ${QVAC} verify bundle --help
  [[ "${status}" -eq 0 ]]
  [[ "${output}" =~ "--addons-source" ]]
  [[ "${output}" =~ "--host" ]]
  [[ "${output}" =~ "--bare-runtime-version" ]]
  [[ "${output}" =~ "--config" ]]
}

@test "qvac verify bundle requires --addons-source" {
  run ${QVAC} verify bundle --host android-arm64
  [[ "${status}" -eq 1 ]]
  [[ "${output}" =~ "--addons-source" ]]
}

@test "qvac verify bundle rejects missing --addons-source path" {
  run ${QVAC} verify bundle --addons-source /nonexistent/path --host android-arm64
  [[ "${status}" -eq 1 ]]
  [[ "${output}" =~ "not a readable file or directory" ]]
}

@test "qvac verify bundle rejects empty --host list" {
  local dir
  dir=$(mktemp -d)
  mkdir -p "${dir}/node_modules"
  run ${QVAC} verify bundle --addons-source "${dir}/node_modules"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" =~ "--host" ]]
  rm -rf "${dir}"
}

@test "qvac verify bundle passes on empty node_modules" {
  local dir
  dir=$(mktemp -d)
  mkdir -p "${dir}/node_modules"
  run ${QVAC} verify bundle --addons-source "${dir}/node_modules" --host darwin-arm64
  [[ "${status}" -eq 0 ]]
  [[ "${output}" =~ "verification passed" ]]
  rm -rf "${dir}"
}

@test "qvac verify bundle rejects malformed --bare-runtime-version" {
  local dir
  dir=$(mktemp -d)
  mkdir -p "${dir}/node_modules"
  run ${QVAC} verify bundle --addons-source "${dir}/node_modules" --host darwin-arm64 --bare-runtime-version not-a-version
  [[ "${status}" -eq 1 ]]
  [[ "${output}" =~ "Invalid Bare runtime version" ]]
  [[ "${output}" =~ "not-a-version" ]]
  rm -rf "${dir}"
}

@test "qvac verify bundle rejects malformed bareRuntimeVersion in qvac.config.json" {
  local dir
  dir=$(mktemp -d)
  mkdir -p "${dir}/node_modules"
  printf '{"bareRuntimeVersion": "garbage"}' > "${dir}/qvac.config.json"
  run ${QVAC} verify bundle --addons-source "${dir}/node_modules" --host darwin-arm64 --project-root "${dir}"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" =~ "Invalid Bare runtime version" ]]
  [[ "${output}" =~ "garbage" ]]
  rm -rf "${dir}"
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

# ── Serve: translations validation ──────────────────────────────────

@test "translations: JSON content-type returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/translations" \
    -H "Content-Type: application/json" -d '{"model":"test"}')
  assert_error "${body}" "invalid_content_type"
}

@test "translations: missing file returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/translations" -F "model=test")
  assert_error "${body}" "missing_file"
}

@test "translations: missing model returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/translations" \
    -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "missing_model"
}

@test "translations: language field returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/translations" \
    -F "model=fake-transcribe" -F "language=es" -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "unsupported_param"
}

@test "translations: unsupported srt format returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/translations" \
    -F "model=fake-transcribe" -F "response_format=srt" -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "unsupported_response_format"
}

@test "translations: transcription-only model returns invalid_model_type" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/translations" \
    -F "model=fake-transcribe" -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "invalid_model_type"
}

@test "translations: unknown model returns 404" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/translations" \
    -F "model=nonexistent" -F "file=@/dev/null;filename=audio.wav")
  assert_error "${body}" "model_not_found"
}

# ── Serve: images generations validation (JSON) ───────────────────────

@test "images generations: missing model returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d '{"prompt":"a red square"}')
  assert_error "${body}" "missing_model"
}

@test "images generations: invalid response_format returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d '{"model":"x","prompt":"a red square","response_format":"png"}')
  assert_error "${body}" "invalid_response_format"
}

@test "images generations: unknown model returns 404" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d '{"model":"nonexistent","prompt":"a red square"}')
  assert_error "${body}" "model_not_found"
}

@test "images generations: response_format=url without publicBaseUrl returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d '{"model":"x","prompt":"a red square","response_format":"url"}')
  assert_error "${body}" "unsupported_response_format"
}

@test "images generations: output_format=jpeg returns 400 unsupported_output_format" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d '{"model":"x","prompt":"p","output_format":"jpeg"}')
  assert_error "${body}" "unsupported_output_format"
}

@test "images generations: output_compression returns 400 unsupported_output_compression" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d '{"model":"x","prompt":"p","output_compression":80}')
  assert_error "${body}" "unsupported_output_compression"
}

@test "images generations: background returns 400 unsupported_background" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d '{"model":"x","prompt":"p","background":"transparent"}')
  assert_error "${body}" "unsupported_background"
}

# ── Serve: images edits validation (multipart) ──────────────────────────

@test "images edits: JSON body returns 400 invalid_content_type" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/edits" \
    -H "Content-Type: application/json" \
    -d '{"model":"test","prompt":"hi"}')
  assert_error "${body}" "invalid_content_type"
}

@test "images edits: missing image returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/edits" \
    -F "model=test" -F "prompt=make it blue")
  assert_error "${body}" "missing_image"
}

@test "images edits: mask file returns 400 mask_not_supported" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/edits" \
    -F "image=@${FILE_TMPDIR}/tiny.png" \
    -F "mask=@${FILE_TMPDIR}/tiny.png" \
    -F "model=test" -F "prompt=hi")
  assert_error "${body}" "mask_not_supported"
}

@test "images edits: missing model returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/edits" \
    -F "image=@${FILE_TMPDIR}/tiny.png" -F "prompt=make it blue")
  assert_error "${body}" "missing_model"
}

@test "images edits: invalid response_format returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/edits" \
    -F "image=@${FILE_TMPDIR}/tiny.png" \
    -F "model=nonexistent" \
    -F "prompt=make it blue" \
    -F "response_format=png")
  assert_error "${body}" "invalid_response_format"
}

@test "images edits: response_format=url without publicBaseUrl returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/edits" \
    -F "image=@${FILE_TMPDIR}/tiny.png" \
    -F "model=x" -F "prompt=p" -F "response_format=url")
  assert_error "${body}" "unsupported_response_format"
}

@test "images edits: output_format=jpeg returns 400 unsupported_output_format" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/edits" \
    -F "image=@${FILE_TMPDIR}/tiny.png" \
    -F "model=x" -F "prompt=p" -F "output_format=jpeg")
  assert_error "${body}" "unsupported_output_format"
}

@test "images edits: background returns 400 unsupported_background" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/edits" \
    -F "image=@${FILE_TMPDIR}/tiny.png" \
    -F "model=x" -F "prompt=p" -F "background=transparent")
  assert_error "${body}" "unsupported_background"
}

@test "images edits: unknown model returns 404" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/edits" \
    -F "image=@${FILE_TMPDIR}/tiny.png" \
    -F "model=nonexistent" \
    -F "prompt=make it blue")
  assert_error "${body}" "model_not_found"
}

@test "images edits: stream=true is not rejected before model lookup (parity with /images/generations)" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/images/edits" \
    -F "image=@${FILE_TMPDIR}/tiny.png" \
    -F "model=nonexistent" \
    -F "prompt=p" -F "stream=true")
  assert_error "${body}" "model_not_found"
}

# ── Serve: images on the publicBaseUrl-enabled server (port 19923) ────

@test "images generations: response_format=url is ACCEPTED when publicBaseUrl is set (then 404 on unknown model)" {
  local body
  body=$(curl -s "http://127.0.0.1:19923/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d '{"model":"nonexistent","prompt":"p","response_format":"url"}')
  assert_error "${body}" "model_not_found"
}

# ── Serve: files content-download endpoint (no models needed) ────────

@test "GET /v1/files/:id/content returns 404 for unknown id" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/files/file-deadbeef/content")
  assert_error "${body}" "file_not_found"
}

@test "GET /v1/files/:id/content returns the bytes after a POST /v1/files upload" {
  local upload
  upload=$(curl -s "http://127.0.0.1:19920/v1/files" \
    -F "file=@${FILE_TMPDIR}/tiny.png" -F "purpose=image_generation")
  local id
  id=$(echo "${upload}" | jq -r '.id')
  [[ "${id}" =~ ^file- ]]

  local out="${FILE_TMPDIR}/dl-${RANDOM}.bin"
  local code
  code=$(curl -s -o "${out}" -w "%{http_code}" "http://127.0.0.1:19920/v1/files/${id}/content")
  [[ "${code}" == "200" ]]
  cmp -s "${out}" "${FILE_TMPDIR}/tiny.png"
}

@test "GET /v1/files/:id/content sets Cache-Control private with bounded max-age" {
  local upload
  upload=$(curl -s "http://127.0.0.1:19920/v1/files" \
    -F "file=@${FILE_TMPDIR}/tiny.png" -F "purpose=image_generation")
  local id
  id=$(echo "${upload}" | jq -r '.id')
  local headers
  headers=$(curl -s -D- -o /dev/null "http://127.0.0.1:19920/v1/files/${id}/content")
  [[ "${headers}" =~ [Cc]ache-[Cc]ontrol:\ private,\ max-age=([0-9]+) ]]
  local max_age=${BASH_REMATCH[1]}
  [[ "${max_age}" -gt 0 ]]
  [[ "${max_age}" -le 3600 ]]
}

# ── Serve: speech (text-to-speech) validation ─────────────────────────

@test "speech: invalid JSON returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" -d '{not valid json}')
  assert_error "${body}" "invalid_json"
}

@test "speech: missing model returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"input":"hello","voice":"alloy"}')
  assert_error "${body}" "missing_model"
}

@test "speech: missing input returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"model":"test","voice":"alloy"}')
  assert_error "${body}" "missing_input"
}

@test "speech: empty input returns 400" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"model":"test","voice":"alloy","input":"   "}')
  assert_error "${body}" "missing_input"
}

@test "speech: mp3 response_format returns 400 unsupported_response_format" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"model":"test","voice":"alloy","input":"hi","response_format":"mp3"}')
  assert_error "${body}" "unsupported_response_format"
}

@test "speech: opus response_format returns 400 unsupported_response_format" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"model":"test","voice":"alloy","input":"hi","response_format":"opus"}')
  assert_error "${body}" "unsupported_response_format"
}

@test "speech: aac response_format returns 400 unsupported_response_format" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"model":"test","voice":"alloy","input":"hi","response_format":"aac"}')
  assert_error "${body}" "unsupported_response_format"
}

@test "speech: flac response_format returns 400 unsupported_response_format" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"model":"test","voice":"alloy","input":"hi","response_format":"flac"}')
  assert_error "${body}" "unsupported_response_format"
}

@test "speech: unknown response_format returns 400 invalid_response_format" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"model":"test","voice":"alloy","input":"hi","response_format":"mp4"}')
  assert_error "${body}" "invalid_response_format"
}

@test "speech: input over default 4096-char cap returns 400 input_too_long" {
  # default server inherits the documented default cap (4096).
  local big body
  big=$(printf 'a%.0s' $(seq 1 4097))
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"test\",\"voice\":\"alloy\",\"input\":\"${big}\"}")
  assert_error "${body}" "input_too_long"
}

@test "speech: unknown model returns 404" {
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"model":"nonexistent","voice":"alloy","input":"hi"}')
  assert_error "${body}" "model_not_found"
}

@test "speech: defaults voice to alloy when omitted (still 404 model_not_found)" {
  # The default voice is "alloy"; with no models loaded the route must reach
  # alias resolution and return model_not_found, not missing_voice.
  local body
  body=$(curl -s "http://127.0.0.1:19920/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"model":"nonexistent","input":"hi"}')
  assert_error "${body}" "model_not_found"
}

@test "speech: auth required when api-key set" {
  local body
  body=$(curl -s "http://127.0.0.1:19921/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d '{"model":"test","voice":"alloy","input":"hi"}')
  assert_error "${body}" "invalid_api_key"
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
