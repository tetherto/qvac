# @qvac/openclaw-plugin

Run [OpenClaw](https://openclaw.ai) against a **local, on-device** QVAC model
using OpenClaw's native `localService` lifecycle support. The plugin registers a
`qvac` provider, exposes the shared QVAC model catalog, and asks OpenClaw to
start `qvac serve openai` when the provider is used.

## Install

```bash
npm install -g openclaw @qvac/openclaw-plugin @qvac/cli @qvac/sdk
openclaw plugins install @qvac/openclaw-plugin
openclaw plugins enable qvac
openclaw config set plugins.allow '["qvac"]' --strict-json
```

`@qvac/sdk` must be available next to the `qvac` command so serve can resolve
model constants from the catalog.

## Manual Local Testing

These steps test the plugin from a local checkout before it is published.
They modify your local OpenClaw config under `~/.openclaw`.

### 1. Install the local tools

Install OpenClaw and make sure the `qvac` command is available:

```bash
npm install -g openclaw @qvac/cli @qvac/sdk
openclaw --version
qvac --version
```

If another process is already using port `11434`, stop it before running the
smoke test. The OpenClaw `localService` should own the `qvac serve` process for
this test.

### 2. Build and pack the plugin

From the repository root:

```bash
cd plugins/openclaw
bun install
bun run test
bun run typecheck
bun run build
npm pack
```

This creates `qvac-openclaw-plugin-0.1.0.tgz` in `plugins/openclaw`.

### 3. Install the packed plugin into OpenClaw

```bash
openclaw plugins install ./qvac-openclaw-plugin-0.1.0.tgz --force
openclaw plugins enable qvac
openclaw config set plugins.allow '["qvac"]' --strict-json
```

`--force` replaces any previously installed local copy of the plugin.
`plugins.allow` removes OpenClaw's warning about auto-loading non-bundled
plugins and explicitly trusts the local `qvac` plugin.

### 4. Create the QVAC serve config

Create `qvac.config.json` next to the packed plugin:

```bash
cat > qvac.config.json <<'JSON'
{
  "serve": {
    "models": {
      "qwen3.5-9b": {
        "model": "QWEN3_5_9B_MULTIMODAL_Q4_K_M",
        "preload": true,
        "default": true,
        "config": {
          "ctx_size": 32768,
          "reasoning_budget": -1,
          "tools": true
        }
      }
    }
  }
}
JSON
```

The 9B model is recommended for the OpenClaw agent smoke test. Smaller models
can answer direct prompts, but they are less reliable with the full agent
harness.

### 5. Configure OpenClaw to use the local QVAC provider

Run this from `plugins/openclaw` so `$(pwd)/qvac.config.json` points at the file
created above:

```bash
openclaw config set models.providers.qvac "$(cat <<EOF
{
  "baseUrl": "http://127.0.0.1:11434/v1",
  "apiKey": "qvac-local",
  "api": "openai-completions",
  "timeoutSeconds": 300,
  "localService": {
    "command": "$(which qvac)",
    "args": [
      "serve",
      "openai",
      "--config",
      "$(pwd)/qvac.config.json",
      "--host",
      "127.0.0.1",
      "--port",
      "11434",
      "--model",
      "qwen3.5-9b"
    ],
    "healthUrl": "http://127.0.0.1:11434/v1/models",
    "readyTimeoutMs": 180000,
    "idleStopMs": 0
  },
  "models": [
    {
      "id": "qwen3.5-9b",
      "name": "Qwen3.5 9B",
      "api": "openai-completions",
      "reasoning": true,
      "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 32768,
      "maxTokens": 8192,
      "compat": { "requiresStringContent": true }
    }
  ]
}
EOF
)" --strict-json --merge
openclaw models set qvac/qwen3.5-9b
openclaw config set agents.defaults.experimental.localModelLean true --strict-json
openclaw config validate
```

The `localService` block tells OpenClaw how to start `qvac serve openai` on
demand. `compat.requiresStringContent` keeps OpenClaw's request shape compatible
with QVAC's OpenAI adapter, and `localModelLean` reduces agent prompt pressure
for local models.

### 6. Confirm OpenClaw can see the QVAC model

```bash
openclaw models list --all --provider qvac
openclaw models status
```

Expected result:

- `qvac/qwen3.5-9b` appears in the model list.
- `openclaw models status` shows `Default: qvac/qwen3.5-9b`.
- The QVAC provider should not show a missing-auth error.

### 7. Run the agent smoke test

```bash
openclaw agent --local \
  --session-id qvac-smoke-9b-lean \
  --model qvac/qwen3.5-9b \
  --message "Reply with exactly: pong" \
  --thinking off \
  --json
```

Expected result:

- OpenClaw logs `starting qvac local service`.
- OpenClaw logs `qvac local service ready`.
- The JSON response contains `finalAssistantVisibleText: "pong"`.
- The execution trace uses `provider: "qvac"` and `model: "qwen3.5-9b"`.
- `fallbackUsed` is `false`.

## Configure

The plugin defaults to `qwen3.5-9b` on `127.0.0.1:11434` and expects a
`qvac.config.json` in the directory where OpenClaw starts the local service.

Minimal `qvac.config.json`:

```json
{
  "serve": {
    "models": {
      "qwen3.5-9b": {
        "model": "QWEN3_5_9B_MULTIMODAL_Q4_K_M",
        "preload": true,
        "default": true,
        "config": {
          "ctx_size": 32768,
          "reasoning_budget": -1,
          "tools": true
        }
      }
    }
  }
}
```

Plugin config can override the local service:

```json5
{
  plugins: {
    entries: {
      qvac: {
        enabled: true,
        config: {
          model: "qwen3.5-9b",
          qvacCommand: "/absolute/path/to/qvac",
          configPath: "/absolute/path/to/qvac.config.json",
          port: 11434,
          ctxSize: 32768,
          tools: true
        }
      }
    }
  }
}
```

OpenClaw selects concrete model providers from `models.providers`, so configure
the local QVAC provider once after installing the plugin:

```bash
openclaw config set models.providers.qvac "$(cat <<EOF
{
  "baseUrl": "http://127.0.0.1:11434/v1",
  "apiKey": "qvac-local",
  "api": "openai-completions",
  "timeoutSeconds": 300,
  "localService": {
    "command": "$(which qvac)",
    "args": [
      "serve",
      "openai",
      "--config",
      "$(pwd)/qvac.config.json",
      "--host",
      "127.0.0.1",
      "--port",
      "11434",
      "--model",
      "qwen3.5-9b"
    ],
    "healthUrl": "http://127.0.0.1:11434/v1/models",
    "readyTimeoutMs": 180000,
    "idleStopMs": 0
  },
  "models": [
    {
      "id": "qwen3.5-9b",
      "name": "Qwen3.5 9B",
      "api": "openai-completions",
      "reasoning": true,
      "input": ["text", "image"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 32768,
      "maxTokens": 8192,
      "compat": { "requiresStringContent": true }
    }
  ]
}
EOF
)" --strict-json --merge
openclaw models set qvac/qwen3.5-9b
openclaw config set agents.defaults.experimental.localModelLean true --strict-json
```

## Smoke Test

```bash
openclaw agent --local \
  --session-id qvac-smoke-9b-lean \
  --model qvac/qwen3.5-9b \
  --message "Reply with exactly: pong" \
  --thinking off \
  --json
```

The expected response contains `finalAssistantVisibleText: "pong"` and an
execution trace with `provider: "qvac"`, `model: "qwen3.5-9b"`, and
`fallbackUsed: false`.

## What It Registers

- Provider id: `qvac`
- API adapter: `openai-completions`
- Base URL: `http://127.0.0.1:11434/v1` by default
- Local service command: `qvac serve openai --config qvac.config.json --host 127.0.0.1 --port 11434 --model qwen3.5-9b`
- Model catalog: the shared `@qvac/ai-sdk-provider` catalog ids, including
  `qwen3.5-0.8b`, `qwen3.5-2b`, `qwen3.5-4b`, and `qwen3.5-9b`

## Current Scope

This first package is the native OpenClaw provider/catalog layer. It relies on
OpenClaw's own `localService` process manager rather than reimplementing the
managed-serve host used by `@qvac/opencode-plugin`.

The package also exports `createQvacServeModels()` for tools that want to write
the matching `qvac.config.json` model block programmatically.
