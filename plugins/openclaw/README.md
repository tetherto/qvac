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
openclaw onboard --auth-choice qvac
```

`@qvac/sdk` must be available next to the `qvac` command so serve can resolve
model constants from the catalog. Installing and enabling the plugin alone does
not materialize the QVAC provider credential or private key; onboarding is
required.

For non-interactive setup:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --mode local \
  --auth-choice qvac \
  --skip-search \
  --skip-health
```

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

The setup command creates the QVAC provider entry and selects
`qvac/qwen3.5-9b`. It leaves OpenClaw's experimental settings unchanged. The 9B
model is recommended for the OpenClaw agent smoke test. Smaller models can
answer direct prompts, but they are less reliable with the full agent harness.

If an earlier QVAC plugin setup enabled OpenClaw's local-model lean mode, disable
it to restore direct access to tools such as `browser`, `cron`, and `message`:

```bash
openclaw config set agents.defaults.experimental.localModelLean false
```

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
  --session-id qvac-smoke-9b \
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

The managed `qvac serve` requires bearer authentication. After the onboarding
step above, OpenClaw resolves the same private key file for client requests and
readiness probes.

## Configure

The plugin defaults to `qwen3.5-9b` on `127.0.0.1:11434`. It generates the
temporary QVAC serve config internally when OpenClaw starts its `localService`.
On first setup it generates a random 32-byte base64url bearer key and stores it
at `~/.openclaw/plugins/qvac/api-key` (or under `OPENCLAW_STATE_DIR`). The key is
reused across restarts. Its directory is kept at mode `0700` and the file at
mode `0600`.

OpenClaw's provider config uses a file SecretRef, and the local-service arguments
contain only the key-file path. The launcher reads that file and passes the key
to `qvac serve openai --api-key`. A missing, invalid, or unsafe key prevents the
server from starting. The generated QVAC serve config does not contain the key.
The SecretRef provider id is namespaced as `qvac_key_file` so setup does not
replace an unrelated `secrets.providers.qvac` entry.

Plugin config can override the local service launcher:

```json5
{
  plugins: {
    entries: {
      qvac: {
        enabled: true,
        config: {
          model: 'qwen3.5-9b',
          qvacCommand: '/absolute/path/to/qvac',
          port: 11434,
          ctxSize: 32768,
          tools: true
        }
      }
    }
  }
}
```

To supply your own key, set `apiKey` to 32-128 base64url characters. Leading and
trailing whitespace is removed; control characters, Unicode, other punctuation,
and values beginning with `-` are rejected. Setup materializes the normalized
value into the private key file:

```bash
openclaw config set plugins.entries.qvac.config.apiKey \
  '"abcdefghijklmnopqrstuvwxyzABCDE_"' --strict-json
openclaw onboard --auth-choice qvac
openclaw config unset plugins.entries.qvac.config.apiKey
```

Removing the temporary plaintext plugin option after onboarding leaves the
generated provider configuration pointing at the private key file. `apiKey`
changes take effect only after re-running
`openclaw onboard --auth-choice qvac`.

Other clients connecting to the managed server must send the same bearer key:

```bash
QVAC_API_KEY="$(tr -d '\r\n' < "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/plugins/qvac/api-key")"
curl -H "Authorization: Bearer $QVAC_API_KEY" http://127.0.0.1:11434/v1/models
unset QVAC_API_KEY
```

The launcher key is not exposed in its process arguments. The `qvac serve`
grandchild still receives `--api-key <key>`, so the key can be visible to
same-user or privileged process inspection until the QVAC CLI supports a secret
file, environment, or file-descriptor transport.

## Upgrading

The managed `qvac serve` now requires bearer authentication, and the key reaches
the launcher as a `--api-key-file` path in `localService.args`. That argument list
is written into `openclaw.json` by onboarding, so an install configured **before**
this change has a persisted arg list without it.

**A plugin upgrade alone is not enough — re-onboard once:**

```bash
openclaw onboard --auth-choice qvac
```

Until you do, every attempt to start the local QVAC service fails with
`--api-key-file requires a value …` and names this same remedy. The launcher fails
closed on purpose: it will not fall back to an unauthenticated serve, and it will
not guess a key-file path that onboarding never wrote.

Re-onboarding is idempotent for already-migrated installs: it reuses the existing
key file, refreshes the provider entry, and leaves your model choice alone.

## Troubleshooting

If the QVAC key file is missing, unreadable as a key, or its permissions have
drifted, rerun `openclaw onboard --auth-choice qvac`. Setup recreates a missing
key file, replaces a corrupt or empty one with a freshly generated key in place
(the key is local-only, so there is nothing to recover from it), and self-heals
its directory to mode `0700` and the file to mode `0600`. A key path that is not
a regular file — a symlink or directory — is rejected instead of overwritten;
remove it yourself and rerun onboarding.

If the local service fails with `--api-key-file requires a value`, see
[Upgrading](#upgrading).

## What It Registers

- Provider id: `qvac`
- API adapter: `openai-completions`
- Bearer authentication: the configured provider `apiKey` is required by the
  managed `qvac serve openai` process through a file SecretRef
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
