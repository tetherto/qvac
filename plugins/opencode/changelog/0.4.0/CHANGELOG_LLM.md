# QVAC OpenCode Plugin v0.4.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.4.0

This release moves the plugin to the OpenCode 2.x plugin API. OpenCode 2.x does not run V1 plugins, so 0.3.x does nothing there; 0.4.0 restores the managed `qvac serve`, the `qvac` provider and the default model on OpenCode 2.x. It also adds `serveBinPath`, for running the serve through your own `qvac` executable.

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
