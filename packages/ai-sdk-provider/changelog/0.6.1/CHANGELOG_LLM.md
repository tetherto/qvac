# QVAC AI SDK Provider v0.6.1 Release Notes

Release Date: 2026-08-21

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.6.1

## Managed Mode Supports CLI 0.12

`@qvac/ai-sdk-provider` now accepts the `@qvac/cli` `0.12.x` line alongside `0.10.x` and `0.11.x` as its optional managed-mode CLI peer. This lets strict package managers install the provider next to CLI 0.12, which brings in the `@qvac/sdk` 0.18.x runtime and the serve model catalog.

The older lines remain accepted, so existing installs are unaffected. No provider API changes are included in this patch release.
