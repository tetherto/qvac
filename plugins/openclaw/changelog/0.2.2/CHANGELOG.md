# Changelog v0.2.2

Release Date: 2026-09-08

## 🐞 Fixes

- Adapt the openclaw integration to 2026.8.1 (smoke, docs, plugin messages). (see PR [#4192](https://github.com/tetherto/qvac/pull/4192))
- Stop generating QVAC API keys that the plugin's own validator rejects. A base64url draw beginning with `-` was refused by `normalizeApiKey`, so roughly one onboarding in 64 produced a key file the launcher would not accept.
