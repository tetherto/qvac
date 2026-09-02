# Changelog

## [0.2.1]

Release Date: 2026-08-21

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.2.1

## Switching Models No Longer Fails

The plugin's own code is unchanged, but moving to `@qvac/cli@^0.12.0` fixes a user-visible problem in how it runs.

The launcher writes every model in the QVAC catalog into the serve config, and marks only your selected model `preload: true`. On the CLI 0.11 line a `preload: false` model was registered but never loaded, so picking any other model in OpenClaw returned `503 model_not_ready` — permanently, until you changed the configured model and restarted. CLI 0.12 loads such a model on first request instead, so every model in the picker now works; the first turn after switching waits for a cold load, and later turns are fast.

## Runs Against the CLI 0.12 Line

The bundled `local-service.js` launcher now starts a `qvac serve` on the `@qvac/sdk` 0.18.x runtime, which also brings the serve model catalog endpoint.

Configuration and onboarding are unchanged — no re-onboarding is needed for this release. Installs that pin `@qvac/cli` to `0.11.x` will need to move to `0.12.x` alongside the plugin, since a 0.x caret range does not cross a minor.

## [0.2.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.2.0

The local QVAC service now runs authenticated. The launcher reads a bearer key from a private owner-only file and hands it to `qvac serve` without ever placing it in a process argument list. Existing installs must re-onboard once.

## Breaking Changes

### Re-onboard to migrate an existing install

The key reaches the launcher as an `--api-key-file` path in `localService.args`, and that argument list is persisted in `openclaw.json` by onboarding. An install configured before this release has a persisted list without it, so upgrading the plugin alone is not enough:

```bash
openclaw onboard --auth-choice qvac
```

Until you run it, starting the local QVAC service fails with `--api-key-file requires a value …`, which names the same remedy. This is deliberate: the launcher will not fall back to an unauthenticated serve, and it will not guess a key-file path that onboarding never wrote. Re-onboarding is idempotent for installs that have already migrated — it reuses the existing key file, refreshes the provider entry, and leaves your model choice alone.

### The key file is validated on every launch

A key file that is not a regular file, or whose permissions let anyone but the owner read it, now stops the launcher instead of being used. The check runs on every read rather than only at onboarding, because the path is long-lived: a file swapped for a symlink or loosened to group-readable between runs would otherwise be picked up silently. Recover with `chmod 600` on the file, or by re-running onboarding.

## Security

### The key stays out of the process list

Neither the launcher nor the `qvac serve` process it starts receives the key in its arguments. The serve is started with `--api-key-file` pointing at the same owner-only file, so the credential cannot be recovered from `ps` or `/proc/<pid>/cmdline`, which on Linux is readable by every local account.

Whether that is possible depends on the CLI in use, so the launcher runs the `@qvac/cli` installed alongside the plugin — the same install it reads the version from — through the current Node executable. A `qvacCommand` set to an explicit path is spawned verbatim instead and its version cannot be determined; that case falls back to `--api-key`, where the key is visible to local process inspection.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.6.0` for the shared model catalog
- `@qvac/cli@^0.11.0` for `qvac serve` (SDK 0.17 runtime), the first CLI that accepts `--api-key-file`

## [0.1.3]

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.1.3

This patch moves the OpenClaw plugin onto `@qvac/ai-sdk-provider` 0.5 and `@qvac/cli` 0.10 so local serves pick up the CLI 0.10 / SDK 0.17 runtime.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.5.0` for the shared model catalog
- `@qvac/cli@^0.10.0` for `qvac serve` (SDK 0.17 runtime)

Plugin behavior is unchanged.

## [0.1.2]

Release Date: 2026-07-27

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.1.2

This patch keeps OpenClaw's existing tools when QVAC setup runs, and moves the plugin onto `@qvac/ai-sdk-provider` 0.4 and `@qvac/cli` 0.9 so local serves pick up the latest SDK and CLI fixes.

## Preserve Tools During QVAC Setup

Enabling the QVAC provider no longer clears tools already configured in OpenClaw. Setup still registers the local QVAC provider and model catalog, but leaves the agent's tool configuration intact.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.4.0` for the shared model catalog (AI SDK 7 line)
- `@qvac/cli@^0.9.0` for `qvac serve` (SDK 0.16 runtime)

Node.js 22 or newer is required.

## [0.1.1]

Release Date: 2026-07-07

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.1.1

The first public npm release of `@qvac/openclaw-plugin` — an [OpenClaw](https://openclaw.ai) provider plugin that runs a local, fully managed QVAC serve so OpenClaw works against on-device models with no separate server to start.

## Local QVAC Provider for OpenClaw

The plugin registers a `qvac` provider that OpenClaw drives through its `localService` launcher. On use it starts `qvac serve` on a loopback port, exposes an OpenAI-compatible endpoint, waits for it to become healthy, and reaps it on OpenClaw's idle/exit lifecycle. It also contributes OpenClaw wizard and model-picker entries so QVAC can be selected like any other provider.

## Model Catalog With Larger Agent Models

The plugin ships a static model catalog using models.dev-style ids, resolving each friendly id to its `@qvac/sdk` model constant through `@qvac/ai-sdk-provider`'s shared catalog. Alongside the Qwen3.5 line it exposes the larger agent-oriented families — `qwen3.6-27b`, `qwen3.6-35b-a3b`, `gpt-oss-20b`, and `gemma4-31b` — which resolve to model constants shipped in `@qvac/sdk` 0.14.x. The default model is `qwen3.5-9b`.

## Requirements

This release targets the current agent stack: `@qvac/ai-sdk-provider` `^0.3.0` (shared catalog and managed serve), `@qvac/cli` `^0.8.0` (runs `qvac serve` on the SDK 0.14.x runtime), and `openclaw` `>=2026.6.0` as the optional host peer.

## [0.1.0]

Release Date: 2026-07-03

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.1.0

The first public release of `@qvac/openclaw-plugin` — an [OpenClaw](https://openclaw.ai) provider plugin that runs a local, fully managed QVAC serve so OpenClaw works against on-device models with no separate server to start.

## Local QVAC Provider for OpenClaw

The plugin registers a `qvac` provider that OpenClaw drives through its `localService` launcher. On use it starts `qvac serve` on a loopback port, exposes an OpenAI-compatible endpoint, waits for it to become healthy, and reaps it on OpenClaw's idle/exit lifecycle. It also contributes OpenClaw wizard and model-picker entries so QVAC can be selected like any other provider.

## Model Catalog With Larger Agent Models

The plugin ships a static model catalog using models.dev-style ids, resolving each friendly id to its `@qvac/sdk` model constant through `@qvac/ai-sdk-provider`'s shared catalog. Alongside the Qwen3.5 line it exposes the larger agent-oriented families — `qwen3.6-27b`, `qwen3.6-35b-a3b`, `gpt-oss-20b`, and `gemma4-31b` — which resolve to model constants shipped in `@qvac/sdk` 0.14.x. The default model is `qwen3.5-9b`.

## Requirements

This release targets the current agent stack: `@qvac/ai-sdk-provider` `^0.3.0` (shared catalog and managed serve), `@qvac/cli` `^0.8.0` (runs `qvac serve` on the SDK 0.14.x runtime), and `openclaw` `>=2026.6.0` as the optional host peer.
