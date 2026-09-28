# QVAC OpenClaw Plugin v0.3.3 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.3.3

This patch fixes the managed `qvac serve` failing to start on OpenClaw 2026.9.6.

## Fixes

On OpenClaw 2026.9.6, `qvac serve` failed with `Cannot find module …/plugin-captures/…/dist/local-service.js`. Onboarding had saved the launcher path from OpenClaw's per-process plugin copy, which 2026.9.6 deletes on exit. The path now comes from the plugin install directory. ([#4686](https://github.com/tetherto/qvac/pull/4686))

**Re-onboard once after upgrading** so `openclaw.json` picks up the new path:

```bash
openclaw onboard --auth-choice provider-plugin:qvac
```
