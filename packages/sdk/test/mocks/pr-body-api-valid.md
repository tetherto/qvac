## 🎯 What problem does this PR solve?

- Adds streaming support for completions

## 📝 How does it solve it?

- Added tokenStream property

## 🔌 API Changes

```typescript
// New completion API with streaming support
for await (const token of completion({
  modelId,
  history: [{ role: "user", content: "Hello!" }],
}).tokenStream) {
  process.stdout.write(token);
}
```

