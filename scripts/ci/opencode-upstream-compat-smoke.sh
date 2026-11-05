#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
VERIFY_RUN_OUTPUT="$SCRIPT_DIR/verify-opencode-run-output.cjs"
REPORT_PROMPT_SURFACE="$SCRIPT_DIR/report-opencode-prompt-surface.cjs"

SMOKE_DIR="${SMOKE_DIR:-$(mktemp -d)}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$(mktemp -d)}"
QVAC_MODEL="${QVAC_MODEL:-qwen3.5-0.8b}"
OPENCODE_TIMEOUT="${OPENCODE_TIMEOUT:-45m}"
QVAC_HOST_LOG="${QVAC_HOST_LOG:-}"

mkdir -p "$SMOKE_DIR" "$ARTIFACT_DIR"
SMOKE_DIR="$(cd "$SMOKE_DIR" && pwd -P)"
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd -P)"
if [[ -z "$QVAC_HOST_LOG" ]]; then
  QVAC_HOST_LOG="$ARTIFACT_DIR/qvac-host.log"
fi
export QVAC_HOST_LOG
cd "$SMOKE_DIR"

npm init -y > /dev/null
printf '%s\n' \
  'registry=https://registry.npmjs.org/' \
  '@qvac:registry=https://registry.npmjs.org/' \
  'foreground-scripts=true' \
  > .npmrc

npm install --no-fund --no-audit \
  opencode-ai@latest \
  @qvac/opencode-plugin@latest

npm ls --json \
  opencode-ai \
  @qvac/opencode-plugin \
  @qvac/ai-sdk-provider \
  @qvac/cli \
  @qvac/sdk \
  ai \
  @ai-sdk/openai-compatible \
  > "$ARTIFACT_DIR/npm-ls.json" || true

node - > "$ARTIFACT_DIR/package-versions.json" <<'NODE'
const { existsSync, readFileSync } = require('node:fs')
const { dirname, join, parse } = require('node:path')
const { createRequire } = require('node:module')

const requireFromProject = createRequire(`${process.cwd()}/package.json`)
const names = [
  'opencode-ai',
  '@qvac/opencode-plugin',
  '@qvac/ai-sdk-provider',
  '@qvac/cli',
  '@qvac/sdk',
  'ai',
  '@ai-sdk/openai-compatible'
]

function packageJsonFor(name) {
  try {
    return requireFromProject(`${name}/package.json`)
  } catch {
    // Some QVAC packages do not export package.json.
  }

  let dir = dirname(requireFromProject.resolve(name))
  const root = parse(dir).root
  while (dir !== root) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      if (parsed.name === name) return parsed
    }
    dir = dirname(dir)
  }
  throw new Error(`could not find package.json for ${name}`)
}

const versions = {}
for (const name of names) {
  try {
    versions[name] = packageJsonFor(name).version
  } catch (err) {
    versions[name] = `unresolved: ${err instanceof Error ? err.message : String(err)}`
  }
}
console.log(JSON.stringify(versions, null, 2))
NODE

{
  echo "## Package versions"
  echo
  echo '```json'
  cat "$ARTIFACT_DIR/package-versions.json"
  echo '```'
} | tee "$ARTIFACT_DIR/versions.md" > /dev/null

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$ARTIFACT_DIR/versions.md" >> "$GITHUB_STEP_SUMMARY"
fi

QVAC_REAL_BIN="$SMOKE_DIR/node_modules/.bin/qvac"
if [[ ! -x "$QVAC_REAL_BIN" ]]; then
  echo "QVAC CLI not installed at $QVAC_REAL_BIN; @qvac/opencode-plugin should bring @qvac/cli" >&2
  exit 1
fi

