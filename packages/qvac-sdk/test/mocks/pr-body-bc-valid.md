## 🎯 What problem does this PR solve?

- Redesigns loadModel API for better type safety

## 📝 How does it solve it?

- Added modelType parameter

## 💥 Breaking Changes

**BEFORE:**

```typescript
const model = await loadModel("model-path");
```

**AFTER:**

```typescript
const modelId = await loadModel("model-path", { modelType: "llm" });
```

