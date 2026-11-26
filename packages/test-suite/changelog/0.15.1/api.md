# 🔌 API Changes v0.15.1

## Release models that step-based e2e tests load themselves

PR: [#5641](https://github.com/tetherto/qvac/pull/5641)

```typescript
const bindings: StepBindings = {
  // ...
  async endTest() {
    await resources.releaseTestScope()
  }
}
```

---

