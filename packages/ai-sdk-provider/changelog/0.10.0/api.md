# 🔌 API Changes v0.10.0

## Add MOSS ASR and Nemotron diarization support

PR: [#4945](https://github.com/tetherto/qvac/pull/4945)

The provider catalog adds a Nemotron 3 diarization GGUF constant. MOSS transcribe/diarize catalog names live on `@qvac/sdk`, not this package.

```typescript
import { PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0 } from '@qvac/ai-sdk-provider/models'
```

```
PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0
```

---

## Verify the managed serve before sending it the key

PR: [#5024](https://github.com/tetherto/qvac/pull/5024)

```typescript
import { CliUpgradeRequiredError } from '@qvac/ai-sdk-provider'

try {
  await startManagedQvac({ model: 'qwen3.5-9b' })
} catch (err) {
  if (err instanceof CliUpgradeRequiredError) {
    // err.code === 'CLI_UPGRADE_REQUIRED': install @qvac/cli >= 0.16.0
  }
}
```

---
