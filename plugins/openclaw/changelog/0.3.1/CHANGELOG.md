# Changelog v0.3.1

Release Date: 2026-09-07

## Fixes

- Stop generating QVAC API keys that the plugin's own validator rejects. A base64url draw beginning with `-` was refused by `normalizeApiKey`, so roughly one onboarding in 64 produced a key file the launcher would not accept.
