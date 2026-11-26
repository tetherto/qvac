# QVAC Test Suite v0.15.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.15.1

Step-based tests that load models themselves no longer leave them in the worker. A runner can now release what a test acquired once the test ends.

---

## New APIs

### Release what a test acquired with `StepBindings.endTest()`

`StepBindings` takes an optional `endTest()` hook. `StepInterpreter` calls it once per test, after the test's teardown has run and the calls it started have settled, whether the test passed, failed or threw. A runner uses it to unload the models a test loaded through its own `loadModel` calls, which the resource manager does not own.

```typescript
const bindings: StepBindings = {
  // ...
  async endTest() {
    await resources.releaseTestScope()
  }
}
```

A failing `endTest()` fails a test that otherwise passed, with `end-of-test release failed: <message>`; a test that already failed keeps its own diagnosis. The hook is skipped for a run that a newer run replaced after a timeout, so it cannot unload the newer test's models. Runners without the hook behave as on 0.15.0.

---

## Changes

- The runner conformance guide (`docs/conformance.md`) now requires a runner to unload the models a test loaded itself, and to forget an unloaded model's id under every resource key.
