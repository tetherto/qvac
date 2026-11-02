# 🔌 API Changes v0.12.0

## Run a shared catalog on any client

PR: [#4619](https://github.com/tetherto/qvac/pull/4619)

```typescript
import {
  StepInterpreter,
  StepIncompleteError,
  type StepBindings,
  type TestDefinition
} from '@qvac/test-suite'

const bindings: StepBindings = {
  useModel: async (deps) => [await resources.ensureLoaded(deps[0]!)],
  call: async (method) => {
    throw new StepIncompleteError(`${method} has no run handle on this client yet`)
  }
  // ...asset, modelSource, assertions, comparisons, evictAllExcept
}

const result = await new StepInterpreter(bindings).run(definition)
// result: { passed, output, skipped?, incomplete?, incompleteReason?, assertedValue? }
```

---

## Auto-install addon platform packages for mobile bundles

PR: [#4688](https://github.com/tetherto/qvac/pull/4688)

```typescript
import { bundleSdk, ensureHostPrebuilds } from '@qvac/sdk/commands'

await ensureHostPrebuilds({ projectRoot, hosts: ['android-arm64'] })
await bundleSdk({ projectRoot, hosts: ['android-arm64'], installMissingPrebuilds: true })
```

```json
{ "expo": { "plugins": [["@qvac/sdk/expo-plugin", { "installMissingPrebuilds": true }]] } }
```

---

## Bump npm consumers to @qvac/fabric 0.18.0

PR: [#4733](https://github.com/tetherto/qvac/pull/4733)

```json
{ "dependencies": { "@qvac/llm-llamacpp": "^0.54.0" } }
```

```json
{
  "dependencies": {
    "@qvac/llm-llamacpp": "^0.55.0",
    "@qvac/fabric-android-arm64": "0.18.0"
  }
}
```

---

