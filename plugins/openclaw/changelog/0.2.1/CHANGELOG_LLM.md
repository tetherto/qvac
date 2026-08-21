# QVAC OpenClaw Plugin v0.2.1 Release Notes

Release Date: 2026-08-21

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.2.1

## Runs Against the CLI 0.12 Line

The plugin now requires `@qvac/cli@^0.12.0`, so the bundled `local-service.js` launcher starts a `qvac serve` on the `@qvac/sdk` 0.18.x runtime. That serve also brings the model catalog endpoint and lazy loading for models configured with `preload: false`.

Nothing changes in the plugin's own behaviour, configuration, or onboarding — no re-onboarding is needed for this release. Installs that pin `@qvac/cli` to `0.11.x` will need to move to `0.12.x` alongside the plugin, since a 0.x caret range does not cross a minor.
