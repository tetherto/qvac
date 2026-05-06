# QVAC SDK v0.9.2 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.9.2

Hotfix patch release. Single-fix patch — no API, behavioral, or model changes.

---

## 🐞 Fixes

### Fix `TypeError: z.xor is not a function` for consumers on zod < 4.3

The SDK's finetune schemas used `z.xor([z.number(), z.nan()])` in 8 places, an API only available in zod ≥ 4.3.0. The package declared `"zod": "^4.0.17"`, so consumer projects whose tree resolved zod to a 4.0.x / 4.1.x / 4.2.x version crashed at runtime when finetune schemas loaded.

Two coordinated changes:

- Replaced `z.xor([z.number(), z.nan()])` with `z.union([z.number(), z.nan()])` in `packages/sdk/schemas/finetune.ts`. In zod v4, `z.number()` rejects `NaN` by default, so `z.number()` and `z.nan()` are disjoint — `z.xor` and `z.union` are semantically identical here.
- Bumped the declared `zod` floor from `^4.0.17` to `^4.3.0` to align the declared range with the version of zod the SDK is actually built and tested against.

Consumers who hit `_zod.z.xor is not a function` on `0.9.1` will be unblocked at runtime after upgrading to `0.9.2`.

See PR [#1790](https://github.com/tetherto/qvac/pull/1790) for full details and reasoning.
