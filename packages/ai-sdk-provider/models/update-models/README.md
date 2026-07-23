# `@qvac/ai-sdk-provider` — model registry codegen

Build-time tooling that queries the QVAC P2P model registry via `@qvac/registry-client` and regenerates the typed model catalog at `packages/ai-sdk-provider/src/models/constants.ts`.

This folder is **never bundled** into the published `@qvac/ai-sdk-provider` package. It lives next to the package source so we can adapt it as the SDK's registry evolves, but the only output that reaches consumers is the committed `src/models/constants.ts`.

## When to regenerate

- A new model lands in the production P2P registry that consumers should be able to introspect at compile time.
- An existing model's metadata changes (different blob coordinates, new quantization variant, renamed registry path).
- The SDK adds a new engine / addon in `packages/sdk/schemas/engine-addon-map.ts` — also update [`schemas.ts`](./schemas.ts) here to keep the codegen in lockstep.
- Before cutting a `@qvac/ai-sdk-provider` release.

## How to regenerate

From the package root (`packages/ai-sdk-provider/`):

```bash
# Dry-run: compare what's in the live registry vs the committed constants.ts
bun run check-models

# Actually overwrite src/models/constants.ts + write a history file
bun run update-models
```

Both commands invoke `tsx ./models/update-models/index.ts` with the relevant flag. `check-models --non-blocking` is also wired for use in pre-commit hooks that should warn (not fail) when the catalog drifts.

### Flags

- `--check` — read-only diff; sets the exit code so CI can fail on drift.
- `--non-blocking` — paired with `--check`; always exit 0 (warning mode).
- `--show-duplicates` — log the sha256 collisions that dedup is filtering out.
- `--no-dedup` — emit every registry entry even when sha256 collides (debugging).

### Environment

- `QVAC_REGISTRY_CORE_KEY` — override the registry Hyperdrive core key. Defaults to the production key defined in [`schemas.ts`](./schemas.ts) (`DEFAULT_REGISTRY_CORE_KEY`); set this to point at a staging registry when validating a new model before it ships to prod.

## What gets generated

`bun run update-models` overwrites `packages/ai-sdk-provider/src/models/constants.ts` with one entry per model that has an OpenAI-shaped endpoint category. Each entry is emitted as:

- An item in the `allModels` array (full metadata, `as const` for literal types).
- A named export typed `ModelConstant<TEndpoint>` where `TEndpoint` is narrowed to `'chat' | 'embedding' | 'transcription' | 'audio-translation' | 'translation' | 'speech' | 'ocr' | 'image'` (see [`src/models/types.ts`](../../src/models/types.ts)).

```ts
export const allModels = [
  { name: 'QWEN3_4B_INST_Q4_K_M', endpointCategory: 'chat' /* ... */ } as const,
  { name: 'WHISPER_EN_TINY_Q8_0', endpointCategory: 'transcription' /* ... */ } as const
] as const

export const QWEN3_4B_INST_Q4_K_M: ModelConstant<'chat'> = allModels[0]
export const WHISPER_EN_TINY_Q8_0: ModelConstant<'transcription'> = allModels[1]
```

The companion file at `models/history/<short-sha>.txt` records what the regeneration added / updated / removed relative to the previous commit, so reviewers can see the catalog delta without diffing the (potentially massive) generated `constants.ts`.

### Models that get skipped

- `addon: 'vad'` and `addon: 'other'` have no endpoint in the OpenAI HTTP surface, so the codegen filters them out (logged with `⏭️ Skipped …`). They still exist in the P2P registry and remain reachable via `@qvac/sdk` directly.
- Models flagged as `isCompanionOnly` (e.g. ONNX `_data` files, Bergamot vocab / lex / metadata pairs) are emitted in `allModels` for completeness but don't get a top-level named export — the primary file in the companion set owns the export.

## How it relates to the SDK's codegen

The structure mirrors `packages/sdk/models/update-models/` deliberately so the two stay diff-able. Differences worth knowing:

- **Output location**: this codegen writes to `src/models/constants.ts`; the SDK's writes to `models/registry/models.ts`.
- **Type system**: this codegen emits `ModelConstant<TEndpoint>` (narrowed by endpoint category — chat / embedding / etc.); the SDK's emits `ModelConstant<TEngine>` (narrowed by canonical engine name — llamacpp-completion / whispercpp-transcription / etc.). The provider package consumers think in terms of OpenAI endpoint categories, not raw engines.
- **Schema dependencies**: the SDK's codegen imports `@/schemas/registry` / `@/schemas/engine-addon-map` / `@/constants` directly. This package can't reach into the SDK's source at build time, so the relevant constants and helpers are reproduced in [`schemas.ts`](./schemas.ts). **Keep them in lockstep with the SDK** when new engines / addons / legacy aliases land there.

## Dependencies

Only `@qvac/registry-client` (devDependency) is required at regen time. The codegen runs via `tsx` (also a devDep). Neither leaks to runtime — published consumers see only the generated `constants.ts` + the package's small runtime surface.
