#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
VERIFY_AGENT_OUTPUT="$SCRIPT_DIR/verify-openclaw-agent-output.cjs"
VERIFY_PROMPT_SURFACE="$SCRIPT_DIR/verify-openclaw-prompt-surface.cjs"

SMOKE_DIR="${SMOKE_DIR:-$(mktemp -d)}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$(mktemp -d)}"
QVAC_MODEL="${QVAC_MODEL:-qwen3.5-0.8b}"
# Must stay under OPENCLAW_AGENT_TIMEOUT_SECONDS: readiness is awaited inside
# the agent run, so a longer value here is unreachable.
QVAC_READY_TIMEOUT_MS="${QVAC_READY_TIMEOUT_MS:-180000}"

# Passed to `openclaw agent --timeout` so a deadline arrives as a JSON envelope
# rather than a signal; the shell `timeout` below is only a backstop. Keep the
# two different -- when both were 600s the shell won every time and deadlines
# arrived as an opaque SIGTERM. The attempt budget multiplies this, and the
# product has to fit the job timeout in openclaw-upstream-compat.yml.
OPENCLAW_AGENT_TIMEOUT_SECONDS="${OPENCLAW_AGENT_TIMEOUT_SECONDS:-240}"
OPENCLAW_AGENT_BACKSTOP_SECONDS="$((OPENCLAW_AGENT_TIMEOUT_SECONDS + 60))"

# OpenClaw's advertised tool count sets the prompt size, which on a 2-core
# runner sets the per-turn cost -- and the count is upstream's, having moved
# between 35, 36 and 12 across three releases. Pin it so this tripwire's cost
# does not track upstream's catalog. `tools: true` stays on below, so schemas
# still render through the Jinja path; this bounds the surface rather than
# switching tool support off.
OPENCLAW_TOOL_PROFILE="${OPENCLAW_TOOL_PROFILE:-minimal}"

# A widened surface is compatibility drift, so it has to fail rather than pass
# more slowly.
OPENCLAW_MAX_ADVERTISED_TOOLS="${OPENCLAW_MAX_ADVERTISED_TOOLS:-8}"
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
# `2>/dev/null || true` on a hardcoded path is how the openclaw-config.json
# artifact went missing from every run for months: the path was wrong and
# nothing said so. These copies stay best-effort -- a missing directory must
# never fail the smoke -- but each one reports what it did, so a layout change
# upstream shows up as a warning in the log instead of a silently absent
# artifact. Paths confirmed against a live run: `openclaw onboard` prints
# "Sessions OK: ~/.openclaw/agents/main/sessions", and the agent JSON reports
# meta.agentMeta.sessionFile under that same directory.
collect_diagnostic_dir() {
  local label="$1" src="$2" dest="$3"
  if [[ ! -d "$src" ]]; then
    echo "warning: ${label} not found at ${src}; artifact will be absent" >&2
    return 0
  fi
  if ! cp -r "$src" "$dest" 2> /dev/null; then
    echo "warning: failed to copy ${label} from ${src}" >&2
    return 0
  fi

  # An empty directory is not a successful collection: upload-artifact drops
  # empty directories, so reporting "collected" here would promise an artifact
  # that never appears -- the same misleading silence this function exists to
  # remove. Expected when the agent turn is skipped (SKIP_OPENCLAW_AGENT=1).
  local count
  count="$(find "$dest" -type f 2> /dev/null | wc -l | tr -d ' ')"
  if [[ "$count" == "0" ]]; then
    echo "warning: ${label} at ${src} is empty; no artifact will be uploaded" >&2
  else
    echo "collected ${label} (${count} file(s)) from ${src}" >&2
  fi
}

