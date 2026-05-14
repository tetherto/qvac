# Changelog v0.9.2

Release Date: 2026-04-30

## 🐞 Fixes

- Replace `z.xor` with `z.union` in finetune schemas and bump `zod` floor to `^4.3.0` to fix `TypeError: _zod.z.xor is not a function` for consumers whose tree resolved `zod` to a pre-4.3 version. (see PR [#1790](https://github.com/tetherto/qvac/pull/1790))
