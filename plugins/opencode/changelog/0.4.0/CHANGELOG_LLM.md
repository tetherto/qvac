# QVAC OpenCode Plugin v0.4.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.4.0

This release moves the plugin to the OpenCode 2.x plugin API. OpenCode 2.x does not run V1 plugins, so 0.3.x does nothing there; 0.4.0 restores the managed `qvac serve`, the `qvac` provider and the default model on OpenCode 2.x. It also adds `serveBinPath`, for running the serve through your own `qvac` executable, and moves the plugin onto `@qvac/cli` 0.19 and `@qvac/ai-sdk-provider` 0.12.

## Breaking Changes

### OpenCode 2.x Only, With the New Plugin Config Shape

0.4.0 requires OpenCode 2.x. OpenCode 1.x skips it with a version message, so stay on the 0.3 line there by pinning `@qvac/opencode-plugin@0.3`.

Plugins are now listed under `plugins`, and each entry is an object with `package` and `options` instead of a `[name, options]` tuple.

**Before:**

```json
{ "plugin": [["@qvac/opencode-plugin", { "model": "qwen3.5-2b" }]] }
```

**After:**

```json
{
  "plugins": [{ "package": "@qvac/opencode-plugin", "options": { "model": "qwen3.5-2b" } }]
}
```

`setDefaultModel` now sets only the default model. OpenCode 2.x has no small-model setting for plugins.

### The Managed Serve Stops With the Project

The plugin no longer installs its own `SIGINT`, `SIGTERM` and exit handlers. OpenCode stops the managed `qvac serve` when it unloads the project: after 60 minutes without session activity (`experimental.location_idle_timeout`), or when the OpenCode service stops.

### Dependency Alignment

Installs now resolve `@qvac/cli@^0.19.0` and `@qvac/ai-sdk-provider@^0.12.0`, so the managed serve runs CLI 0.19. A 0.x caret range does not cross a minor, so a project pinned to CLI 0.18 has to move with the plugin.

## New APIs

### Run the Serve Through Your Own Executable

The `serveBinPath` option, or the `QVAC_SERVE_BIN_PATH` environment variable, points the managed serve at an absolute path to a `qvac` executable instead of the bundled `@qvac/cli`. Use it to wrap the serve, for example to capture its output.

```json
{
  "plugins": [
    {
      "package": "@qvac/opencode-plugin",
      "options": { "serveBinPath": "/abs/path/qvac-serve-wrapper.sh" }
    }
  ]
}
```

```bash
QVAC_SERVE_BIN_PATH=/abs/path/qvac-serve-wrapper.sh opencode
```

The path must be absolute, and an empty value keeps the bundled CLI. With `serveBinPath` set, the serve key is passed on the command line as `--api-key`, since a custom executable may not support `--api-key-file`. Other local users can read it there, so use this only on single-user machines such as CI runners.

## Features

The models the plugin registers with OpenCode now declare text input and output with tool support, a context limit equal to the configured context size, and an output limit of 32,000 tokens or the context size when that is smaller.

## Documentation

The README's shutdown description and the model catalog's default port (11435, the `qvac serve` default since CLI 0.19) are corrected.
