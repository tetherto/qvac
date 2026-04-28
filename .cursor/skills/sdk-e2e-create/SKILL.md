---
name: sdk-e2e-create
description: >
  Plans and scaffolds e2e tests in packages/sdk/tests-qvac for a new or changed public SDK API. Use when
  adding or modifying SDK functionality that is exposed to consumers. Enforces happy / sad / error
  coverage, deterministic model-output assertions, mobile/desktop placement, smoke-suite selection, and
  local validation with run:local.
---

# SDK e2e Test Creation

Plan and scaffold e2e tests in `packages/sdk/tests-qvac` for a new or changed SDK feature exposed through
the public API.

## When to use this skill

**Applies to SDK changes in `packages/sdk/` that touch the public API surface.**

Use when:

- Adding a new public SDK function, model type, or capability.
- Changing an existing public SDK API in a way that affects runtime behaviour.
- User invokes `/sdk-e2e-create`.
- User asks to "add e2e tests for <feature>" or similar.

Do NOT use for:

- Internal refactors that don't change the public surface.
- Unit tests inside `packages/sdk/` (this skill covers only the e2e suite under `packages/sdk/tests-qvac`).

## Approach

Investigate first, then propose a concrete plan. Only ask the user for information that cannot be
recovered from code or context.

1. **Read the feature.** Identify the new/changed exports, inputs, return type, model dependencies, and
   any existing examples under `packages/sdk/examples/` or tests under `packages/sdk/tests-qvac/tests/`.
2. **Find comparable tests.** Look for an analogous existing feature in `tests/test-definitions.ts` and
   its executor. Mirror its style unless there's reason to deviate.
3. **Determine model-output testability** (see §"Model-output strategy"). Propose a specific validator
   and a specific prompt/input that makes the output deterministic enough to assert.
4. **Draft happy / sad / error cases** as a concrete test-definition sketch.
5. **Decide executor placement and mobile constraints** (see §"Placement and mobile constraints").
6. **Select at most one smoke candidate** (see §"Smoke policy").
7. **Present the plan to the user.** Include: feature summary, chosen validators with rationale, test
   definitions sketch, placement decision, mobile concerns, smoke pick. Ask clarifying questions only
   where genuine ambiguity remains (e.g. expected model behaviour on an edge case, preferred tolerance
   for a `numeric-range`).
8. **After approval**, scaffold the files and prompt the user to run locally with the exact
   `run:local:desktop --filter <feature>-` command.

## Model-output strategy

For any feature that invokes a model, **do not default to shape-only checks**. `type` validation proves
nothing about model correctness and must be a last resort.

Pick the strongest achievable strategy:

1. **Exact-ish output** — constrain the prompt + deterministic params (`temperature: 0`, fixed `seed`,
   `top_k: 1`) so a known token must appear. Assert with `contains-all`.
   _Example:_ prompt "Reply with only the word APPLE." → assert result contains `APPLE`.
2. **Closed-set** — enum-style prompt (known set of valid answers) → `contains-any`.
3. **Numeric range** — a score, similarity, duration, or embedding magnitude with known bounds →
   `numeric-range`. Pick bounds tolerant to minor model drift.
4. **Regex structure** — structured output (JSON keys, date format, language tag) → `regex`. Keep the
   pattern anchored and stable.
5. **Shape-only fallback** — `type` with `minLength`. Flag as weak coverage in the plan.
6. **Error path** — `throws-error` with a substring that is stable across SDK versions.
7. **Custom `function`** — use for deterministic but non-trivial checks like cosine similarity against a
   reference vector.

If the model's output is inherently non-deterministic and cannot be constrained, say so in the plan and
justify why shape-only or range-based coverage is the best achievable — do not silently ship a weak
assertion.

## Happy / sad / error minimum

Every public-API feature MUST have at minimum:

- **Happy path** — valid input, canonical output, strongest assertion achievable.
- **Sad path** — boundary or edge case that must still succeed (empty input, minimum ctx, longest
  accepted input, unusual but valid locale, streaming vs non-streaming).
- **Error path** — invalid/malformed input, missing asset, or exceeded constraint. Must throw with a
  matchable message via `throws-error`.

More cases are encouraged for multi-branch features.

## Placement and mobile constraints

Executor placement (from [`.cursor/rules/sdk/tests-qvac.mdc`](../../rules/sdk/tests-qvac.mdc)):

- Pure SDK API, no Node stdlib, no RN APIs → `tests/shared/executors/`.
- Needs `node:fs`, `node:path`, `process.cwd()`, or other Node-only APIs → `tests/desktop/executors/`.
- Needs RN `Platform`, bundled assets, or anything specific to React Native → `tests/mobile/executors/`.

