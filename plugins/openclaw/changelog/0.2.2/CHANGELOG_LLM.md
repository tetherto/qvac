# QVAC OpenClaw Plugin v0.2.2 Release Notes

Release Date: 2026-09-04

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.2.2

OpenClaw moved its `latest` release to 2026.8.1, which changed three of the commands a QVAC install depends on and removed two type entry points the plugin imported. This patch brings the documented commands, the launcher's own error messages, and the plugin's type surface back in line with it. Nothing in your configuration changes, and no dependency floors move.

## Setup Commands Changed in OpenClaw 2026.8.1

Installing a plugin now asks for trust and for capability consent, and plugin-contributed auth choices are namespaced behind a `provider-plugin:` prefix. Every documented invocation moves:

| Before                       | 2026.8.1 and later                                     |
| ---------------------------- | ------------------------------------------------------ |
| `plugins install <spec>`     | `plugins install <spec> --force --accept-capabilities` |
| `plugins enable qvac`        | `plugins enable qvac --accept-capabilities`            |
| `onboard --auth-choice qvac` | `onboard --auth-choice provider-plugin:qvac`           |

Without the consent flags the install cancels. With the old auth choice, onboarding rejects `qvac` and lists only OpenClaw's built-in choices. The plugin still registers `choiceId: "qvac"` — OpenClaw namespaces plugin-contributed choices now, so it is the invocation that moves, not the plugin.

The plugin supports `openclaw >=2026.6.0`, so the README documents both forms rather than replacing one with the other. On openclaw before 2026.8.1, drop the two consent flags and use the bare `--auth-choice qvac`.

## Launcher Errors Name a Command That Works

Two failures in the local service told you to recover by running `openclaw onboard --auth-choice qvac` — a command 2026.8.1 rejects, leaving you with an error whose remedy also failed:

- A provider entry created before the managed serve required bearer authentication, whose persisted `localService.args` has no `--api-key-file` value.
- A QVAC key file whose permissions have drifted so it is readable beyond its owner.

Both now name the `provider-plugin:qvac` form first, with the pre-2026.8.1 form alongside it.

## Builds Against OpenClaw 2026.8.1 Again

2026.8.1 dropped `plugin-sdk/config-types` from its exports map and left `plugin-sdk/provider-model-shared` without type declarations, so `SecretProviderConfig` and `ModelProviderConfig` could no longer be imported by name and the plugin failed to typecheck and build against it.

Both are now derived from `OpenClawConfig`, which is exported with types from `plugin-sdk/plugin-entry` — already the entry the plugin imports `definePluginEntry` from. These are type-only imports, so the emitted JavaScript is unchanged.

## Requirements

Unchanged from 0.2.1: `@qvac/ai-sdk-provider@^0.6.0` for the shared model catalog, `@qvac/cli@^0.12.0` for `qvac serve`, and `openclaw >=2026.6.0` as the optional host peer.
