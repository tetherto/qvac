# 🔌 API Changes v0.4.0

## Add qvac verify deps to detect native addon lockfile changes

PR: [#1969](https://github.com/tetherto/qvac/pull/1969)

```
# Local fork checkout
qvac verify deps --base upstream/main --head HEAD

# Direct clone where origin points at the canonical repo
qvac verify deps --base origin/main --head HEAD

# Package with a nested npm lockfile
qvac verify deps --base upstream/main --head HEAD \
  --lockfile packages/sdk/package-lock.json

# CI guardrail: stay quiet when there are no native changes
qvac verify deps --base origin/main --head HEAD --quiet
```

---

## Add Qwen3.5, Gemma4 tool-call dialects and reasoning_budget param

PR: [#1974](https://github.com/tetherto/qvac/pull/1974)

```ts
import { loadModel, completion } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: "/models/Qwen3.5-7B-Instruct-Q4_K_M.gguf",
  modelType: "llm",
  modelConfig: { ctx_size: 4096, tools: true },
});

const run = completion({
  modelId,
  history: [{ role: "user", content: "What's the weather in Paris?" }],
  tools: [weatherTool],
  // toolDialect: "qwen35" — auto-detected; override only if needed
});
```

```ts
const modelId = await loadModel({
  modelSrc: "/models/gemma-4-9b-it-Q4_K_M.gguf",
  modelType: "llm",
  modelConfig: { ctx_size: 4096, tools: true },
});

const run = completion({
  modelId,
  history: [{ role: "user", content: "What's the weather in Paris?" }],
  tools: [weatherTool],
  // toolDialect: "gemma4" — auto-detected; override only if needed
});
```

```ts
// -1 = unrestricted thinking, 0 = disabled
const modelId = await loadModel({
  modelSrc: "/models/Qwen3.5-7B-Instruct-Q4_K_M.gguf",
  modelType: "llm",
  modelConfig: { ctx_size: 4096, reasoning_budget: -1 },
});

const run = completion({
  modelId,
  history: [{ role: "user", content: "Think step by step." }],
  generationParams: { reasoning_budget: 0 }, // override per-request
});
```

---

## Add qvac verify bundle command for prebuild and ABI verification

PR: [#1984](https://github.com/tetherto/qvac/pull/1984)

```bash
qvac verify bundle --addons-source qvac/worker.bundle.js \
  --host ios-arm64 \
  --host ios-arm64-simulator \
  --host ios-x64-simulator \
  --host android-arm64

qvac verify bundle --addons-source ./node_modules \
  --host darwin-arm64 \
  --host linux-x64 \
  --host win32-x64

qvac verify bundle --addons-source qvac/worker.bundle.js \
  --host ios-arm64 \
  --bare-runtime-version 1.26.0

# Or pin via qvac.config.json (auto-detected; committed with the project)
# { "bareRuntimeVersion": "1.26.0" }
qvac verify bundle --addons-source qvac/worker.bundle.js --host ios-arm64
```

---

## Add POST /v1/images/generations to qvac serve OpenAI adapter

PR: [#2008](https://github.com/tetherto/qvac/pull/2008)

```json
{
  "created": 1718000000,
  "output_format": "png",
  "size": "1024x1024",
  "data": [
    { "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..." }
  ]
}
```

```
event: image_generation.completed
data: {"type":"image_generation.completed","created_at":1718000000,"output_format":"png","size":"1024x1024","b64_json":"iVBORw0KGgoAAAANSUhEUgAA..."}

data: [DONE]

```

```bash
mkdir -p tmp/serve-images
# paste each attachment into tmp/serve-images/<filename>
chmod +x tmp/serve-images/run-server.sh tmp/serve-images/test-scenarios.sh
cd packages/cli && npm install && npm run build
cd ../../tmp/serve-images
./run-server.sh
# second terminal, same cwd:
./test-scenarios.sh
```

```json
{
  "serve": {
    "models": {
      "sd21": {
        "model": "SD_V2_1_1B_Q4_0",
        "default": true,
        "preload": true,
        "config": { "prediction": "v" }
      }
    }
  }
}
```

```bash
#!/usr/bin/env bash
# Start the qvac OpenAI-compatible server pointed at this dir's qvac.config.json.
# First boot will download SD_V2_1_1B_Q4_0 (~2.18 GB).
# Expects this directory to live at <repo>/tmp/serve-images (repo root = HERE/../..).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CLI="$REPO/packages/cli/dist/index.js"

if [[ ! -f "$CLI" ]]; then
  echo "CLI build missing at $CLI"
  echo "Run: (cd $REPO/packages/cli && npm install && npm run build)"
  exit 1
fi

cd "$HERE"
exec node "$CLI" serve openai -v --config "$HERE/qvac.config.json" "$@"
```

```bash
#!/usr/bin/env bash
# End-to-end test scenarios for POST /v1/images/generations.
# Assumes `./run-server.sh` is up in another terminal and `sd21` is loaded.
#
# Usage:
#   ./test-scenarios.sh                # run all
#   ./test-scenarios.sh happy_b64      # run a single named scenario
#   BASE_URL=http://1.2.3.4:11434 ./test-scenarios.sh
set -euo pipefail

BASE="${BASE_URL:-http://127.0.0.1:11434}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"
mkdir -p "$OUT"

PASS=0
FAIL=0
FAILED_NAMES=()

# ── helpers ────────────────────────────────────────────────────────────────
post_json() {
  # post_json <name> <body-json>
  local name=$1
  local body=$2
  curl -sS -o "$OUT/$name.body.json" -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -X POST "$BASE/v1/images/generations" \
    -d "$body"
}

post_sse() {
  # post_sse <name> <body-json>
  # captures the raw SSE body to <name>.sse and the HTTP status code in stdout.
  local name=$1
  local body=$2
  curl -sS -N -o "$OUT/$name.sse" -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -X POST "$BASE/v1/images/generations" \
    -d "$body"
}

assert_status() {
  # assert_status <name> <expected> <actual>
  local name=$1 expected=$2 actual=$3
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ status $actual"
  else
    echo "  ✗ status $actual (expected $expected)"
    echo "  body:"; sed -e 's/^/    /' < "$OUT/$name.body.json" | head -20
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); return 1
  fi
}

assert_body() {
  # assert_body <name> <jq-expr> <expected-substring|"non-empty">
  local name=$1 expr=$2 expected=$3
  local got
  got=$(jq -r "$expr" < "$OUT/$name.body.json" 2>/dev/null || echo "")
  if [[ "$expected" == "non-empty" ]]; then
    if [[ -n "$got" && "$got" != "null" ]]; then
      echo "  ✓ $expr is non-empty (${#got} chars)"
    else
      echo "  ✗ $expr is empty/null"
      FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); return 1
    fi
  else
    if [[ "$got" == *"$expected"* ]]; then
      echo "  ✓ $expr matched ($got)"
    else
      echo "  ✗ $expr was '$got' (expected substring '$expected')"
      FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); return 1
    fi
  fi
}

decode_b64_png() {
  # decode_b64_png <name> <jq-expr>
  local name=$1 expr=$2
  jq -r "$expr" < "$OUT/$name.body.json" | base64 -d > "$OUT/$name.png"
  local magic
  magic=$(head -c 8 "$OUT/$name.png" | xxd -p)
  if [[ "$magic" == "89504e470d0a1a0a" ]]; then
    echo "  ✓ wrote $OUT/$name.png ($(wc -c < "$OUT/$name.png") bytes, PNG magic OK)"
  else
    echo "  ✗ $OUT/$name.png does not start with PNG magic (got $magic)"
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); return 1
  fi
}

run() {
  # run <name> <fn>
  local name=$1 fn=$2
  if [[ $# -ge 3 && "$3" != "$name" ]]; then
    return 0
  fi
  echo
  echo "── $name ──────────────────────────────────────────────"
  if "$fn" "$name"; then
    PASS=$((PASS+1))
    echo "  PASS"
  fi
}

# ── scenarios ──────────────────────────────────────────────────────────────

# 1. Happy path: defaults (b64_json), single image; response echoes output_format and size.
happy_b64() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21","prompt":"a tiny watercolor robot, studio lighting, sharp focus","steps":8}')
  assert_status "$name" 200 "$code" || return 1
  assert_body "$name" '.created' "non-empty" || return 1
  assert_body "$name" '.output_format' "png" || return 1
  assert_body "$name" '.data | length' "1" || return 1
  decode_b64_png "$name" '.data[0].b64_json' || return 1
}

# 2. Happy path: response_format=url returns data:image/png;base64,...
happy_url() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21","prompt":"a teal cube on a black background","response_format":"url","steps":8}')
  assert_status "$name" 200 "$code" || return 1
  assert_body "$name" '.output_format' "png" || return 1
  assert_body "$name" '.data[0].url' "data:image/png;base64," || return 1
}

# 3. Happy path: explicit size (multiple of 8) is honored and echoed in response.
happy_size_512() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21","prompt":"a tiny pixel-art mountain","size":"512x512","steps":8}')
  assert_status "$name" 200 "$code" || return 1
  assert_body "$name" '.size' "512x512" || return 1
  decode_b64_png "$name" '.data[0].b64_json' || return 1
  local sz; sz=$(wc -c < "$OUT/$name.png")
  if (( sz > 1000 )); then echo "  ✓ png is $sz bytes"; else echo "  ✗ png too small: $sz"; FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); return 1; fi
}

# 4. Happy path: deterministic seed ⇒ same bytes across runs.
deterministic_seed() {
  local name=$1
  local body='{"model":"sd21","prompt":"a single red apple","seed":12345,"size":"256x256","steps":8}'
  local c1; c1=$(post_json "$name" "$body"); assert_status "$name" 200 "$c1" || return 1
  decode_b64_png "$name" '.data[0].b64_json' || return 1
  cp "$OUT/$name.png" "$OUT/$name.first.png"
  local c2; c2=$(post_json "$name" "$body"); assert_status "$name" 200 "$c2" || return 1
  decode_b64_png "$name" '.data[0].b64_json' || return 1
  if cmp -s "$OUT/$name.first.png" "$OUT/$name.png"; then
    echo "  ✓ identical bytes between two seeded runs"
  else
    echo "  ✗ seeded runs produced different bytes (sd.cpp may be nondeterministic on your GPU; not necessarily a regression)"
    # don't FAIL — flag only
  fi
}

# 5. Happy path: n is forwarded as-is (no clamp). Use n=2 to keep VRAM modest.
batch_unbounded() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21","prompt":"a small green ball","n":2,"size":"256x256","steps":4}')
  assert_status "$name" 200 "$code" || return 1
  assert_body "$name" '.data | length' "2" || return 1
}

# 6. Happy path: stream=true returns SSE with one image_generation.completed event.
stream_sse() {
  local name=$1
  local code; code=$(post_sse "$name" '{"model":"sd21","prompt":"a single olive","stream":true,"size":"256x256","steps":4}')
  if [[ "$code" != "200" ]]; then
    echo "  ✗ status $code (expected 200)"
    sed -e 's/^/    /' < "$OUT/$name.sse" | head -20
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); return 1
  fi
  echo "  ✓ status 200"
  if grep -q '^data: {"type":"image_generation\.completed"' "$OUT/$name.sse"; then
    echo "  ✓ SSE contains image_generation.completed event"
  else
    echo "  ✗ SSE missing image_generation.completed event"
    sed -e 's/^/    /' < "$OUT/$name.sse" | head -20
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); return 1
  fi
  if grep -q '^data: \[DONE\]' "$OUT/$name.sse"; then
    echo "  ✓ SSE terminates with [DONE]"
  else
    echo "  ✗ SSE missing [DONE] terminator"
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); return 1
  fi
  # Decode the b64 payload of the first completed event and check PNG magic.
  local b64
  b64=$(grep -m1 '^data: {"type":"image_generation\.completed"' "$OUT/$name.sse" \
        | sed -e 's/^data: //' \
        | jq -r '.b64_json')
  echo -n "$b64" | base64 -d > "$OUT/$name.png"
  local magic; magic=$(head -c 8 "$OUT/$name.png" | xxd -p)
  if [[ "$magic" == "89504e470d0a1a0a" ]]; then
    echo "  ✓ event payload decodes to valid PNG ($(wc -c < "$OUT/$name.png") bytes)"
  else
    echo "  ✗ event payload is not a PNG (magic $magic)"
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); return 1
  fi
}

# 7. Sad path: missing prompt ⇒ 400 missing_prompt.
sad_missing_prompt() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21"}')
  assert_status "$name" 400 "$code" || return 1
  assert_body "$name" '.error.code' "missing_prompt" || return 1
}

# 8. Sad path: missing model ⇒ 400 missing_model.
sad_missing_model() {
  local name=$1
  local code; code=$(post_json "$name" '{"prompt":"hi"}')
  assert_status "$name" 400 "$code" || return 1
  assert_body "$name" '.error.code' "missing_model" || return 1
}

# 9. Sad path: unknown model ⇒ 404 model_not_found.
sad_unknown_model() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"does-not-exist","prompt":"hi"}')
  assert_status "$name" 404 "$code" || return 1
  assert_body "$name" '.error.code' "model_not_found" || return 1
}

# 10. Sad path: size dimensions not multiples of 8 ⇒ 400 invalid_size.
sad_bad_size_multiple() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21","prompt":"x","size":"1023x1024"}')
  assert_status "$name" 400 "$code" || return 1
  assert_body "$name" '.error.code' "invalid_size" || return 1
  assert_body "$name" '.error.message' "multiples of 8" || return 1
}

# 11. Sad path: malformed size string ⇒ 400 invalid_size.
sad_bad_size_format() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21","prompt":"x","size":"big"}')
  assert_status "$name" 400 "$code" || return 1
  assert_body "$name" '.error.code' "invalid_size" || return 1
}

# 12. Sad path: invalid response_format ⇒ 400 invalid_response_format.
sad_bad_response_format() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21","prompt":"x","response_format":"jpeg"}')
  assert_status "$name" 400 "$code" || return 1
  assert_body "$name" '.error.code' "invalid_response_format" || return 1
}

# 13. Sad path: n=0 ⇒ 400 invalid_n (n must be a positive integer; no upper bound).
sad_invalid_n_zero() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21","prompt":"x","n":0}')
  assert_status "$name" 400 "$code" || return 1
  assert_body "$name" '.error.code' "invalid_n" || return 1
}

# 14. Sad path: non-integer n ⇒ 400 invalid_n.
sad_invalid_n_float() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21","prompt":"x","n":1.5}')
  assert_status "$name" 400 "$code" || return 1
  assert_body "$name" '.error.code' "invalid_n" || return 1
}

# 15. Sad path: malformed JSON body ⇒ 400 invalid_json.
sad_bad_json() {
  local name=$1
  local code
  code=$(curl -sS -o "$OUT/$name.body.json" -w "%{http_code}" \
    -H "Content-Type: application/json" \
    -X POST "$BASE/v1/images/generations" \
    --data-raw '{not-json')
  assert_status "$name" 400 "$code" || return 1
  assert_body "$name" '.error.code' "invalid_json" || return 1
}

# 16. Caveat path: output_format=jpeg is accepted; body is still PNG and the
#     response echoes output_format: "png" so the client can detect mismatch.
caveat_output_format_jpeg() {
  local name=$1
  local code; code=$(post_json "$name" '{"model":"sd21","prompt":"a single olive","output_format":"jpeg","size":"256x256","steps":4}')
  assert_status "$name" 200 "$code" || return 1
  assert_body "$name" '.output_format' "png" || return 1
  decode_b64_png "$name" '.data[0].b64_json' || return 1
  echo "  ℹ check server log for: 'output_format=jpeg is not supported; returning PNG.'"
}

# 17. Sanity: model is loaded and reports as image category.
sanity_models_list() {
  local name=$1
  local code; code=$(curl -sS -o "$OUT/$name.body.json" -w "%{http_code}" "$BASE/v1/models")
  assert_status "$name" 200 "$code" || return 1
  assert_body "$name" '[.data[].id] | tostring' "sd21" || return 1
}

# ── runner ─────────────────────────────────────────────────────────────────
ALL=(
  sanity_models_list
  happy_b64
  happy_url
  happy_size_512
  deterministic_seed
  batch_unbounded
  stream_sse
  sad_missing_prompt
  sad_missing_model
  sad_unknown_model
  sad_bad_size_multiple
  sad_bad_size_format
  sad_bad_response_format
  sad_invalid_n_zero
  sad_invalid_n_float
  sad_bad_json
  caveat_output_format_jpeg
)

FILTER="${1:-}"
for name in "${ALL[@]}"; do
  if [[ -n "$FILTER" && "$FILTER" != "$name" ]]; then
    continue
  fi
  run "$name" "$name"
done

echo
echo "════════════════════════════════════════"
echo "  passed: $PASS"
echo "  failed: $FAIL"
if (( FAIL > 0 )); then
  echo "  failed names: ${FAILED_NAMES[*]}"
  exit 1
fi
```

---