# The managed runner swallows serve output, so wrap the binary to tee it to
# disk. `exec` keeps the PID and the ready fd. Plugins without `serveBinPath`
# ignore it and run the serve unwrapped.
QVAC_SERVE_WRAPPER="$SMOKE_DIR/qvac-serve-wrapper.sh"
cat > "$QVAC_SERVE_WRAPPER" <<WRAPPER
#!/usr/bin/env bash
exec "$QVAC_REAL_BIN" "\$@" \
  > >(tee -a "$ARTIFACT_DIR/qvac-serve.stdout") \
  2> >(tee -a "$ARTIFACT_DIR/qvac-serve.stderr" >&2)
WRAPPER
chmod +x "$QVAC_SERVE_WRAPPER"

echo "QVAC CLI version:" | tee "$ARTIFACT_DIR/qvac-version.txt"
if ! "$QVAC_REAL_BIN" --version | tee -a "$ARTIFACT_DIR/qvac-version.txt"; then
  echo "Unable to read QVAC CLI version from $QVAC_REAL_BIN" | tee -a "$ARTIFACT_DIR/qvac-version.txt"
fi

cat > opencode.json <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@qvac/opencode-plugin",
      {
        "model": "${QVAC_MODEL}",
        "ctxSize": 32768,
        "reasoningBudget": 0,
        "tools": true,
        "serveBinPath": "${QVAC_SERVE_WRAPPER}"
      }
    ]
  ]
}
JSON
cp opencode.json "$ARTIFACT_DIR/opencode.json"

echo "OpenCode CLI version:" | tee "$ARTIFACT_DIR/opencode-version.txt"
npx opencode --version | tee -a "$ARTIFACT_DIR/opencode-version.txt"

if [[ "${SKIP_OPENCODE_RUN:-0}" == "1" ]]; then
  {
    echo
    echo "## Smoke result"
    echo
    echo "Skipped OpenCode run because \`SKIP_OPENCODE_RUN=1\`."
  } | tee "$ARTIFACT_DIR/smoke-skipped.md" > /dev/null
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    cat "$ARTIFACT_DIR/smoke-skipped.md" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

run_opencode=(
  npx opencode run
  --print-logs
  --log-level DEBUG
  --model "qvac/${QVAC_MODEL}"
  --format json
  "Reply with only the word qvac-ok."
)

run_status=0
if command -v timeout > /dev/null 2>&1; then
  timeout "$OPENCODE_TIMEOUT" "${run_opencode[@]}" \
    > "$ARTIFACT_DIR/opencode-run.jsonl" \
    2> "$ARTIFACT_DIR/opencode-run.stderr" || run_status=$?
else
  "${run_opencode[@]}" \
    > "$ARTIFACT_DIR/opencode-run.jsonl" \
    2> "$ARTIFACT_DIR/opencode-run.stderr" || run_status=$?
fi

# Report tool count, prompt size and TTFT even when the run failed.
node "$REPORT_PROMPT_SURFACE" \
  "$ARTIFACT_DIR/qvac-serve.stdout" \
  "$ARTIFACT_DIR/prompt-surface.md" || true

if [[ -n "${GITHUB_STEP_SUMMARY:-}" && -f "$ARTIFACT_DIR/prompt-surface.md" ]]; then
  cat "$ARTIFACT_DIR/prompt-surface.md" >> "$GITHUB_STEP_SUMMARY"
fi

if (( run_status != 0 )); then
  echo "OpenCode exited ${run_status}; see opencode-run.stderr and qvac-serve.stderr" >&2
  exit "$run_status"
fi

node "$VERIFY_RUN_OUTPUT" "$ARTIFACT_DIR/opencode-run.jsonl"

{
  echo
  echo "## Smoke result"
  echo
  echo "OpenCode completed successfully through \`@qvac/opencode-plugin@latest\` using \`qvac/${QVAC_MODEL}\`."
} | tee "$ARTIFACT_DIR/smoke-result.md" > /dev/null

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$ARTIFACT_DIR/smoke-result.md" >> "$GITHUB_STEP_SUMMARY"
fi
