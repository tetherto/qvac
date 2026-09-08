# QVAC OpenClaw Plugin v0.2.1 Release Notes

Release Date: 2026-08-21

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.2.1

## Switching Models No Longer Fails

The plugin's own code is unchanged, but moving to `@qvac/cli@^0.12.0` fixes a user-visible problem in how it runs.

The launcher writes every model in the QVAC catalog into the serve config, and marks only your selected model `preload: true`. On the CLI 0.11 line a `preload: false` model was registered but never loaded, so picking any other model in OpenClaw returned `503 model_not_ready` — permanently, until you changed the configured model and restarted. CLI 0.12 loads such a model on first request instead, so every model in the picker now works; the first turn after switching waits for a cold load, and later turns are fast.

## Runs Against the CLI 0.12 Line

The bundled `local-service.js` launcher now starts a `qvac serve` on the `@qvac/sdk` 0.18.x runtime, which also brings the serve model catalog endpoint.

Configuration and onboarding are unchanged — no re-onboarding is needed for this release. Installs that pin `@qvac/cli` to `0.11.x` will need to move to `0.12.x` alongside the plugin, since a 0.x caret range does not cross a minor.
