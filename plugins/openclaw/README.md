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

### 2. Build, pack, and install the plugin

From the repository root:

```bash
cd plugins/openclaw
bun install
bun run test
bun run typecheck
bun run build
npm pack

openclaw plugins install ./qvac-openclaw-plugin-0.1.0.tgz --force
openclaw plugins enable qvac
openclaw config set plugins.allow '["qvac"]' --strict-json
```

`--force` replaces any previously installed local copy of the plugin.
`plugins.allow` removes OpenClaw's warning about auto-loading non-bundled
plugins and explicitly trusts the local `qvac` plugin.

### 3. Let the plugin configure OpenClaw's provider entry

Point the plugin at the `qvac` binary, then run OpenClaw's provider setup path.
The plugin writes `models.providers.qvac` for you with its bundled
`local-service.js` launcher. You do not need to create `qvac.config.json` or
paste a `models.providers.qvac` JSON block by hand.

```bash
QVAC_BIN="$(which qvac)"

openclaw config set plugins.entries.qvac.config \
  "{\"model\":\"qwen3.5-9b\",\"qvacCommand\":\"$QVAC_BIN\",\"port\":11434}" \
  --strict-json

openclaw onboard \
  --non-interactive \
  --accept-risk \
  --mode local \
  --auth-choice qvac \
  --skip-search \
  --skip-health

openclaw config validate
```

The setup command creates the QVAC provider entry, selects `qvac/qwen3.5-9b`,
and enables OpenClaw's lean local-model agent mode. The 9B model is recommended
for the OpenClaw agent smoke test. Smaller models can answer direct prompts, but
they are less reliable with the full agent harness.

### 4. Confirm OpenClaw can see the QVAC model

```bash
openclaw models list --all --provider qvac
openclaw models status
```

Expected result:

- `qvac/qwen3.5-9b` appears in the model list.
- `openclaw models status` shows `Default: qvac/qwen3.5-9b`.
- The QVAC provider should not show a missing-auth error.

### 5. Run the agent smoke test

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

The plugin defaults to `qwen3.5-9b` on `127.0.0.1:11434`. It generates the
temporary QVAC serve config internally when OpenClaw starts its `localService`.

Plugin config can override the local service launcher:

```json5
{
  plugins: {
    entries: {
      qvac: {
        enabled: true,
        config: {
          model: "qwen3.5-9b",
          qvacCommand: "/absolute/path/to/qvac",
          port: 11434,
          ctxSize: 32768,
          tools: true
        }
      }
    }
  }
}
```

## What It Registers

- Provider id: `qvac`
- API adapter: `openai-completions`
- Base URL: `http://127.0.0.1:11434/v1` by default
- Local service command: `node <plugin>/dist/local-service.js`, which writes a
  temporary QVAC serve config and starts `qvac serve openai`
- Model catalog: the shared `@qvac/ai-sdk-provider` catalog ids, including
  `qwen3.5-0.8b`, `qwen3.5-2b`, `qwen3.5-4b`, `qwen3.5-9b`,
  `qwen3.6-27b`, `qwen3.6-35b-a3b`, `gpt-oss-20b`, and `gemma4-31b`

## Current Scope

This first package is the native OpenClaw provider/catalog layer. It relies on
OpenClaw's own `localService` process manager rather than reimplementing the
managed-serve host used by `@qvac/opencode-plugin`.

The package also exports `createQvacServeModels()` for tools that want to create
the same QVAC serve model block programmatically.
