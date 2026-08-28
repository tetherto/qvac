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

# Collect everything that explains a hung or looping agent turn. This has to run
# on the failure paths too -- when `timeout` kills the agent the script exits
# non-zero under `set -e`, and previously nothing but stdout/stderr survived.
collect_diagnostics() {
  cp -r "$HOME/.openclaw/agents/main/sessions" "$ARTIFACT_DIR/sessions" 2> /dev/null || true
  cp -r "$HOME/.openclaw/logs" "$ARTIFACT_DIR/openclaw-logs" 2> /dev/null || true
}
trap collect_diagnostics EXIT

npm init -y > /dev/null
printf '%s\n' \
  'registry=https://registry.npmjs.org/' \
  '@qvac:registry=https://registry.npmjs.org/' \
  'foreground-scripts=true' \
  > .npmrc

cat > "$ARTIFACT_DIR/package-specs.json" <<JSON
{
  "openclaw": "$OPENCLAW_PACKAGE_SPEC",
  "@qvac/openclaw-plugin": "$QVAC_OPENCLAW_PLUGIN_SPEC",
  "@qvac/cli": "$QVAC_CLI_SPEC",
  "@qvac/sdk": "$QVAC_SDK_SPEC"
}
JSON

npm view "$OPENCLAW_PACKAGE_SPEC" version dist-tags --json \
  > "$ARTIFACT_DIR/openclaw-package-metadata.json"
npm view "$QVAC_OPENCLAW_PLUGIN_SPEC" version peerDependencies peerDependenciesMeta --json \
  > "$ARTIFACT_DIR/qvac-openclaw-plugin-package-metadata.json"

# OpenClaw tags numeric-suffix builds as latest, which npm treats as prereleases.
# The user-facing plugin install below still runs with strict peer resolution.
npm install --no-fund --no-audit \
  --legacy-peer-deps \
  "$OPENCLAW_PACKAGE_SPEC" \
  "$QVAC_OPENCLAW_PLUGIN_SPEC" \
  "$QVAC_CLI_SPEC" \
  "$QVAC_SDK_SPEC" \
  2>&1 | tee "$ARTIFACT_DIR/npm-install.log"

npm ls --json \
  openclaw \
  @qvac/openclaw-plugin \
  @qvac/ai-sdk-provider \
  @qvac/cli \
  @qvac/sdk \
  > "$ARTIFACT_DIR/npm-ls.json" \
  2> "$ARTIFACT_DIR/npm-ls.stderr" || true

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

QVAC_REAL_BIN="$SMOKE_DIR/node_modules/.bin/qvac"

# OpenClaw's localService spawns `qvac serve` itself, so its stdout/stderr are
# not on any handle this script owns -- which is why a wedged server leaves no
# trace in the artifacts. Hand the plugin a wrapper that tees both streams to
# disk and still passes them through to OpenClaw, so readiness detection and
# shutdown are unaffected. `exec` keeps the PID the plugin sees.
QVAC_BIN="$SMOKE_DIR/qvac-serve-wrapper.sh"
cat > "$QVAC_BIN" <<WRAPPER
#!/usr/bin/env bash
exec "$QVAC_REAL_BIN" "\$@" \
  > >(tee -a "$ARTIFACT_DIR/qvac-serve.stdout") \
  2> >(tee -a "$ARTIFACT_DIR/qvac-serve.stderr" >&2)
WRAPPER
chmod +x "$QVAC_BIN"

export QVAC_BIN QVAC_REAL_BIN QVAC_MODEL QVAC_READY_TIMEOUT_MS

echo "OpenClaw CLI version:" | tee "$ARTIFACT_DIR/openclaw-version.txt"
npx openclaw --version | tee -a "$ARTIFACT_DIR/openclaw-version.txt"

