# 🔌 API Changes v0.4.0

## Authenticate managed serves automatically

Managed providers now generate and own a random API key for each serve fleet. Provider requests apply the live key automatically, including after crash recovery.

Trusted in-process adapters can read the current key from the non-enumerable `provider.apiKey` getter:

```ts
const response = await fetch(`${provider.baseURL}/models`, {
  headers: { authorization: `Bearer ${provider.apiKey}` }
})
```

Read the getter immediately before each request and treat its value as secret material.

---
