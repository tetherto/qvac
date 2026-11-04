# Scaffolding reference

Templates for step 8 of the workflow in [`../SKILL.md`](../SKILL.md).

## Test definition (`catalog/<feature>-tests.ts`)

A declarative body, shaped like `packages/sdk-e2e/catalog/vision-tests.ts` and
`packages/sdk-e2e/catalog/tts-moss-tests.ts`:

```ts
import type { Step, TestDefinition } from '@qvac/test-suite'

/** One `<sdkMethod>` call; the definition's `expectation` judges the result. */
const <feature>Steps = (dependency: string): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  {
    call: {
      method: '<sdkMethod>',
      collect: 'text',
      params: { modelId: '$model' /* , <name>: '$params.<name>' */ },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  { assert: { on: '$text', use: 'expectation' } }
]

/** The same call, which must fail; the expectation matches the error message. */
const <feature>ErrorSteps = (dependency: string): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  {
    callError: {
      method: '<sdkMethod>',
      collect: 'text',
      params: { modelId: '$model' /* , <name>: '$params.<name>' */ },
      as: 'error'
    }
  },
  { project: { from: '$error', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } }
]

export const <feature>Tests: TestDefinition[] = [
  {
    testId: '<feature>-happy',
    params: { /* canonical input */ },
    expectation: { validation: 'contains-all', contains: ['EXPECTED_TOKEN'] },
    suites: ['smoke'], // only if this test qualifies
    metadata: { category: '<feature>', dependency: '<resource-key>', estimatedDurationMs: 10000 },
    steps: <feature>Steps('<resource-key>')
  },
  {
    testId: '<feature>-edge',
    params: { /* boundary case */ },
    expectation: { validation: 'type', expectedType: 'string' },
    metadata: { category: '<feature>', dependency: '<resource-key>', estimatedDurationMs: 10000 },
    steps: <feature>Steps('<resource-key>')
  },
  {
    testId: '<feature>-error',
    params: { /* invalid input */ },
    expectation: { validation: 'throws-error', errorContains: 'specific message' },
    metadata: { category: '<feature>', dependency: '<resource-key>', estimatedDurationMs: 2000 },
    steps: <feature>ErrorSteps('<resource-key>')
  }
]
```

- `metadata.dependency` names every resource key the body loads (`+` joins several). The
  pre-download and the per-test preload read it, not the body; `npm run check:step-dependencies`
  fails on a mismatch. Use `'none'` only for a body with no `useModel`, such as a validation error
  raised before any model is looked up.
- Each `<resource-key>` is an entry in `catalog/resource-table.ts` whose `on` covers every leg
  the test runs on.
- `'$params.<name>'` reads the definition's `params`; with a trailing `?` the field is left out of
  the call when a test does not set it, so one helper serves tests with different inputs.
- `collect` folds the call's stream: `text`, `blocks`, `events`, `pcm`, `last` or `all`. Pick the one
  the method produces and project the field the assertion reads.
- The operations are listed in `@qvac/test-suite`'s `schema/test-definition.schema.json`; what a
  runner must do with them is in its
  [conformance spec](../../../../packages/test-suite/docs/conformance.md).

Register in `catalog/test-definitions.ts`:

```ts
import { <feature>Tests } from './<feature>-tests.js'
// ...
const catalog: TestDefinition[] = [
  // ...
  ...<feature>Tests
]
```

## Executor

Only for a body that cannot be data. Leave `steps` out of the definition and keep the rest of the
template, `metadata.dependency` included.

Extend `AbstractModelExecutor` (base: `runners/js/shared/executors/abstract-model-executor.ts`) or use
`createExecutor` with `TestHandler` for ad-hoc cases. Bind handlers per `testId`, and use
`ResourceManager.ensureLoaded("<resource-name>")` to obtain model IDs.

Register the new executor in every compatible `handlers: [...]` array: desktop, mobile, and Electron
(which also covers Snap). Skip intentionally unsupported legs in `catalog/platform-skips.ts`.

## Expectation reference

| Validation                      | Use for                                      | Notes                                       |
| ------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `contains-all` / `contains-any` | Keyword or closed-set answers                | Preferred over `type` when achievable       |
| `regex`                         | Structured output (JSON keys, date, lang ID) | Keep pattern anchored and stable            |
| `numeric-range`                 | Scores, latencies, embedding magnitude       | Pick bounds tolerant to minor model drift   |
| `type` (+ `minLength`)          | Last-resort shape check                      | Shallow; flag as weak coverage              |
| `throws-error`                  | Every error path                             | `errorContains` must be stable across bumps |
| `function`                      | Complex deterministic checks                 | JS only; prefer a `named:` assertion        |
