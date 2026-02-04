## 🎯 What problem does this PR solve?

- Redesigns completion API

## 📝 How does it solve it?

- Changed return type

## 💥 Breaking Changes

```typescript
// old
const result = completion(options);

// new
const { response, tokenStream } = completion(options);
```

