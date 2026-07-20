#!/usr/bin/env bash
set -euo pipefail

SMOKE_DIR="${SMOKE_DIR:-$(mktemp -d)}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$(mktemp -d)}"
QVAC_MODEL="${QVAC_MODEL:-qwen3.5-0.8b}"
QVAC_READY_TIMEOUT_MS="${QVAC_READY_TIMEOUT_MS:-1800000}"
OPENCLAW_AGENT_TIMEOUT="${OPENCLAW_AGENT_TIMEOUT:-45m}"
OPENCLAW_PACKAGE_SPEC="${OPENCLAW_PACKAGE_SPEC:-openclaw@latest}"
QVAC_OPENCLAW_PLUGIN_SPEC="${QVAC_OPENCLAW_PLUGIN_SPEC:-@qvac/openclaw-plugin@latest}"
QVAC_CLI_SPEC="${QVAC_CLI_SPEC:-@qvac/cli@latest}"
QVAC_SDK_SPEC="${QVAC_SDK_SPEC:-@qvac/sdk@latest}"
export OPENCLAW_PACKAGE_SPEC QVAC_OPENCLAW_PLUGIN_SPEC QVAC_CLI_SPEC QVAC_SDK_SPEC

mkdir -p "$SMOKE_DIR" "$ARTIFACT_DIR"
SMOKE_DIR="$(cd "$SMOKE_DIR" && pwd -P)"
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd -P)"
export HOME="$SMOKE_DIR/home"
mkdir -p "$HOME"
cd "$SMOKE_DIR"

npm init -y > /dev/null
printf '%s\n' \
  'registry=https://registry.npmjs.org/' \
  '@qvac:registry=https://registry.npmjs.org/' \
  'foreground-scripts=true' \
  > .npmrc

npm install --no-fund --no-audit \
  "$OPENCLAW_PACKAGE_SPEC" \
  "$QVAC_OPENCLAW_PLUGIN_SPEC" \
  "$QVAC_CLI_SPEC" \
  "$QVAC_SDK_SPEC" \
  2>&1 | tee "$ARTIFACT_DIR/npm-install.log"

cat > "$ARTIFACT_DIR/package-specs.json" <<JSON
{
  "openclaw": "$OPENCLAW_PACKAGE_SPEC",
  "@qvac/openclaw-plugin": "$QVAC_OPENCLAW_PLUGIN_SPEC",
  "@qvac/cli": "$QVAC_CLI_SPEC",
  "@qvac/sdk": "$QVAC_SDK_SPEC"
}
JSON

npm ls --json \
  openclaw \
  @qvac/openclaw-plugin \
  @qvac/ai-sdk-provider \
  @qvac/cli \
  @qvac/sdk \
  > "$ARTIFACT_DIR/npm-ls.json" || true

node - > "$ARTIFACT_DIR/package-versions.json" <<'NODE'
const { existsSync, readFileSync } = require('node:fs')
const { dirname, join, parse } = require('node:path')
const { createRequire } = require('node:module')

const requireFromProject = createRequire(`${process.cwd()}/package.json`)
const names = [
  'openclaw',
  '@qvac/openclaw-plugin',
  '@qvac/ai-sdk-provider',
  '@qvac/cli',
  '@qvac/sdk'
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

QVAC_BIN="$SMOKE_DIR/node_modules/.bin/qvac"
export QVAC_BIN QVAC_MODEL QVAC_READY_TIMEOUT_MS

echo "OpenClaw CLI version:" | tee "$ARTIFACT_DIR/openclaw-version.txt"
npx openclaw --version | tee -a "$ARTIFACT_DIR/openclaw-version.txt"

echo "QVAC CLI version:" | tee "$ARTIFACT_DIR/qvac-version.txt"
if ! "$QVAC_BIN" --version | tee -a "$ARTIFACT_DIR/qvac-version.txt"; then
  echo "Unable to read QVAC CLI version from $QVAC_BIN" | tee -a "$ARTIFACT_DIR/qvac-version.txt"
fi

npx openclaw plugins install "$QVAC_OPENCLAW_PLUGIN_SPEC" \
  > "$ARTIFACT_DIR/openclaw-plugin-install.stdout" \
  2> "$ARTIFACT_DIR/openclaw-plugin-install.stderr"
npx openclaw plugins enable qvac \
  > "$ARTIFACT_DIR/openclaw-plugin-enable.stdout" \
  2> "$ARTIFACT_DIR/openclaw-plugin-enable.stderr"
npx openclaw config set plugins.allow '["qvac"]' --strict-json \
  > "$ARTIFACT_DIR/openclaw-config-allow.stdout" \
  2> "$ARTIFACT_DIR/openclaw-config-allow.stderr"

PLUGIN_CONFIG_JSON="$(node - <<'NODE'
console.log(JSON.stringify({
  model: process.env.QVAC_MODEL,
  qvacCommand: process.env.QVAC_BIN,
  readyTimeoutMs: Number(process.env.QVAC_READY_TIMEOUT_MS),
  ctxSize: 32768,
  reasoningBudget: 0,
  tools: true
}))
NODE
)"
printf '%s\n' "$PLUGIN_CONFIG_JSON" > "$ARTIFACT_DIR/openclaw-qvac-plugin-config.json"

