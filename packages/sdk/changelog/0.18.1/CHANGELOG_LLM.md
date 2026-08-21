# QVAC SDK v0.18.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.18.1

QVAC SDK 0.18.1 adds human-readable descriptions on every llamacpp `modelConfig` field and exports those schemas from `@qvac/sdk/schemas`. CLI, typed-client, and Python generators can now surface what each completion and embedding option means. The CosyVoice3 companion-set cache key also changes, so the first load after upgrade uses a new companion cache folder. Load APIs are otherwise unchanged.

## New APIs

### Config schemas at `@qvac/sdk/schemas`

`@qvac/sdk/schemas` exports `llamacppCompletionConfigSchema`, `llamacppEmbeddingConfigSchema`, and `modelSourceSchema`. Field `.describe()` text comes from the addon README / `index.d.ts` (or an existing SDK description) and is written into `contract/schema.json`. The same descriptions land on the generated Python pydantic fields.

```typescript
import { llamacppCompletionConfigSchema } from '@qvac/sdk/schemas'

llamacppCompletionConfigSchema.shape.ctx_size.description
// "Context window size in tokens; `0` uses the model's trained context length. Default 1024."
```

The internal schema identifiers are unchanged.

## Bug Fixes

### CosyVoice3 companion cache folder

CosyVoice3 companion files still download with the LLM, as in 0.18.0. The companion-set cache key for `TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0` changed, so the first load after upgrading fills a new cache folder. Later loads reuse that folder. Speech APIs and `pace` / `instruct` rules are unchanged.
