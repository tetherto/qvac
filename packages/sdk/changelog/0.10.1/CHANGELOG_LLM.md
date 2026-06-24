# QVAC SDK v0.10.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.10.1

This patch release adds a new tool-call dialect for OpenAI's `gpt-oss` (Harmony) models, fixes a regression that caused Bergamot translation models to re-download their vocab files on every `loadModel`, and refreshes the model registry with updated Bergamot translation pairs and the removal of deprecated Marian Opus entries.

## New APIs

### Harmony tool-call dialect for `gpt-oss`

`completion()` now supports a fourth tool-call dialect, `"harmony"`, used by OpenAI's `gpt-oss` family of models. The new dialect is wired into the same streaming/event surface as the existing dialects (`hermes`, `pythonic`, `json`), so tool calls emitted in Harmony frames are parsed and surfaced through the standard `CompletionEvent` stream. `gpt-oss-20b-Q4_K_M` auto-routes to the Harmony dialect; the `toolDialect` parameter is available as an explicit override on any model.

```typescript
import { completion, type ToolDialect } from "@qvac/sdk";

const run = completion({
  modelId,                 // gpt-oss-20b-Q4_K_M auto-routes to "harmony"
  history,
  tools,
  toolDialect: "harmony",  // optional explicit override
});

const dialect: ToolDialect = "harmony";
// ToolDialect is now "hermes" | "pythonic" | "json" | "harmony"
```

This release also picks up `@qvac/llm-llamacpp` 0.17.2, which stops the addon from suppressing the `<|call|>` end-of-generation token — required for Harmony tool-call parsing to work end-to-end.

## Bug Fixes

### Bergamot vocab no longer re-downloaded on every `loadModel`

Bergamot translation pairs that share a vocab blob across two file paths (the same SHA-256 under different names) were being collapsed by registry deduplication, which deleted their standalone vocab entries and forced the plugin to re-download the vocab file every time a model was loaded. This release adjusts the dedup pass to preserve any registry entry that is referenced as a companion file in a companion set, restoring the seven shared-vocab entries (`BERGAMOT_FR_EN_VOCAB`, `BERGAMOT_EN_DE_VOCAB`, `BERGAMOT_EN_CS_VOCAB`, `BERGAMOT_ET_EN_VOCAB`, `BERGAMOT_FI_EN_VOCAB`, `BERGAMOT_PL_EN_VOCAB`, `BERGAMOT_PT_EN_VOCAB`) along with their correct `expectedSize`/`sha` lookups.

For `registry://` Bergamot loads with auto-derived vocabs (both non-pivot and pivot), the plugin now skips the separate per-vocab `resolveModelPath` call entirely — the companion-set download already colocates vocabs under `sets/<setKey>/`, and `createModel` derives those paths via `deriveColocatedBergamotVocabPaths`. This eliminates redundant flat-cache downloads without changing the contract for `pear://` sources or user-supplied vocab overrides, and is locked behind unit tests in `nmtcpp-resolve-vocab.test.ts`.

## Model Changes

### Updated translation pairs

`BERGAMOT_EN_IT` and `BERGAMOT_ES_EN` are bumped to the `base-memory` variant (`bergamot-enit/2026-04-28/`, `bergamot-esen/2026-04-28/`). This fixes leading `"- "` hallucinations on short inputs and an en→it quality regression that affected the previous build.

### Restored shared-vocab Bergamot entries

The vocab fix above restores seven Bergamot vocab constants that had been incorrectly removed by registry dedup:

```
BERGAMOT_EN_CS_VOCAB
BERGAMOT_EN_DE_VOCAB
BERGAMOT_ET_EN_VOCAB
BERGAMOT_FI_EN_VOCAB
BERGAMOT_FR_EN_VOCAB
BERGAMOT_PL_EN_VOCAB
BERGAMOT_PT_EN_VOCAB
```

### Removed Marian Opus models

The legacy Marian Opus translation entries are dropped from the registry. They were auto-deprecated upstream and superseded by the Bergamot family.

```
NMT_Q0F16
NMT_Q0F16_1
NMT_Q0F16_2
NMT_Q0F16_3
NMT_Q0F16_4
NMT_Q0F16_5
NMT_Q0F16_6
NMT_Q0F16_7
NMT_Q0F16_8
NMT_Q0F16_9
NMT_Q4_0
NMT_Q4_0_1
NMT_Q4_0_2
NMT_Q4_0_3
NMT_Q4_0_4
NMT_Q4_0_5
NMT_Q4_0_6
NMT_Q4_0_7
NMT_Q4_0_8
NMT_Q4_0_9
NMT_Q4_0_10
NMT_Q4_0_11
NMT_Q4_0_12
NMT_Q4_0_13
NMT_Q4_0_14
NMT_Q4_0_15
NMT_Q4_0_16
NMT_Q4_0_17
NMT_Q4_0_18
NMT_Q4_0_19
NMT_Q4_0_20
NMT_Q4_0_21
```

If you were importing any of these constants, switch to the equivalent `BERGAMOT_*` pair.
