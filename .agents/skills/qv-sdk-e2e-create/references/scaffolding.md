# Scaffolding reference

Templates for step 8 of the workflow in [`../SKILL.md`](../SKILL.md).

## Test definition (`tests/<feature>-tests.ts`)

```ts
import type { TestDefinition } from "@qvac/test-suite";

export const <feature>Tests: TestDefinition[] = [
  {
    testId: "<feature>-happy",
    params: { /* canonical input */ },
    expectation: { validation: "contains-all", contains: ["EXPECTED_TOKEN"] },
    suites: ["smoke"], // only if this test qualifies
    metadata: { category: "<feature>", estimatedDurationMs: 10_000 },
  },
  {
    testId: "<feature>-edge",
    params: { /* boundary case */ },
    expectation: { validation: "type", expectedType: "string" },
    metadata: { category: "<feature>", estimatedDurationMs: 10_000 },
  },
  {
    testId: "<feature>-error",
    params: { /* invalid input */ },
    expectation: { validation: "throws-error", errorContains: "specific message" },
    metadata: { category: "<feature>", estimatedDurationMs: 2_000 },
  },
];
```

Register in `tests/test-definitions.ts`:

```ts
import { <feature>Tests } from "./<feature>-tests.js";
// ...
const catalog: TestDefinition[] = [
  // ...
  ...<feature>Tests,
];
```

## Declarative body

Add `steps` to the definition instead of writing an executor. Copy the shape from an existing body
such as `packages/sdk/e2e/tests/tts-moss-tests.ts` or `packages/sdk/e2e/tests/vision-tests.ts`; the
operations are specified in
[`@qvac/test-suite`'s conformance spec](../../../../packages/test-suite/docs/conformance.md). Every
model a body loads must also be declared in its `metadata` (`npm run check:step-dependencies`).

## Executor

Extend `AbstractModelExecutor` (base: `tests/shared/executors/abstract-model-executor.ts`) or use
`createExecutor` with `TestHandler` for ad-hoc cases. Bind handlers per `testId`, and use
`ResourceManager.ensureLoaded("<resource-name>")` to obtain model IDs.

Register the new executor in every compatible `handlers: [...]` array: desktop, mobile, and Electron
(which also covers Snap). Skip intentionally unsupported legs in `tests/platform-skips.ts`.

## Expectation reference

| Validation                      | Use for                                      | Notes                                       |
| ------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `contains-all` / `contains-any` | Keyword or closed-set answers                | Preferred over `type` when achievable       |
| `regex`                         | Structured output (JSON keys, date, lang ID) | Keep pattern anchored and stable            |
| `numeric-range`                 | Scores, latencies, embedding magnitude       | Pick bounds tolerant to minor model drift   |
| `type` (+ `minLength`)          | Last-resort shape check                      | Shallow; flag as weak coverage              |
| `throws-error`                  | Every error path                             | `errorContains` must be stable across bumps |
| `function`                      | Complex deterministic checks                 |                                             |
