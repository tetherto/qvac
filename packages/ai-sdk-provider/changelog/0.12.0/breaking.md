# 💥 Breaking Changes v0.12.0

## Point EmbeddingGemma-300M constants at the Dense-layer models

PR: [#5634](https://github.com/tetherto/qvac/pull/5634)

`EMBEDDINGGEMMA_300M_F32` is removed. `EMBEDDINGGEMMA_300M_BF16`, `EMBEDDINGGEMMA_300M_Q4_0` and `EMBEDDINGGEMMA_300M_Q8_0` keep their names but now resolve to the Dense-layer model files. Embeddings from the updated constants differ from those of the old files, so re-ingest any RAG workspace that was built with an earlier EmbeddingGemma-300M constant.

**BEFORE:**

```typescript
import { models } from '@qvac/ai-sdk-provider'

models.EMBEDDINGGEMMA_300M_F32
```

**AFTER:**

```typescript
import { models } from '@qvac/ai-sdk-provider'

models.EMBEDDINGGEMMA_300M_BF16
```

---

## Requires `@qvac/cli` 0.19, which serves on port 11435

PR: [#5695](https://github.com/tetherto/qvac/pull/5695)

The `@qvac/cli` peer range is now `^0.19.0`, so an install pinned to CLI 0.18 no longer satisfies it.

The provider's default `baseURL` is unchanged at `http://127.0.0.1:11435/v1`. What changes is that `qvac serve` in CLI 0.19 listens on 11435 by default, so the two now agree without configuration. If you passed `baseURL` or `--port` to line them up, you can drop it.

**BEFORE:**

```typescript
// CLI 0.18: qvac serve --openai listens on 11434
const qvac = createQvac({ baseURL: 'http://127.0.0.1:11434/v1' })
```

**AFTER:**

```typescript
// CLI 0.19: qvac serve --openai listens on 11435, the provider's default
const qvac = createQvac()
```

Against a server on another port, including `@qvac/cli` 0.18 or earlier on 11434, keep passing `baseURL`.

---