collect_diagnostics() {
  collect_diagnostic_dir "sessions" "$HOME/.openclaw/agents/main/sessions" "$ARTIFACT_DIR/sessions"
  collect_diagnostic_dir "openclaw logs" "$HOME/.openclaw/logs" "$ARTIFACT_DIR/openclaw-logs"
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

# openclaw 2026.8.1 (2026-08-31) added two consent gates that both cancel when
# nothing can answer them, which is every CI run:
#   --force               "This source is outside ClawHub review and trust
#                          metadata. Install cancelled; rerun with --force."
#   --accept-capabilities "Plugin \"qvac\" requires capability consent."
# Both are the remedies the CLI itself names, and per its usage strings
# `plugins install` takes both while `plugins enable` takes the second.
#
# Scoped deliberately to these two calls: the smoke installs QVAC's own
# published plugin, by exact spec, into a throwaway sandbox, with no human at
# the terminal. This is not a blanket opt-out of plugin trust or capability
# checks -- end users installing @qvac/openclaw-plugin still get both prompts.
npx openclaw plugins install "$QVAC_OPENCLAW_PLUGIN_SPEC" --force --accept-capabilities \
  > "$ARTIFACT_DIR/openclaw-plugin-install.stdout" \
  2> "$ARTIFACT_DIR/openclaw-plugin-install.stderr"
npx openclaw plugins enable qvac --accept-capabilities \
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

# openclaw 2026.8.1 namespaces plugin-contributed auth choices behind a
# `provider-plugin:` prefix -- a bare `--auth-choice qvac` is now rejected with
# a list of built-in choices only. The plugin still declares choiceId "qvac"
# correctly; the addressing changed on the OpenClaw side, so this is the caller
# that has to move. Requires openclaw >= 2026.8.1, which the smoke always
# installs via OPENCLAW_PACKAGE_SPEC=openclaw@latest.
npx openclaw onboard \
  --non-interactive \
  --accept-risk \
  --mode local \
  --auth-choice provider-plugin:qvac \
  --skip-search \
  --skip-health \
  > "$ARTIFACT_DIR/openclaw-onboard.stdout" \
  2> "$ARTIFACT_DIR/openclaw-onboard.stderr"

# After `onboard`, which defaults a fresh config to `tools.profile: coding`.
npx openclaw config set tools.profile "$OPENCLAW_TOOL_PROFILE" \
  > "$ARTIFACT_DIR/openclaw-config-tool-profile.stdout" \
  2> "$ARTIFACT_DIR/openclaw-config-tool-profile.stderr"

# OpenClaw applies Tool Search to local routes regardless of profile, and its
# `tool_search`/`tool_describe`/`tool_call` trio is enough on its own to pull
# the model into tool round-trips instead of answering: run 34453332533 spent
# two attempts on failed Tool Search calls and timed out on both. Tool-call
# plumbing is not what this tripwire proves, so opt out.
npx openclaw config set tools.toolSearch false --strict-json \
  > "$ARTIFACT_DIR/openclaw-config-tool-search.stdout" \
  2> "$ARTIFACT_DIR/openclaw-config-tool-search.stderr"

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

# Three wordings failed here, each for a different reason: "exactly this text"
# was read as a file-write instruction, naming tools ("do not call any tools")
# primed tool syntax, and asking for a sentence made a compliant answer
# indistinguishable from a mention. So ask for the word, and say nothing about
# tools. Must match what the verifier asserts, and stay in step with the
# OpenCode sibling smoke.
AGENT_PROMPT="${AGENT_PROMPT:-Reply with only the word qvac-ok.}"

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
    --message "$AGENT_PROMPT"
    --thinking off
    --timeout "$OPENCLAW_AGENT_TIMEOUT_SECONDS"
    --json
  )

  if command -v timeout > /dev/null 2>&1; then
    timeout -k 30 "$OPENCLAW_AGENT_BACKSTOP_SECONDS" "${run_openclaw[@]}" \
      > "$stdout_path" \
      2> "$stderr_path"
  else
    "${run_openclaw[@]}" \
      > "$stdout_path" \
      2> "$stderr_path"
  fi
}

