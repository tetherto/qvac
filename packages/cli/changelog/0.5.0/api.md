# 🔌 API Changes v0.5.0

## Add POST /v1/audio/speech to qvac serve OpenAI adapter

PR: [#2009](https://github.com/tetherto/qvac/pull/2009)

```bash
cd packages/cli
npm install
npm run lint
npm run build
npm run test
npm run test:bats
```

```bash
# Start the server with a TTS model loaded
qvac serve openai

# Synthesize wav (default)
curl http://localhost:11434/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"my-tts","voice":"alloy","input":"QVAC SDK is the canonical entry point to QVAC."}' \
  --output speech.wav

# Synthesize raw pcm
curl http://localhost:11434/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"my-tts","voice":"alloy","input":"hello","response_format":"pcm"}' \
  --output speech.pcm
```

---

## Add /v1/vector_stores OpenAI endpoints to qvac serve

PR: [#2013](https://github.com/tetherto/qvac/pull/2013)

```bash
# 1. Create a vector store (synthetic; no workspace materialized yet)
curl http://localhost:11434/v1/vector_stores \
  -H "Content-Type: application/json" \
  -d '{ "name": "product-docs" }'

# 2. Upload a file (multipart, bytes kept in memory until attached)
curl http://localhost:11434/v1/files \
  -F "file=@./notes.txt;type=text/plain" \
  -F "purpose=assistants"

# 3. Attach the file to the store (runs ragIngest, drops the bytes)
curl http://localhost:11434/v1/vector_stores/vs_abc123/files \
  -H "Content-Type: application/json" \
  -d '{ "file_id": "file-abc..." }'

# 4. Search the store
curl http://localhost:11434/v1/vector_stores/vs_abc123/search \
  -H "Content-Type: application/json" \
  -d '{ "query": "How do I configure preload?", "max_num_results": 5 }'
```

```bash
mkdir -p ~/.qvac-vector-stores-local-test
# paste each attachment into ~/.qvac-vector-stores-local-test/<filename>
chmod +x ~/.qvac-vector-stores-local-test/run-server.sh ~/.qvac-vector-stores-local-test/test-scenarios.sh
cd packages/cli && npm install && npm run build
cd ~/.qvac-vector-stores-local-test
./run-server.sh
# second terminal:
./test-scenarios.sh
```

```json
{
  "serve": {
    "models": {
      "my-llm": {
        "model": "QWEN3_600M_INST_Q4",
        "default": true,
        "preload": true,
        "config": { "ctx_size": 4096, "tools": false }
      },
      "my-embed": {
        "model": "GTE_LARGE_FP16",
        "default": true,
        "preload": true
      }
    }
  }
}
```

```json
{
  "serve": {
    "models": {
      "my-llm": {
        "model": "QWEN3_600M_INST_Q4",
        "default": true,
        "preload": true,
        "config": { "ctx_size": 4096, "tools": false }
      }
    }
  }
}
```

```bash
#!/usr/bin/env bash
# Start qvac serve openai with this directory's config. Logs stay in this terminal.
# Expects a built CLI at $QVAC_REPO/packages/cli/dist/index.js.
#
# Env: QVAC_REPO, CFG (default ./qvac.config.json), PORT (default 11437).
# No-embed smoke: CFG="$HERE/qvac.config.no-embed.json" PORT=11438 ./run-server.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${QVAC_REPO:-$HOME/qvac}"
CLI="$REPO/packages/cli/dist/index.js"
CFG="${CFG:-$HERE/qvac.config.json}"
PORT="${PORT:-11437}"

if [[ ! -f "$CLI" ]]; then
  echo "CLI build missing at $CLI" >&2
  echo "Run: (cd $REPO/packages/cli && npm install && npm run build)" >&2
  exit 1
fi

cd "$HERE"
exec node "$CLI" serve openai -H 127.0.0.1 -p "$PORT" -v -c "$CFG" "$@"
```

```bash
#!/usr/bin/env bash
# Vector store API checks against a server you started with ./run-server.sh (other terminal).
#
# Usage:
#   ./test-scenarios.sh                    # full flow incl. POST /v1/files + attach + search hit proof (needs jq)
#   ./test-scenarios.sh no_embed           # sad path; use no-embed server (BASE_URL=http://127.0.0.1:11438)
#
# Env: BASE_URL, SKIP_INGEST=1 (skip file upload + attach + hit proof; API-only pass)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${BASE_URL:-http://127.0.0.1:11437}"
cd "$HERE"

wait_models() {
  local root=$1
  local i=0
  local code=000
  while [[ $i -lt 45 ]]; do
    i=$((i + 1))
    code=$(curl -sS -o /dev/null -w "%{http_code}" "$root/v1/models" || echo 000)
    if [[ "$code" == "200" ]]; then
      echo "server ready ($i)"
      return 0
    fi
    sleep 1
  done
  echo "server not ready at $root" >&2
  exit 1
}

assert_search_hits() {
  local path=$1
  echo "== assert: search returned at least one text hit =="
  jq -e '
    .object == "vector_store.search_results.page"
    and (.data | type == "array")
    and (.data | length) > 0
    and any(
      .data[];
      (.content // []) | map(select(.type == "text") | .text // "") | join(" ")
        | test("planets|moons|OpenAI|vector stores"; "i")
    )
  ' "$path" >/dev/null
}

if [[ "${1:-}" == "no_embed" ]]; then
  BASE="${BASE_URL:-http://127.0.0.1:11438}"
  wait_models "$BASE"
  echo "== sad: search with no embedding model =="
  curl -sS -o /tmp/qvac-sad3.txt -w "HTTP %{http_code}\n" \
    -X POST "$BASE/v1/vector_stores/vs_dummy/search" \
    -H "Content-Type: application/json" \
    -d '{"query":"x"}'
  cat /tmp/qvac-sad3.txt
  echo ""
  exit 0
fi

wait_models "$BASE"

if [[ "${SKIP_INGEST:-}" != "1" ]] && ! command -v jq >/dev/null 2>&1; then
  echo "jq is required unless SKIP_INGEST=1." >&2
  exit 1
fi

echo "== GET /v1/vector_stores =="
curl -sS "$BASE/v1/vector_stores"; echo ""

echo "== POST /v1/vector_stores =="
curl -sS -o /tmp/qvac-vs-create.json -w "HTTP %{http_code}\n" \
  -X POST "$BASE/v1/vector_stores" \
  -H "Content-Type: application/json" \
  -d '{"name":"smoke","metadata":{"by":"test-scenarios.sh"}}'
VS_ID=$(jq -r .id /tmp/qvac-vs-create.json)
export VS_ID
echo "VS_ID=$VS_ID"

echo "== GET /v1/vector_stores/{id} =="
curl -sS "$BASE/v1/vector_stores/$VS_ID"; echo ""

echo "== POST search before ingest (expect 200, often zero hits) =="
curl -sS -o /tmp/qvac-search-empty.json -w "HTTP %{http_code}\n" \
  -X POST "$BASE/v1/vector_stores/$VS_ID/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"planets","max_num_results":3}'
[[ "${SKIP_INGEST:-}" != "1" ]] && jq '{object, hit_count: (.data | length)}' /tmp/qvac-search-empty.json || cat /tmp/qvac-search-empty.json
echo ""

if [[ "${SKIP_INGEST:-}" != "1" ]]; then
  DOC_PATH=/tmp/qvac-vs-doc.txt
  printf 'Local smoke document about planets, moons and the solar system.\nAnother note about OpenAI vector stores and RAG.\n' > "$DOC_PATH"

  echo "== POST /v1/files =="
  curl -sS -o /tmp/qvac-file-create.json -w "HTTP %{http_code}\n" \
    -X POST "$BASE/v1/files" \
    -F "file=@$DOC_PATH;type=text/plain" \
    -F "purpose=assistants"
  jq '{object, id, bytes, purpose, status}' /tmp/qvac-file-create.json
  FILE_ID=$(jq -r '.id' /tmp/qvac-file-create.json)
  echo "FILE_ID=$FILE_ID"

  echo "== GET /v1/files =="
  curl -sS -o /tmp/qvac-files-list.json "$BASE/v1/files"
  jq -e --arg id "$FILE_ID" '.object == "list" and any(.data[]; .id == $id)' /tmp/qvac-files-list.json >/dev/null
  jq '{object, count: (.data | length)}' /tmp/qvac-files-list.json

  echo "== GET /v1/files/$FILE_ID =="
  curl -sS -o /tmp/qvac-file-get.json -w "HTTP %{http_code}\n" "$BASE/v1/files/$FILE_ID"
  jq '{object, id, bytes, purpose, status}' /tmp/qvac-file-get.json

  echo "== POST /v1/vector_stores/$VS_ID/files (attach + ingest) =="
  curl -sS -o /tmp/qvac-vs-attach.json -w "HTTP %{http_code}\n" \
    -X POST "$BASE/v1/vector_stores/$VS_ID/files" \
    -H "Content-Type: application/json" \
    -d "{\"file_id\":\"$FILE_ID\"}"
  jq -e '
    .object == "vector_store.file"
    and .status == "completed"
    and .vector_store_id == env.VS_ID
    and (.usage_bytes | type == "number")
  ' /tmp/qvac-vs-attach.json >/dev/null
  echo "PASS attach ($(jq -c '{id, vector_store_id, usage_bytes}' /tmp/qvac-vs-attach.json))"

  echo "== GET /v1/files/$FILE_ID after attach (expect 404 file_not_found) =="
  curl -sS -o /tmp/qvac-file-get-after.json -w "HTTP %{http_code}\n" "$BASE/v1/files/$FILE_ID"
  jq -e '.error.code == "file_not_found"' /tmp/qvac-file-get-after.json >/dev/null

  echo "== POST search after ingest =="
  curl -sS -o /tmp/qvac-search-hits.json -w "HTTP %{http_code}\n" \
    -X POST "$BASE/v1/vector_stores/$VS_ID/search" \
    -H "Content-Type: application/json" \
    -d '{"query":"planets and solar system","max_num_results":5}'
  assert_search_hits /tmp/qvac-search-hits.json
  echo "PASS search ($(jq -c '{hit_count: (.data | length), first_preview: (.data[0].content[0].text // "" | .[0:120])}' /tmp/qvac-search-hits.json))"

  echo "== sad: attach unknown file_id =="
  curl -sS -o /tmp/qvac-attach-bad.json -w "HTTP %{http_code}\n" \
    -X POST "$BASE/v1/vector_stores/$VS_ID/files" \
    -H "Content-Type: application/json" \
    -d '{"file_id":"file-doesnotexist"}'
  jq -e '.error.code == "file_not_found"' /tmp/qvac-attach-bad.json >/dev/null

  echo "== sad: attach missing file_id =="
  curl -sS -o /tmp/qvac-attach-empty.json -w "HTTP %{http_code}\n" \
    -X POST "$BASE/v1/vector_stores/$VS_ID/files" \
    -H "Content-Type: application/json" \
    -d '{}'
  jq -e '.error.code == "missing_file_id"' /tmp/qvac-attach-empty.json >/dev/null
fi

echo "== sad: invalid id =="
curl -sS -o /tmp/qvac-sad1.txt -w "HTTP %{http_code}\n" "$BASE/v1/vector_stores/bad%2Fid"
cat /tmp/qvac-sad1.txt; echo ""

echo "== sad: search missing query =="
curl -sS -o /tmp/qvac-sad2.txt -w "HTTP %{http_code}\n" \
  -X POST "$BASE/v1/vector_stores/$VS_ID/search" \
  -H "Content-Type: application/json" \
  -d '{}'
cat /tmp/qvac-sad2.txt; echo ""

echo "== DELETE /v1/vector_stores/{id} =="
curl -sS -X DELETE "$BASE/v1/vector_stores/$VS_ID"; echo ""

echo "Main scenarios finished OK."
echo "No-embed check: CFG=$HERE/qvac.config.no-embed.json PORT=11438 ./run-server.sh"
echo "then: BASE_URL=http://127.0.0.1:11438 ./test-scenarios.sh no_embed"
```

---

## Add OpenAI-compatible POST /v1/completions (legacy)

PR: [#2027](https://github.com/tetherto/qvac/pull/2027)

```bash
# blocking
curl http://localhost:11434/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-llm",
    "prompt": "Say hello in one word.",
    "max_tokens": 16
  }'

# streaming (single prompt only)
curl -N http://localhost:11434/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-llm",
    "prompt": "Say hello in one word.",
    "stream": true
  }'

# multi-prompt (blocking only; stream:true returns 400)
curl http://localhost:11434/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-llm",
    "prompt": ["Reply with alpha.", "Reply with beta."],
    "max_tokens": 8
  }'
```

```json
{
  "id": "cmpl-…",
  "object": "text_completion",
  "created": 1718000000,
  "model": "my-llm",
  "choices": [
    { "text": "…", "index": 0, "logprobs": null, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 1, "total_tokens": 1 }
}
```

---

## Add openai responses routes with in-memory store

PR: [#2030](https://github.com/tetherto/qvac/pull/2030)

```bash
# Blocking create
curl -sS "$BASE/v1/responses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","input":"ping","store":true}'

# Streaming
curl -sN "$BASE/v1/responses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","input":"ping","stream":true,"store":true}'

# Chained follow-up (after capturing response id from prior call)
curl -sS "$BASE/v1/responses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL"'","input":"and now?","previous_response_id":"resp_..."}'
```

---

## Add POST /v1/audio/translations to qvac serve OpenAI adapter

PR: [#2031](https://github.com/tetherto/qvac/pull/2031)

```json
"whisper-translate": {
  "model": "WHISPER_EN_TINY_Q8_0",
  "type": "whispercpp-audio-translation",
  "preload": true
}
```

```bash
curl -s http://127.0.0.1:11434/v1/audio/translations \
  -F model=whisper-translate \
  -F file=@./sample.wav \
  -F response_format=json
# => { "text": "..." }   (always English)
```

```json
{
  "serve": {
    "models": {
      "whisper-transcribe": { "model": "WHISPER_EN_TINY_Q8_0", "preload": true },
      "whisper-translate": {
        "model": "WHISPER_EN_TINY_Q8_0",
        "type": "whispercpp-audio-translation",
        "preload": true
      }
    }
  }
}
```

---

## Add POST /v1/images/edits to OpenAI adapter

PR: [#2032](https://github.com/tetherto/qvac/pull/2032)

```json
// old: response_format=url, no --public-base-url configured
{
  "created": 1718000000,
  "data": [
    { "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..." }
  ]
}
```

```json
// new (option A): response_format=url, no --public-base-url -> 400
{
  "error": {
    "code": "unsupported_response_format",
    "message": "response_format=\"url\" requires the server to be started with --public-base-url ..."
  }
}

// new (option B): response_format=url, server started with --public-base-url
{
  "created": 1718000000,
  "output_format": "png",
  "data": [
    {
      "url": "https://api.example.com/v1/files/file-abcd.../content",
      "expires_at": 1718003600
    }
  ]
}
```

```bash
# img2img against a loaded diffusion model
curl http://localhost:11434/v1/images/edits \
  -F "image=@input.png" \
  -F "model=my-diffusion" \
  -F "prompt=oil painting, warm light" \
  -F "strength=0.65"
```

```json
{
  "created": 1718000000,
  "output_format": "png",
  "size": "1024x1024",
  "data": [{ "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." }]
}
```

```json
{
  "created": 1718000000,
  "output_format": "png",
  "data": [
    {
      "url": "https://api.example.com/v1/files/file-abcd…/content",
      "expires_at": 1718003600
    }
  ]
}
```

---