npx openclaw config set plugins.entries.qvac.config "$PLUGIN_CONFIG_JSON" --strict-json \
  > "$ARTIFACT_DIR/openclaw-config-plugin.stdout" \
  2> "$ARTIFACT_DIR/openclaw-config-plugin.stderr"

npx openclaw onboard \
  --non-interactive \
  --accept-risk \
  --mode local \
  --auth-choice qvac \
  --skip-search \
  --skip-health \
  > "$ARTIFACT_DIR/openclaw-onboard.stdout" \
  2> "$ARTIFACT_DIR/openclaw-onboard.stderr"

npx openclaw config validate \
  > "$ARTIFACT_DIR/openclaw-config-validate.stdout" \
  2> "$ARTIFACT_DIR/openclaw-config-validate.stderr"

if [[ -f "$HOME/.openclaw/config.json" ]]; then
  cp "$HOME/.openclaw/config.json" "$ARTIFACT_DIR/openclaw-config.json"
elif [[ -f "$HOME/.config/openclaw/config.json" ]]; then
  cp "$HOME/.config/openclaw/config.json" "$ARTIFACT_DIR/openclaw-config.json"
fi

npx openclaw models list --all --provider qvac \
  > "$ARTIFACT_DIR/openclaw-models-list.stdout" \
  2> "$ARTIFACT_DIR/openclaw-models-list.stderr"
npx openclaw models status \
  > "$ARTIFACT_DIR/openclaw-models-status.stdout" \
  2> "$ARTIFACT_DIR/openclaw-models-status.stderr"

{
  echo "## OpenClaw model setup"
  echo
  echo '```text'
  cat "$ARTIFACT_DIR/openclaw-models-status.stdout"
  echo '```'
} | tee "$ARTIFACT_DIR/model-status.md" > /dev/null

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$ARTIFACT_DIR/model-status.md" >> "$GITHUB_STEP_SUMMARY"
fi

if [[ "${SKIP_OPENCLAW_AGENT:-0}" == "1" ]]; then
  {
    echo
    echo "## Smoke result"
    echo
    echo "Skipped OpenClaw agent run because \`SKIP_OPENCLAW_AGENT=1\`."
  } | tee "$ARTIFACT_DIR/smoke-skipped.md" > /dev/null
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    cat "$ARTIFACT_DIR/smoke-skipped.md" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

run_openclaw=(
  npx openclaw agent
  --local
  --session-id qvac-openclaw-upstream-compat
  --model "qvac/${QVAC_MODEL}"
  --message "Reply with one short sentence that includes qvac-ok."
  --thinking off
  --json
)

if command -v timeout > /dev/null 2>&1; then
  timeout "$OPENCLAW_AGENT_TIMEOUT" "${run_openclaw[@]}" \
    > "$ARTIFACT_DIR/openclaw-agent.stdout" \
    2> "$ARTIFACT_DIR/openclaw-agent.stderr"
else
  "${run_openclaw[@]}" \
    > "$ARTIFACT_DIR/openclaw-agent.stdout" \
    2> "$ARTIFACT_DIR/openclaw-agent.stderr"
fi

node - "$ARTIFACT_DIR/openclaw-agent.stdout" "$QVAC_MODEL" <<'NODE'
const { readFileSync } = require('node:fs')

const [outputPath, model] = process.argv.slice(2)
const text = readFileSync(outputPath, 'utf8').trim()
if (!text) throw new Error('OpenClaw agent produced no stdout')

function parseJsonOutput(value) {
  try {
    return JSON.parse(value)
  } catch {
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index])
      } catch {
        // Keep scanning for the final JSON record.
      }
    }
    throw new Error('OpenClaw agent stdout did not contain JSON output')
  }
}

const result = parseJsonOutput(text)
const serialized = JSON.stringify(result)
const finalText = String(result.finalAssistantVisibleText ?? result.finalText ?? '')

if (!/qvac-ok/i.test(finalText) && !/qvac-ok/i.test(serialized)) {
  throw new Error('OpenClaw agent response did not include qvac-ok')
}
if (result.fallbackUsed !== undefined && result.fallbackUsed !== false) {
  throw new Error(`OpenClaw fallback was used: ${result.fallbackUsed}`)
}
if (!serialized.includes('qvac')) {
  throw new Error('OpenClaw agent output did not reference the qvac provider')
}
if (!serialized.includes(model) && !serialized.includes(`qvac/${model}`)) {
  throw new Error(`OpenClaw agent output did not reference model ${model}`)
}
NODE

{
  echo
  echo "## Smoke result"
  echo
  echo "OpenClaw completed successfully through \`${QVAC_OPENCLAW_PLUGIN_SPEC}\` using \`qvac/${QVAC_MODEL}\`."
} | tee "$ARTIFACT_DIR/smoke-result.md" > /dev/null

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$ARTIFACT_DIR/smoke-result.md" >> "$GITHUB_STEP_SUMMARY"
fi
