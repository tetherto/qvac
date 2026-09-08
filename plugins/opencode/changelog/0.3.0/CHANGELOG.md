# Changelog v0.3.0

Release Date: 2026-08-21

## 🐞 Fixes

- Stop pinning `toolsMode: 'static'` on the managed serve's model config. The field was removed from the SDK's llamacpp schema and is now rejected rather than ignored. (see PR [#3380](https://github.com/tetherto/qvac/pull/3380)) - See [breaking changes](./breaking.md)
