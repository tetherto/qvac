# 💥 Breaking Changes v0.9.2

## Migrate SDK plugins to new addon constructor shape

PR: [#1688](https://github.com/tetherto/qvac/pull/1688)

**BEFORE:**
**

```typescript
export const myPlugin = definePlugin({
  // ...
  createModel(params: CreateModelParams): PluginModelResult {
    return { model, loader: null };
  },
});
```

**

**AFTER:**
**

---

