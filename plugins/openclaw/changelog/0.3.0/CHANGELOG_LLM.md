# QVAC OpenClaw Plugin v0.3.0 Release Notes

Release Date: 2026-09-07

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.3.0

The launcher moves onto the CLI 0.13 launch interface. `@qvac/cli` 0.13 mounts the serve surfaces as extensions and deprecates the `qvac serve openai` subcommand, so the plugin now starts `qvac serve --openai --no-default` and its dependency floors move with it.

## Breaking Changes

### Requires the @qvac/cli 0.13 line

The bundled `local-service.js` launcher builds the serve command itself, and that command changes:

**Before:**

```bash
qvac serve openai --config <path> --host 127.0.0.1 --port 11434 --model <id> --api-key-file <path>
```

**After:**

```bash
qvac serve --openai --no-default --config <path> --host 127.0.0.1 --port 11434 --model <id> --api-key-file <path>
```

Installs that pin `@qvac/cli` to `0.12.x` need to move to `0.13.x` with the plugin, since a 0.x caret range does not cross a minor.

`--no-default` is part of the pair rather than an extra flag. Bare `--openai` would also mount the QVAC surface on the port, while the deprecated subcommand exposed `/v1/*` alone — keeping both preserves the previous behaviour and keeps the extra surface off a port the plugin authenticates and owns.

### @qvac/ai-sdk-provider moves to 0.7

Provider 0.7 narrows its own optional `@qvac/cli` peer to `^0.13.0`, so the two floors have to move together: a plugin still asking for `@qvac/cli@^0.12.0` next to provider 0.7 would leave the install unresolvable. The plugin uses the provider for the shared model catalog only — it drives its own launcher rather than the provider's managed serve — so nothing else about that dependency changes here.

Provider 0.7 also carries the streamed file-upload fixes released in 0.6.2.

## Upgrading

No re-onboarding is needed. The argument list onboarding persists in `openclaw.json` holds only the plugin's own options — `--api-key-file`, `--model`, `--host`, `--port` and the rest — and the serve command is assembled at start time, so an existing provider entry keeps working. Configuration, the key file and your model choice are all untouched.

The `openclaw` host peer is unchanged at `>=2026.6.0`.

## Requirements

- `@qvac/ai-sdk-provider@^0.7.0` for the shared model catalog
- `@qvac/cli@^0.13.0` for `qvac serve --openai --no-default`
- `openclaw >=2026.6.0` as the optional host peer
