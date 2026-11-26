# QVAC OpenClaw Plugin v0.5.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.5.1

This patch corrects the install command in the README, which fails on OpenClaw 2026.11.5 and newer, and aligns the plugin's dependency ranges with `@qvac/cli` 0.21 and `@qvac/ai-sdk-provider` 0.13. Plugin code is unchanged.

## Bug Fixes

### The documented install command works on OpenClaw 2026.11.5 and newer

OpenClaw 2026.11.5 resolves a bare package name on ClawHub only. The plugin is published to npm, so the install command in the README failed with `Package not found on ClawHub.` The README now uses the `npm:` prefix.

**Before:**

```bash
openclaw plugins install @qvac/openclaw-plugin --force --accept-capabilities
```

**After:**

```bash
openclaw plugins install npm:@qvac/openclaw-plugin --force --accept-capabilities
```

## Dependency Alignment

Installs now resolve `@qvac/ai-sdk-provider@^0.13.0` and `@qvac/cli@^0.21.0`. A 0.x caret range does not cross a minor, so the 0.5.0 ranges would not install CLI 0.21 or provider 0.13.
