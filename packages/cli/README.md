# QVAC CLI

A command-line interface for the QVAC ecosystem. QVAC CLI provides tooling for building, bundling, and managing QVAC-powered applications.

This package is published to npm as **`@qvac/cli`** and lives in the QVAC monorepo at **`packages/cli`**. Older instructions may refer to the deprecated **`qvac-cli`** package name—use **`@qvac/cli`** instead.

## Table of Contents

- [Installation](#installation)
- [Command Reference](#command-reference)
  - [`bundle sdk`](#bundle-sdk)
- [Configuration](#configuration)
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

## Command Reference

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
@qvac/sdk/nmtcpp-translation/plugin
@qvac/sdk/onnx-tts/plugin
@qvac/sdk/onnx-ocr/plugin
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

## Development

**Prerequisites:**

- Node.js >= 18.0.0
- npm or bun

**Run locally:**

```bash
# From packages/cli after a build
bun run build
node ./dist/index.js bundle sdk

# Or link globally for testing
npm link
qvac bundle sdk
```

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.
