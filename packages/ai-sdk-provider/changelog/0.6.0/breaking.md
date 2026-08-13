# 💥 Breaking Changes v0.6.0

## Harden serve CORS and managed authentication

PR: [#3744](https://github.com/tetherto/qvac/pull/3744)

**BEFORE:**

```ts
// Managed callers could pass an apiKey option that serve never enforced.
const qvac = await createQvac({
  mode: 'managed',
  models: ['QWEN3_8B_INST_Q4_K_M'],
  apiKey: 'local-key'
})
```

**AFTER:**

```ts
// Managed mode generates the enforced key; read the live value when needed.
const qvac = await createQvac({
  mode: 'managed',
  models: ['QWEN3_8B_INST_Q4_K_M']
})
qvac.apiKey
```

- `QvacManagedOptions.apiKey` is removed. `ManagedQvacProvider.apiKey` is the generated live credential, and is non-enumerable so object dumps do not carry it.
- A caller-supplied `authorization` header on a managed provider is replaced with the managed key. Custom `fetch` wrappers now see already-authorized requests.
- In external mode `qvac serve` enforces the key instead of ignoring it, so the `apiKey` passed to `createQvac` must match what the server was started with or requests fail with a 401.

---