# The budget carries model variance, measured at a ~46% per-attempt miss rate.
# Six is affordable only because the bounded surface made an attempt ~80s wall
# instead of the old 600s deadline. Every attempt is kept as an artifact so the
# rate stays measurable rather than assumed.
OPENCLAW_AGENT_MAX_ATTEMPTS="${OPENCLAW_AGENT_MAX_ATTEMPTS:-6}"
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
    case "$agent_status" in
      # 124/137 are the shell backstop killing a process that blew past its own
      # deadline, and arrive with empty stdout. Any other status is OpenClaw
      # exiting on its own terms, so its stdout holds a readable envelope; 2 is
      # the status upstream documents for a deadline.
      124 | 137) agent_failure="attempt ${attempt}: agent ignored its ${OPENCLAW_AGENT_TIMEOUT_SECONDS}s deadline and was killed by the ${OPENCLAW_AGENT_BACKSTOP_SECONDS}s backstop" ;;
      2) agent_failure="attempt ${attempt}: agent exited 2, upstream's documented deadline status (limit ${OPENCLAW_AGENT_TIMEOUT_SECONDS}s); see openclaw-agent.attempt-${attempt}.stdout" ;;
      *) agent_failure="attempt ${attempt}: agent exited ${agent_status}; see openclaw-agent.attempt-${attempt}.stdout" ;;
    esac
    echo "$agent_failure" >&2
    continue
  fi

  verify_status=0
  node "$VERIFY_AGENT_OUTPUT" "$attempt_stdout" "$QVAC_MODEL" || verify_status=$?
  if (( verify_status == 0 )); then
    agent_ok=1
    agent_attempts_used="$attempt"
    break
  fi
  agent_failure="attempt ${attempt}: response failed verification"
  echo "$agent_failure" >&2
done

# Tool count and prompt size explain a slow turn, so report them next to the
# result -- on the failure path too.
surface_status=0
node "$VERIFY_PROMPT_SURFACE" \
  "$ARTIFACT_DIR/qvac-serve.stdout" \
  "$OPENCLAW_TOOL_PROFILE" \
  "$OPENCLAW_MAX_ADVERTISED_TOOLS" \
  "$ARTIFACT_DIR/prompt-surface.md" || surface_status=$?

if [[ -n "${GITHUB_STEP_SUMMARY:-}" && -f "$ARTIFACT_DIR/prompt-surface.md" ]]; then
  cat "$ARTIFACT_DIR/prompt-surface.md" >> "$GITHUB_STEP_SUMMARY"
fi

if (( agent_ok != 1 )); then
  echo "OpenClaw agent failed after ${OPENCLAW_AGENT_MAX_ATTEMPTS} attempt(s): ${agent_failure}" >&2
  {
    echo
    echo "## Smoke result"
    echo
    echo "OpenClaw agent failed after ${OPENCLAW_AGENT_MAX_ATTEMPTS} attempt(s): ${agent_failure}"
    echo
    echo "See \`prompt-surface.md\` for the tool count and prompt size this run drove."
  } | tee "$ARTIFACT_DIR/smoke-result.md" > /dev/null
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    cat "$ARTIFACT_DIR/smoke-result.md" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

# Only status 1 means drift. Anything else is the check itself being broken
# (2 is a bad ceiling argument, 127 a missing node), which must not be reported
# as an upstream tool-surface change.
if (( surface_status != 0 && surface_status != 1 )); then
  echo "warning: prompt-surface check exited ${surface_status}; tool ceiling not enforced for this run" >&2
  surface_status=0
fi

# After the turn verdict, so a widened surface is reported as drift rather than
# hidden behind a green run that only got slower.
if (( surface_status != 0 )); then
  {
    echo
    echo "## Smoke result"
    echo
    echo "The agent turn answered correctly, but the advertised tool surface is above the \`${OPENCLAW_MAX_ADVERTISED_TOOLS}\` ceiling -- see \`prompt-surface.md\`."
    echo
    echo "Upstream widened what \`tools.profile=${OPENCLAW_TOOL_PROFILE}\` admits. Re-pin the surface, or raise \`OPENCLAW_MAX_ADVERTISED_TOOLS\` if the wider set is intended; leaving it unbounded is what made this tripwire unable to pass in #4112."
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