echo "QVAC CLI version:" | tee "$ARTIFACT_DIR/qvac-version.txt"
if ! "$QVAC_REAL_BIN" --version | tee -a "$ARTIFACT_DIR/qvac-version.txt"; then
  echo "Unable to read QVAC CLI version from $QVAC_REAL_BIN" | tee -a "$ARTIFACT_DIR/qvac-version.txt"
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

# `openclaw onboard` writes ~/.openclaw/openclaw.json. The two config.json
# paths below are legacy layouts kept as fallbacks; neither has ever matched,
# so this artifact was silently absent from every run until openclaw.json was
# added as the first candidate.
if [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
  cp "$HOME/.openclaw/openclaw.json" "$ARTIFACT_DIR/openclaw-config.json"
elif [[ -f "$HOME/.openclaw/config.json" ]]; then
  cp "$HOME/.openclaw/config.json" "$ARTIFACT_DIR/openclaw-config.json"
elif [[ -f "$HOME/.config/openclaw/config.json" ]]; then
  cp "$HOME/.config/openclaw/config.json" "$ARTIFACT_DIR/openclaw-config.json"
else
  echo "warning: no openclaw config found under $HOME/.openclaw" >&2
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

# Verification lives in a file rather than a heredoc so each retry can re-run it.
cat > "$SMOKE_DIR/verify-agent-output.cjs" <<'NODE'
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

// Every field below lives under `meta`, not at the top level. Reading them off
// `result` yields undefined, which used to collapse each assertion onto a
// `JSON.stringify(result)` fallback -- and that blob always contains "qvac-ok"
// (echoed back as meta.finalPromptText), "qvac", and the model name. The whole
// verification block could not fail: a run where the model refused outright
// still reported success. Assert against the assistant text and the structured
// metadata only, never the serialized blob.
const meta = result.meta ?? {}
const agentMeta = meta.agentMeta ?? {}

const payloadText = Array.isArray(result.payloads)
  ? result.payloads.map((entry) => String(entry?.text ?? '')).join('\n')
  : ''
const finalText = String(meta.finalAssistantVisibleText ?? '') || payloadText

if (!finalText.trim()) {
  throw new Error('OpenClaw agent produced no assistant text')
}
// A bare "contains qvac-ok" check is not enough: a model that refuses the task
// quotes the token back while doing so ("...your specific query about
// \"qvac-ok\"..."), which would pass. The prompt asks for the token and nothing
// else, so a compliant reply is short; a refusal or a ramble is not. The cap is
// deliberately loose -- real passes are under 20 characters, observed refusals
// run past 300 -- so it rejects non-answers without policing phrasing.
const MAX_COMPLIANT_REPLY_CHARS = 120
const compact = finalText.trim()

if (!/qvac-ok/i.test(compact)) {
  throw new Error(`OpenClaw agent response did not include qvac-ok: ${compact.slice(0, 300)}`)
}
if (compact.length > MAX_COMPLIANT_REPLY_CHARS) {
  throw new Error(
    `OpenClaw agent did not answer the prompt (${compact.length} chars, expected <= ${MAX_COMPLIANT_REPLY_CHARS}): ${compact.slice(0, 300)}`
  )
}
if (meta.aborted === true) {
  throw new Error('OpenClaw agent run was aborted')
}

const fallbackUsed = meta.fallbackUsed ?? result.fallbackUsed
if (fallbackUsed !== undefined && fallbackUsed !== false) {
  throw new Error(`OpenClaw fallback was used: ${fallbackUsed}`)
}
if (agentMeta.provider !== 'qvac') {
  throw new Error(`OpenClaw agent did not run through the qvac provider: ${agentMeta.provider}`)
}
if (agentMeta.model !== model && agentMeta.model !== `qvac/${model}`) {
  throw new Error(`OpenClaw agent ran model ${agentMeta.model}, expected ${model}`)
}
NODE

# Each attempt gets a fresh session id. Retrying into the same session would
# replay the poisoned transcript that caused the first failure -- the 2026-08-27
# timeout looped for 13 turns before the run was killed, and resuming it would
# just loop again.
run_agent_attempt() {
  local attempt="$1"
  local stdout_path="$2"
  local stderr_path="$3"
  local run_openclaw=(
    npx openclaw agent
    --local
    --session-id "qvac-openclaw-upstream-compat-${attempt}"
    --model "qvac/${QVAC_MODEL}"
    --message "Reply with exactly this text and nothing else: qvac-ok"
    --thinking off
    --json
  )

  if command -v timeout > /dev/null 2>&1; then
    timeout "$OPENCLAW_AGENT_TIMEOUT" "${run_openclaw[@]}" \
      > "$stdout_path" \
      2> "$stderr_path"
  else
    "${run_openclaw[@]}" \
      > "$stdout_path" \
      2> "$stderr_path"
  fi
}

# A 0.8b model carrying the full coding tool profile has ~3.4k tokens of context
# headroom here and does not always follow a one-line instruction; it sometimes
# refuses or loops. One retry keeps the tripwire pointed at integration breakage
# rather than at model variance. Every attempt is kept as an artifact.
OPENCLAW_AGENT_MAX_ATTEMPTS="${OPENCLAW_AGENT_MAX_ATTEMPTS:-2}"
agent_ok=0
agent_failure=""

for (( attempt = 1; attempt <= OPENCLAW_AGENT_MAX_ATTEMPTS; attempt++ )); do
  attempt_stdout="$ARTIFACT_DIR/openclaw-agent.attempt-${attempt}.stdout"
  attempt_stderr="$ARTIFACT_DIR/openclaw-agent.attempt-${attempt}.stderr"

  agent_status=0
  run_agent_attempt "$attempt" "$attempt_stdout" "$attempt_stderr" || agent_status=$?

  # Always surface the most recent attempt under the documented artifact names.
  cp "$attempt_stdout" "$ARTIFACT_DIR/openclaw-agent.stdout"
  cp "$attempt_stderr" "$ARTIFACT_DIR/openclaw-agent.stderr"

  if (( agent_status != 0 )); then
    if (( agent_status == 124 )); then
      agent_failure="attempt ${attempt}: agent timed out after ${OPENCLAW_AGENT_TIMEOUT}"
    else
      agent_failure="attempt ${attempt}: agent exited ${agent_status}"
    fi
    echo "$agent_failure" >&2
    continue
  fi

  verify_status=0
  node "$SMOKE_DIR/verify-agent-output.cjs" "$attempt_stdout" "$QVAC_MODEL" || verify_status=$?
  if (( verify_status == 0 )); then
    agent_ok=1
    agent_attempts_used="$attempt"
    break
  fi
  agent_failure="attempt ${attempt}: response failed verification"
  echo "$agent_failure" >&2
done

if (( agent_ok != 1 )); then
  echo "OpenClaw agent failed after ${OPENCLAW_AGENT_MAX_ATTEMPTS} attempt(s): ${agent_failure}" >&2
  {
    echo
    echo "## Smoke result"
    echo
    echo "OpenClaw agent failed after ${OPENCLAW_AGENT_MAX_ATTEMPTS} attempt(s): ${agent_failure}"
  } | tee "$ARTIFACT_DIR/smoke-result.md" > /dev/null
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    cat "$ARTIFACT_DIR/smoke-result.md" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

{
  echo
  echo "## Smoke result"
  echo
  echo "OpenClaw completed successfully through \`${QVAC_OPENCLAW_PLUGIN_SPEC}\` using \`qvac/${QVAC_MODEL}\` (attempt ${agent_attempts_used}/${OPENCLAW_AGENT_MAX_ATTEMPTS})."
} | tee "$ARTIFACT_DIR/smoke-result.md" > /dev/null

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$ARTIFACT_DIR/smoke-result.md" >> "$GITHUB_STEP_SUMMARY"
fi
