# QVAC OpenClaw Plugin v0.4.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.4.0

The plugin now starts `qvac serve` itself and only talks to the port that serve reports, instead of asking OpenClaw's `localService` to bind port 11434. That needs `@qvac/cli` 0.16 (`--port 0 --ready-fd 3`) and `@qvac/ai-sdk-provider` 0.10, so the dependency floors move with it. Existing installs must re-onboard once.

## Breaking Changes

### Plugin-owned serve

Earlier releases asked OpenClaw's `localService` to start `qvac serve` on port `11434`. OpenClaw probes that port with the bearer key before it starts anything, so another local process holding the port received the key and the prompts. The plugin now starts the serve itself and connects to the port the serve reports.

**Before:** `models.providers.qvac` in `openclaw.json` used a loopback URL and a `localService` health check:

```json
{
  "baseUrl": "http://127.0.0.1:11434/v1",
  "localService": {
    "healthUrl": "http://127.0.0.1:11434/v1/models"
  }
}
```

**After:** re-run onboarding so the provider entry points at a placeholder URL and the plugin owns the serve:

```bash
openclaw onboard --auth-choice provider-plugin:qvac
```

```json
{ "baseUrl": "http://qvac.invalid/v1" }
```

Until you re-onboard, the provider entry still declares `localService`, and every QVAC request fails with a message that the entry was created by an older plugin version. Disabling or removing the plugin does not remove that entry, so re-onboard or delete `models.providers.qvac` rather than leaving it behind.

### Requires the @qvac/cli 0.16 line

`@qvac/cli` 0.16 is required for `--port 0 --ready-fd 3`. Installs that pin `@qvac/cli` to `0.15.x` must move to `0.16.x` alongside the plugin, since a 0.x caret range does not cross a minor. `@qvac/ai-sdk-provider` moves to `^0.10.0` in the same step; provider 0.10 narrows its optional `@qvac/cli` peer to `^0.16.0`.

**Before:**

```json
{
  "dependencies": {
    "@qvac/ai-sdk-provider": "^0.9.0",
    "@qvac/cli": "^0.15.0"
  }
}
```

**After:**

```json
{
  "dependencies": {
    "@qvac/ai-sdk-provider": "^0.10.0",
    "@qvac/cli": "^0.16.0"
  }
}
```

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.10.0` for the shared model catalog
- `@qvac/cli@^0.16.0` for `qvac serve --openai --no-default` with `--port 0 --ready-fd 3`

The `openclaw` host peer is unchanged at `>=2026.6.0`. The published plugin manifest version is now 0.4.0, matching the package.