Never import `node:*` from `tests/shared/` or `tests/mobile/`.

**Mobile concerns to address in the plan:**

- **Memory** — can the target device RAM hold the model? If not, propose a smaller model variant on
  mobile, or a `SkipExecutor` entry.
- **Filesystem** — `node:fs` is unavailable. Assets must be bundled via `qvac-test.config.js` →
  `consumers.mobile.assets.patterns`.
- **Platform-specific limitations** — known iOS/Android issues (OOM, missing native lib, backend
  unsupported). Add a `SkipExecutor` at the top of `tests/mobile/consumer.ts` with a clear reason.

If the feature cannot run on mobile at all, document the skip reason and ship desktop-only coverage.

## Smoke policy

- Only tag `suites: ["smoke"]` if the feature has **no existing smoke coverage**.
- Cap at **1-2** smoke tests per feature.
- Pick the happy path with the most meaningful assertion (not shape-only).
- Must be deterministic, fast, and stable on both desktop and mobile. Verify before tagging.
- If no test meets the bar, **do not tag any** and flag it explicitly in the plan.

## Scaffolding templates

### Test definition (`tests/<feature>-tests.ts`)

```ts
import type { TestDefinition } from "@tetherto/qvac-test-suite";

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
export const allTests: TestDefinition[] = [
  // ...
  ...<feature>Tests,
];
```

### Executor

Extend `AbstractModelExecutor` (base: `tests/shared/executors/abstract-model-executor.ts`) or use
`createExecutor` with `TestHandler` for ad-hoc cases. Bind handlers per `testId`, and use
`ResourceManager.ensureLoaded("<resource-name>")` to obtain model IDs.

Register the new executor in `tests/desktop/consumer.ts` and/or `tests/mobile/consumer.ts` in the
`handlers: [...]` array of `createExecutor(...)`.

## Local validation (required before landing)

After scaffolding, provide the user with the exact command to run on desktop. Do not mark the task
complete until the user confirms the tests pass locally.

```bash
cd packages/sdk/tests-qvac

# If SDK source changed
npm run install:build:full

# Otherwise (only test code changed, SDK already built)
npm run install:build

npx qvac-test run:local:desktop --filter <feature>-
```

For mobile verification of a smoke candidate (required before tagging `suites: ["smoke"]`):

```bash
npx qvac-test run:local:android --filter <feature>-     # or run:local:ios
```

## Expectation reference

| Validation                     | Use for                                       | Notes                                       |
| ------------------------------ | --------------------------------------------- | ------------------------------------------- |
| `contains-all` / `contains-any` | Keyword or closed-set answers                | Preferred over `type` when achievable       |
| `regex`                         | Structured output (JSON keys, date, lang ID) | Keep pattern anchored and stable            |
| `numeric-range`                 | Scores, latencies, embedding magnitude       | Pick bounds tolerant to minor model drift   |
| `type` (+ `minLength`)          | Last-resort shape check                      | Shallow; flag as weak coverage              |
| `throws-error`                  | Every error path                             | `errorContains` must be stable across bumps |
| `function`                      | Complex deterministic checks                 |                                             |

## Quality checklist

Before presenting the plan:

- [ ] Feature surface understood from code; any genuine gaps raised as targeted clarifying questions.
- [ ] Model-output strategy picked and justified — not defaulted to `type`.
- [ ] Happy, sad, and error cases drafted.
- [ ] Executor placement chosen; mobile memory / filesystem / platform concerns addressed.
- [ ] Smoke candidate selected or explicitly skipped with reason.
- [ ] Local validation command prepared with the correct `--filter` prefix.

Before marking scaffolding complete:

- [ ] Test definitions aggregated in `tests/test-definitions.ts`.
- [ ] Executors registered in relevant consumer entry.
- [ ] User has confirmed the new tests pass via `run:local:desktop --filter <feature>-`.

## References

- Executor placement, smoke policy, rebuild flow → `.cursor/rules/sdk/tests-qvac.mdc` and
  `packages/sdk/tests-qvac/README.md`.
- Expectation schema → `@tetherto/qvac-test-suite` `dist/schemas/expectations.js`.
- Existing examples:
  - Strong output assertion: `packages/sdk/tests-qvac/tests/translation-salamandra-tests.ts`
    (`contains-any` over expected Spanish tokens).
  - Error path: `packages/sdk/tests-qvac/tests/vision-tests.ts` (`throws-error` with `errorContains`).
  - Shape fallback: `packages/sdk/tests-qvac/tests/completion-tests.ts` (`type: "string"`).
