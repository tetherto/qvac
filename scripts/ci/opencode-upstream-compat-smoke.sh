#!/usr/bin/env bash
set -euo pipefail

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
        "tools": true
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
  "Reply with one short sentence that includes qvac-ok."
)

if command -v timeout > /dev/null 2>&1; then
  timeout "$OPENCODE_TIMEOUT" "${run_opencode[@]}" \
    > "$ARTIFACT_DIR/opencode-run.jsonl" \
    2> "$ARTIFACT_DIR/opencode-run.stderr"
else
  "${run_opencode[@]}" \
    > "$ARTIFACT_DIR/opencode-run.jsonl" \
    2> "$ARTIFACT_DIR/opencode-run.stderr"
fi

{
  echo
  echo "## Smoke result"
  echo
  echo "OpenCode completed successfully through \`@qvac/opencode-plugin@latest\` using \`qvac/${QVAC_MODEL}\`."
} | tee "$ARTIFACT_DIR/smoke-result.md" > /dev/null

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$ARTIFACT_DIR/smoke-result.md" >> "$GITHUB_STEP_SUMMARY"
fi
