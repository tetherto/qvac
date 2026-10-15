# QVAC Test Suite v0.12.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/test-suite/v/0.12.0

The headline is that a test body can now be data instead of JavaScript, so a client written in another language runs the same catalog rather than a translated copy of it. Alongside that, mobile consumers stop hand-pinning addon platform packages, and one dead config field is gone.

---

## Breaking Changes

### The `runIdStrategy` config field is removed

`defineConfig` required `runIdStrategy`, and it selected nothing at runtime — the field was inert. It is gone, and a config that still sets it no longer compiles.

**Before:**

```typescript
export default defineConfig({
  testDir: './dist/tests',
  runIdStrategy: 'auto',
  consumers: { desktop: { entry: './consumer.js' } }
})
```

**After:**

```typescript
export default defineConfig({
  testDir: './dist/tests',
  consumers: { desktop: { entry: './consumer.js' } }
})
```

Delete the line; nothing replaces it. A run that needs a specific id passes `--runId`, which is what CI already does.

## New APIs

### A test body can be described as data

Until now every test body was a JavaScript function, so a generated client in another language could not run any of it. Equivalence between clients was argued by reading code rather than demonstrated by running the same tests.

A test can now be written as a sequence of steps — `useModel`, `modelSource`, `asset`, `call`, `callError`, `start`, `settle`, `repeat`, `project`, `assert`, `compare`. Each step names data rather than holding an object, so a client whose session or handle type differs still runs the same body. `settle.withinMs` puts a deadline on a started call, so a wedged call fails with its own message instead of the consumer's generic test timeout.

A client becomes drivable by implementing one interface, `StepBindings`:

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
```

A non-JavaScript client does not have to reimplement the MQTT state machine either. An NDJSON bridge over stdin/stdout plus `BridgeExecutor` reuses the existing registration, queue, heartbeats, retry and reporting.

Two things keep this honest. `schema/test-definition.schema.json` is the language-neutral copy of the vocabulary, and `catalog:validate` fails when the two copies disagree on operation names or fields. And results gained a fourth outcome, `incomplete`, which carries a required reason: `skipped` is a statement about the platform, `incomplete` is a statement about the client, so a gap shows up as visible debt instead of a hidden pass. `report:matrix` renders the testId × client grid and diffs the value each client asserted on — two clients can both return a string and still disagree about what they built from the same stream.

Existing tests are unaffected: a definition without `steps` routes to its executor exactly as before. `docs/conformance.md` describes what a runner must do with a legal definition, which a schema alone cannot say.

## Changes

### Mobile consumer manifests no longer pin addon platform packages

Mobile consumer manifests no longer declare the per-platform packages of split native addons — `@qvac/<addon>-android-arm64`, `@qvac/<addon>-ios`. The SDK owns that now: `ensureHostPrebuilds` adds the packages the addons need for mobile hosts, pinned to each addon's exact version, and `bundleSdk` and the Expo plugin can run it.

Pass `installMissingPrebuilds` to the SDK plugin in `expoPlugins` to install them during `expo prebuild`:

```js
expoPlugins: [['@qvac/sdk/expo-plugin', { installMissingPrebuilds: true }]]
```

The alternative is declaring them in the config directory's dependencies. The option needs an `@qvac/sdk` whose Expo plugin supports it.

### Fabric 0.18.0 for npm consumers

Consumers move to addon versions built against `@qvac/fabric` 0.18.0 — for example `@qvac/llm-llamacpp` `^0.55.0` together with `@qvac/fabric-android-arm64` `0.18.0`.
