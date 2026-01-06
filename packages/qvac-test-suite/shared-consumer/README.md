# Shared Consumer Logic

Shared code between desktop and mobile test consumers.

## Files

- `consumer-base.ts` - Base class (MQTT, test execution, model management)
- `types.ts` - TypeScript interfaces

## Structure

Consumers extend `ConsumerBase` and implement platform-specific model loading:

```typescript
class MobileConsumer extends ConsumerBase {
  protected async loadLlmModel() { /* Platform-specific */ }
  protected async loadWhisperModel() { /* Platform-specific */ }
  protected async loadEmbeddingModel() { /* Platform-specific */ }
}
```

