# SDK v0.8.0

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.8.0

This release adds support for pivot translations in the Bergamot engine, enabling translation between language pairs that don't have direct models by using an intermediate language (typically English).

---

## ✨ What's New

### Pivot Translation Support

The SDK now supports **pivot translations** for the Bergamot translation engine. This powerful feature allows you to translate between language pairs even when a direct translation model isn't available, by automatically routing through an intermediate language.

**Example: Spanish to Italian via English**
```typescript
import { loadModel, translate } from "@qvac/sdk";

// Load Spanish to English as the primary model
// and English to Italian as the pivot model
const modelId = await loadModel({
  modelSrc: BERGAMOT_ES_EN,
  modelType: "translation",
  modelConfig: {
    engine: "Bergamot",
    pivotModel: {
      modelSrc: BERGAMOT_EN_IT,
    }
  }
});

// Translates Spanish → English → Italian automatically
const result = await translate({
  modelId,
  text: "Hola mundo"
});
// Result: "Ciao mondo"
```

### Enhanced Logging for Pivot Models

Model registration now provides clearer logging when pivot models are loaded, showing both the primary and pivot model names:

```
Local model registered: abc123 (Spanish to English via English to Italian) -> /path/to/model
```

This makes it easier to debug and understand which models are being used in your translation pipeline.

---

## 🔧 Technical Improvements

- Added `pivotModelName` parameter throughout the model loading pipeline
- Enhanced model registry to track and display pivot model information
- Improved model name extraction for both primary and pivot models
- Better logging clarity for complex translation workflows

---

## 📝 Migration Guide

This release is fully backward compatible. No changes are required to existing code.

To start using pivot translations, simply add a `pivotModel` configuration when loading a Bergamot translation model:

```typescript
modelConfig: {
  engine: "Bergamot",
  pivotModel: {
    modelSrc: BERGAMOT_EN_XX, // Your pivot model
    // Optional: pivot model specific parameters
    beamsize: 4,
    temperature: 0.3
  }
}
```

---

## 📚 Documentation

For more examples and detailed documentation on pivot translations, see the [translation examples](https://github.com/qvac/qvac/tree/main/packages/sdk/examples/translation) in the SDK repository.