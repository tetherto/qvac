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

## Test Locally From Source

From a checkout of `tetherto/qvac`, build and pack the plugin:

```bash
cd plugins/openclaw
bun install
bun run test
bun run typecheck
bun run build
npm pack
```

Install the local tarball into OpenClaw:

```bash
openclaw plugins install ./qvac-openclaw-plugin-0.1.0.tgz --force
openclaw plugins enable qvac
openclaw config set plugins.allow '["qvac"]' --strict-json
```

Create a local QVAC serve config next to the packed plugin:

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

Point OpenClaw at that local service config:

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

Run the agent smoke test:

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
