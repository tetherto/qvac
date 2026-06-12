# QVAC CLI

A command-line interface for the QVAC ecosystem. QVAC CLI provides tooling for building, bundling, and managing QVAC-powered applications.

This package is published to npm as **`@qvac/cli`** and lives in the QVAC monorepo at **`packages/cli`**. Older instructions may refer to the deprecated **`qvac-cli`** package name—use **`@qvac/cli`** instead.

## Table of Contents

- [Installation](#installation)
- [Command Reference](#command-reference)
  - [`doctor`](#doctor)
  - [`bundle sdk`](#bundle-sdk)
  - [`verify deps`](#verify-deps)
  - [`verify bundle`](#verify-bundle)
  - [`serve openai`](#serve-openai)
- [Configuration](#configuration)
- [System Requirements](#system-requirements)
- [Development](#development)
- [License](#license)

## Installation

Install globally:

```bash
npm i -g @qvac/cli
```

Once installed, use the `qvac` command:

```bash
qvac <command>
```

Or run directly via npx:

```bash
npx @qvac/cli <command>
```

### Troubleshooting: `No binaries found for target '<platform>-<arch>'`

QVAC spawns its worker through `bare-runtime`, which loads a platform-specific
binary package (e.g. `bare-runtime-win32-x64`). With **pnpm** this package — or
one of its nested dependencies — is sometimes not installed, even on a supported
platform, so the runtime throws `No binaries found for target '<platform>-<arch>'`
(see [#1492](https://github.com/tetherto/qvac/issues/1492)).

Resolve it in one of these ways:

```bash
# Install the platform package directly (substitute your platform-arch)
pnpm add bare-runtime-win32-x64

# …or install with npm or bun, which place the nested binary correctly
npm install
```

## Command Reference

### `doctor`

Validate that the current host can run `@qvac/sdk` + `@qvac/cli` before you
hit runtime errors. The command prints a human-readable report by default and
exits `1` when any required check fails.

```bash
qvac doctor [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--json` | Output the report as JSON. |
| `-q, --quiet` | Suppress stdout — only set the exit code. |
| `-v, --verbose` | Detailed output. |

**What it checks:**

- **Runtime** — Node.js version (`>= 18`) and supported CLI host
  (desktop platforms only; Android/iOS are SDK deploy targets reported
  separately below).
- **Hardware** — total RAM, available RAM (via `os.availableMemory()` on
  Node 22+), GPU acceleration (Metal on macOS, `vulkaninfo` on
  Linux/Windows), and free disk space in the current working directory.
- **Deploy targets (SDK)** — desktop target matrix, Android (`adb`), and
  iOS (`xcodebuild` on macOS). Missing mobile toolchains produce
  warnings, not failures.
- **Optional tools** — `ffmpeg` (microphone/transcription), Bare runtime,
  Bun.
- **Project** — whether `@qvac/sdk` is resolvable from the current
  working directory (works for hoisted monorepo installs too).

See [`system-requirements.md`](./system-requirements.md) for the full list of
thresholds and rationale.

**Examples:**

```bash
# Human-readable report
qvac doctor

# JSON for CI / scripts
qvac doctor --json

# Fail-fast in a script (exit 1 on any required check)
qvac doctor --quiet || exit 1
```

### `bundle sdk`

Generate a tree-shaken Bare worker bundle containing the plugins you select (defaults to all built-in plugins).

```bash
qvac bundle sdk [options]
```

**What it does:**

1. Reads `qvac.config.*` from your project root (if present)
2. Resolves enabled plugins from the `plugins` array (defaults to all built-in plugins if omitted)
3. Generates worker entry files with **static imports only**
4. Bundles with `bare-pack --linked`
5. Generates `addons.manifest.json` from the bundle graph

**Options:**

| Flag | Description |
|------|-------------|
| `--config, -c <path>` | Config file path (default: auto-detect `qvac.config.*`) |
| `--host <target>` | Target host (repeatable, default: all platforms) |
| `--defer <module>` | Defer a module (repeatable, for mobile targets) |
| `--quiet, -q` | Minimal output |
| `--verbose, -v` | Detailed output |

**Examples:**

```bash
# Bundle with default settings (all platforms)
qvac bundle sdk

# Bundle for specific platforms only
qvac bundle sdk --host darwin-arm64 --host linux-x64

# Use a custom config file
qvac bundle sdk --config ./my-config.json

# Verbose output for debugging
qvac bundle sdk --verbose
```

**Output:**

| File | Description |
|------|-------------|
| `qvac/worker.entry.mjs` | Standalone/Electron worker with RPC + lifecycle |
| `qvac/worker.bundle.js` | Final bundle for mobile runtimes (Expo/BareKit) |
| `qvac/addons.manifest.json` | Native addon allowlist for tree-shaking |

> **Note:** Your project must have `@qvac/sdk` installed.

### `verify deps`

Detect native Bare addon package changes between two git refs by comparing
npm `package-lock.json` contents.

```bash
qvac verify deps --base <ref> --head <ref> [options]
```

Both `--base` and `--head` are required.

**Options:**

| Flag | Description |
|------|-------------|
| `--base <ref>` | Base git ref or SHA. |
| `--head <ref>` | Head git ref or SHA. |
| `--lockfile <path>` | Path to npm `package-lock.json` (default: `package-lock.json`). |
| `--quiet, -q` | Suppress output when there are no native changes. |

**Examples:**

```bash
# Local fork checkout
qvac verify deps --base upstream/main --head HEAD

# Direct clone where origin points at the canonical repo
qvac verify deps --base origin/main --head HEAD

# Package with a nested npm lockfile
qvac verify deps --base upstream/main --head HEAD --lockfile packages/sdk/package-lock.json
```

**Exit codes:**

| Exit | Meaning |
|------|---------|
| `0` | No native addon changes, or no npm lockfile exists at either ref. |
| `1` | Native addon additions or removals were detected, or a removed package's native status could not be determined. Reviewers should confirm the change is intentional. |
| `2` | Tool error (missing required args, unsupported lockfile, git ref could not be resolved, lockfile read or parse failure, etc.). The check did not complete and no judgment about native dependency changes can be made. |

CI guardrails should treat `1` and `2` differently: `1` means "real native change to confirm", `2` means "infrastructure/usage problem to fix".

**Detection Capabilities:**

- Supports npm `package-lock.json` only.
- Yarn, Bun, and pnpm lockfiles are not parsed yet.
- Native packages are identified by reading installed `node_modules/<pkg>/package.json` and checking for top-level `"addon": true`, so run from a checkout with dependencies installed for the head under review.
- Removed lockfile packages whose `package.json` is unavailable are reported with unknown native status so reviewers can inspect them.
- Packages with unreadable metadata are reported as warnings only when native addon changes are also reported.

### `verify bundle`

Verify that every native Bare addon reachable from a generated worker bundle or
an installed `node_modules` tree has prebuilds for the requested host(s) and a
declared `engines.bare` range compatible with the installed Bare runtime.

```bash
qvac verify bundle --addons-source <path> --host <target> [--host <target>...] [options]
```

`--addons-source` may be either a `qvac/worker.bundle.js` produced by
`qvac bundle sdk` or a `node_modules` directory. The source kind is detected
automatically: files are parsed as bare-pack bundles, directories are walked
as `node_modules` trees.

**Options:**

| Flag | Description |
|------|-------------|
| `--addons-source <path>` | Required. Path to a `worker.bundle.js` or a `node_modules` directory. |
| `--host <target>` | Repeatable. At least one host required. Examples: `android-arm64`, `ios-arm64`, `ios-arm64-simulator`, `ios-x64-simulator`, `darwin-arm64`, `linux-x64`, `win32-x64`. |
| `--bare-runtime-version <semver>` | Optional. Override the resolved Bare runtime version used for ABI checks. **Recommended for mobile / Expo CI**, where the BareKit-embedded runtime version is not currently exposed by `react-native-bare-kit` package metadata and auto-detection is unreliable. Also useful for Electron packaging where runtime inference is ambiguous. |
| `--config, -c <path>` | Optional. Path to a `qvac.config.*` file (default: auto-detect `qvac.config.{json,js,mjs,ts}` in the project root). Reads `bareRuntimeVersion` if present. |
| `--project-root <path>` | Optional. Project root used to resolve bundle resolutions and detect the installed Bare runtime (default: cwd). |
| `--json` | Optional. Output the verification result as JSON instead of the human-readable summary. Useful for CI scripts and downstream tooling. |
| `--quiet, -q` | Suppress the success summary; failures and warnings are always printed. Ignored when `--json` is set. |

**Examples:**

```bash
# Mobile bundle, runs after `qvac bundle sdk` writes qvac/worker.bundle.js
qvac verify bundle --addons-source qvac/worker.bundle.js \
  --host android-arm64 \
  --host ios-arm64 \
  --host ios-arm64-simulator \
  --host ios-x64-simulator

# Desktop / Electron dev tree
qvac verify bundle --addons-source ./node_modules \
  --host darwin-arm64 --host linux-x64 --host win32-x64

# Packaged Electron app (validates what actually ships)
qvac verify bundle \
  --addons-source dist/mac-arm64/MyApp.app/Contents/Resources/app.asar.unpacked/node_modules \
  --host darwin-arm64

# Force a specific runtime version (e.g. CI)
qvac verify bundle --addons-source qvac/worker.bundle.js \
  --host android-arm64 --bare-runtime-version 1.15.2

# Pin via qvac.config.json (committed with the project)
# {
#   "plugins": ["llamacpp-completion"],
#   "bareRuntimeVersion": "1.15.2"
# }
qvac verify bundle --addons-source qvac/worker.bundle.js \
  --host android-arm64

# Structured output for CI consumers
qvac verify bundle --addons-source qvac/worker.bundle.js \
  --host darwin-arm64 --json | jq '.issues[] | select(.level == "error")'
```

**Exit codes:**

| Exit | Meaning |
|------|---------|
| `0` | No error-level issues. All required prebuilds are present, and every ABI check that *ran* passed. Warnings may indicate skipped checks or surfaced metadata problems: `unknown-runtime-version`, `malformed-engines-bare`, `invalid-package-json`, `empty-bundle-resolutions`, or `config-load-failed`. |
| `1` | At least one error-level issue: `missing-prebuild`, `abi-mismatch`, `invalid-runtime-version` (malformed `--bare-runtime-version` or config `bareRuntimeVersion`), or `invalid-source`. Prebuild checks always run regardless of runtime parse failures, so a typo in `--bare-runtime-version` cannot hide a real `missing-prebuild`. |

**Issue codes:**

| Code | Level | Meaning |
|------|-------|---------|
| `missing-prebuild` | error | The addon's `<packageRoot>/prebuilds/<host>/*.bare` directory is missing or empty. |
| `abi-mismatch` | error | The addon's declared `engines.bare` range does not include the resolved runtime version. |
| `unknown-runtime-version` | warning | At least one addon declares `engines.bare`, but no Bare runtime version could be auto-detected. Pass `--bare-runtime-version` to enable strict ABI verification. |
| `invalid-runtime-version` | error | The value passed via `--bare-runtime-version` or via the config `bareRuntimeVersion` field is not a valid semver. An invalid explicit version is rejected as an error (vs. auto-detection failure, which is only a warning) because the user opted into runtime verification. ABI resolution is skipped, but prebuild checks still run. |
| `malformed-engines-bare` | warning | An addon's `package.json` declares an `engines.bare` value that is not a valid semver range. ABI check is skipped for that addon and warning is surfaced for escalation to the addon maintainer. |
| `invalid-package-json` | warning | An addon `package.json` could not be parsed (malformed JSON, non-object root, missing `name` on an `addon: true` package). The package is treated as a non-addon and its prebuilds/ABI cannot be verified. |
| `empty-bundle-resolutions` | warning | The `--addons-source` bundle has an empty bare-pack resolutions table. The verifier cannot inspect any addons; a "passed" summary would be vacuous. Regenerate the bundle or check for corruption. |
| `config-load-failed` | warning | An auto-detected `qvac.config.*` exists but failed to load (syntax error, throwing import, etc.). The project-pinned `bareRuntimeVersion` is being ignored. Fix the config or pass `--config` explicitly to escalate to an error. |
| `invalid-source` | error | `--addons-source` does not point to a readable bundle or directory, `--host` was empty, or an explicit `--config` path could not be loaded. |

**Bare runtime detection:**

Runtime resolution order:

1. `--bare-runtime-version <semver>` (authoritative — user-provided).
2. `bareRuntimeVersion` field in `qvac.config.{json,js,mjs,ts}` (auto-detected from `--project-root`, or supplied via `--config`). Committed and shared across the team.
3. `<projectRoot>/node_modules/bare-runtime/package.json` — `version` field (Pear / Electron / desktop Node).
4. `<projectRoot>/node_modules/bare/package.json` — `version` field (standalone Bare installs).

If neither installed package resolves, ABI checks emit a single
`unknown-runtime-version` warning and the exit code stays `0`. Prebuild checks
always run regardless of runtime detection.

**Mobile / Expo:** the BareKit-embedded runtime version is not currently
exposed by `react-native-bare-kit` package metadata (no `engines.bare`,
`bareVersion`, or equivalent field), so auto-detection cannot establish the
on-device runtime version from a mobile dependency tree. **Pass
`--bare-runtime-version <semver>` explicitly in mobile CI** to guarantee
strict ABI verification; otherwise mobile bundles will emit
`unknown-runtime-version` and skip the ABI check pass.

### `serve openai`

Run an **OpenAI-compatible HTTP server** backed by locally configured QVAC models (`serve.models` in `qvac.config.*`).

```bash
qvac serve openai [options]
```

See **[docs/serve-openai.md](./docs/serve-openai.md)** for supported `/v1/...` routes, multipart request shapes, and how to register models — including **`whispercpp-audio-translation`** for `POST /v1/audio/translations` (Whisper translate-to-English), the volatile **`POST /v1/responses`** Responses API with `previous_response_id` chaining, the diffusion-backed **`POST /v1/images/generations`** / **`POST /v1/images/edits`** routes (use `--public-base-url <origin>` to enable `response_format=url` responses backed by `GET /v1/files/{id}/content`), and **`POST /v1/audio/speech`** (Chatterbox / Supertonic TTS — `wav` + `pcm` natively, plus `mp3` / `opus` / `aac` / `flac` when `ffmpeg` is on the server's `PATH` — with a `serve.openai.audio.speech.voices` map from OpenAI voice → model alias, and the `GET /v1/audio/voices` / `GET /v1/audio/models` discovery endpoints).

## Configuration

The CLI reads configuration from `qvac.config.{json,js,mjs,ts}` in your project root.

If no config file is found, the CLI bundles all built-in plugins.

> **Note:** `qvac.config.ts` is supported via `tsx` internally (no user setup required).

This file is primarily the SDK runtime config, but `qvac bundle sdk` also reads this **bundler-only** key (ignored by the SDK at runtime):

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `plugins` | `string[]` | No | Module specifiers, each ending with `/plugin` (defaults to all built-in plugins) |

> **Custom plugin contract:** custom `*/plugin` modules must **default-export** the plugin object.

**Built-in plugins:**

```
@qvac/sdk/llamacpp-completion/plugin
@qvac/sdk/llamacpp-embedding/plugin
@qvac/sdk/whispercpp-transcription/plugin
@qvac/sdk/parakeet-transcription/plugin
@qvac/sdk/nmtcpp-translation/plugin
@qvac/sdk/onnx-tts/plugin
@qvac/sdk/onnx-ocr/plugin
@qvac/sdk/sdcpp-generation/plugin
```

**Example configurations:**

```json
// qvac.config.json - LLM only
{
  "plugins": [
    "@qvac/sdk/llamacpp-completion/plugin"
  ]
}
```

```json
// qvac.config.json - Multiple plugins
{
  "plugins": [
    "@qvac/sdk/llamacpp-completion/plugin",
    "@qvac/sdk/whispercpp-transcription/plugin",
    "@qvac/sdk/nmtcpp-translation/plugin"
  ]
}
```

## System Requirements

See [`system-requirements.md`](./system-requirements.md) for the full list of
required and recommended host dependencies. You can validate your environment
at any time with:

```bash
qvac doctor
```

## Development

**Prerequisites:**

- Node.js >= 18.0.0
- npm

The CLI depends on the published `@qvac/sdk` (`^0.12.0`), which provides the
`./commands` subpath that `bundle`/`verify` re-export and the server runtime
the `serve` commands use. A normal `npm install` pulls it from the registry —
no local SDK build is required.

**Iterating against an in-repo `@qvac/sdk` build** (e.g. when changing the SDK
and the CLI together in the monorepo, or against an SDK checked out in a
separate worktree):

```bash
# Build the SDK first (from its packages/sdk directory)
cd /path/to/qvac/packages/sdk && bun run build

# Point the CLI at the sibling SDK (../sdk) instead of the registry copy
cd packages/cli
npm run dev:link

# Sanity check: path should be inside .../qvac/packages/sdk/dist/commands/
node -e "console.log(require.resolve('@qvac/sdk/commands'))"
```

Before committing, restore the committed `package.json`:

```bash
npm run dev:unlink
```

This runs `git checkout HEAD -- package.json` and re-installs, so the
committed `@qvac/sdk` dependency (`^0.12.0`) is restored regardless of what you
swapped in locally. `package-lock.json` is gitignored and is regenerated by the
trailing `npm install`.

**How CI tests the CLI/SDK pair** (SDK Pod Checks):

- PRs into `main` (and `feature-*` / `tmp-*`) build and test the CLI against the
  **in-repo SDK** — the source that will ship. CI runs the
  `sdk-source:workspace` script (builds `packages/sdk` and links it via
  `npm install ../sdk`), so a CLI change can rely on unreleased SDK code without
  a published version or any type cast.
- PRs into `release-cli-*` test against **both** the in-repo SDK and the
  `package.json`-pinned **published** SDK. Both must pass: the published leg
  proves the CLI works against the exact SDK version it will ship against. If it
  fails, widen the committed `@qvac/sdk` range to a published version that
  carries the API the CLI now needs.

The committed `@qvac/sdk` range is never changed for testing — the in-repo link
is a CI-time/local-only override (`sdk-source:workspace` / `dev:link`), never
committed.

**Run locally:**

```bash
# From packages/cli after a build
npm run build
node ./dist/index.js bundle sdk

# Or link globally for testing
npm link
qvac bundle sdk
```

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.
