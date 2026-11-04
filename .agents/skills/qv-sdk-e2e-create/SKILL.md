---
name: qv-sdk-e2e-create
description: >
  Plans and scaffolds e2e tests in packages/sdk-e2e for a new or changed public SDK API. Use when
  adding or modifying SDK functionality that is exposed to consumers. Enforces happy / sad / error
  coverage, deterministic model-output assertions, resource and skip entries for every leg (desktop,
  mobile, Electron, Snap), smoke-suite selection, and local validation with run:local.
---

# SDK e2e Test Creation

Plan and scaffold e2e tests in `packages/sdk-e2e` for a new or changed SDK feature exposed through
the public API.

## When to use this skill

**Applies to SDK changes in `packages/sdk/` that touch the public API surface.**

Use when:

- Adding a new public SDK function, model type, or capability.
- Changing an existing public SDK API in a way that affects runtime behaviour.
- User invokes `/qv-sdk-e2e-create`.
- User asks to "add e2e tests for <feature>" or similar.

Do NOT use for:

- Internal refactors that don't change the public surface.
- Unit tests inside `packages/sdk/` (this skill covers only the e2e suite under `packages/sdk-e2e`).

## Workflow

Investigate first, then propose a concrete plan. Only ask the user for information that cannot be
recovered from code or context.

1. **Read the feature.** Identify the new/changed exports, inputs, return type, model dependencies, and
   any existing examples under `packages/sdk/examples/` or tests under `packages/sdk-e2e/catalog/`.
2. **Find comparable tests.** Look for an analogous existing feature in `catalog/test-definitions.ts`
   and its body or executor. Mirror its style unless there's reason to deviate.
3. **Determine model-output testability** (§"Model-output strategy"). Propose a specific validator
   and a specific prompt/input that makes the output deterministic enough to assert.
4. **Draft happy / sad / error cases** as a concrete test-definition sketch
   (§"Happy / sad / error minimum").
5. **Decide the body, placement and platforms** — declarative body or executor placement, consumer
   registration, resource and skip entries, mobile constraints (§"Body and placement",
   §"Platforms").
6. **Select the smoke candidate** (§"Smoke policy").
7. **Present the plan to the user.** Include: feature summary, chosen validators with rationale, test
   definitions sketch, body/placement decision, registrations and platform concerns per leg
   (desktop, mobile, Electron, Snap), smoke pick. Ask clarifying questions only where genuine
   ambiguity remains (e.g. expected model behaviour on an edge case, preferred tolerance for a
   `numeric-range`).
8. **After approval**, scaffold with [`references/scaffolding.md`](references/scaffolding.md) and
   give the user the exact local commands for every consumer (§"Validation"). Always include
   `run:local:electron --filter <feature>-` to verify that the body runs on Electron/Snap or is
   skipped there on purpose.

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
7. **Named assertion** — for deterministic but non-trivial checks like cosine similarity against a
   reference vector, assert with `named:` and implement it for both clients, in
   `runners/js/shared/step-bindings.ts` and `runners/python/qvac_e2e/assertions.py`. Avoid a `function`
   expectation: it is a JavaScript closure, so a non-JS client reports the test `incomplete`.

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

## Body and placement

**Prefer a declarative body.** A definition with `steps` runs through the shared step interpreter,
with no executor, on every consumer whose `runners/js/<leg>/consumer.ts` sets `executor.stepBindings`.
Check that for each leg the test runs on: elsewhere the definition goes to the executors and fails
with `No handler found` or `Unknown test`. Mobile has no interpreter, because the step bindings
import `node:*`, so a step-only test needs a mobile executor or a `mobile` skip. Write an executor
only for a body that cannot be data.

Executor placement, when one is needed:

- Pure SDK API, no Node stdlib, no RN APIs → `runners/js/shared/executors/`.
- Needs `node:fs`, `node:path`, `process.cwd()`, or other Node-only APIs →
  `runners/js/shared/executors/node/`.
- Needs RN `Platform`, bundled assets, or anything specific to React Native → `runners/js/mobile/executors/`.

Never import `node:*` into code mobile loads: `runners/js/mobile/` and `runners/js/shared/executors/` outside
`node/`.

Placement does not register an executor. Add it to the `handlers: [...]` array of every compatible
consumer: `runners/js/desktop/consumer.ts`, `runners/js/mobile/consumer.ts`, and `runners/js/electron/consumer.ts`
(also used by the Snap). A scheduled test with no matching executor fails with `No handler found`.

## Platforms

Evaluate every leg on its own — desktop, mobile, Electron, Snap — rather than treating desktop-only
coverage as automatic. Leg names are in `catalog/platform-vocabulary.md`.

- **Models** are declared once in `catalog/resource-table.ts`, not in the consumers. `on` limits
  an entry to some platforms and matches by segment prefix, so `electron` does not cover the Snap
  (`snap-linux`) — name `snap` too. A leg that runs a test whose entry it leaves out throws
  `Unknown dependency`. Regenerate the JSON copy with `npm run emit:resource-table`.
- **Skips** are data in `catalog/platform-skips.ts`, not `SkipExecutor`s in consumers. Name every leg
  the test must not run on, listing `snap` alongside `electron`, with a clear reason. Record a
  deliberate change with `node scripts/check-skip-matrix.mjs --write`.
- **Mobile** — address these in the plan; if the feature cannot run on mobile at all, document the
  skip reason:
  - **Memory** — can the target device RAM hold the model? If not, propose a smaller model variant
    on mobile, or a `mobile` skip.
  - **Filesystem** — `node:fs` is unavailable. Assets must be bundled via `qvac-test.config.js` →
    `consumers.mobile.assets.patterns`.
  - **Platform-specific limitations** — known iOS/Android issues (OOM, missing native lib, backend
    unsupported). Skip `mobile-ios`, `mobile-android` or `mobile` with a clear reason.
- **Snap** runs the Electron consumer but needs Linux with snapcraft and LXD. Where it cannot run,
  check that its resources and skips name `snap`.

## Smoke policy

- Only tag `suites: ["smoke"]` if the feature has **no existing smoke coverage**.
- Cap at **1-2** smoke tests per feature; propose one by default.
- Pick the happy path with the most meaningful assertion (not shape-only).
- Must be deterministic, fast, and stable on both desktop and mobile. Verify on both before
  tagging.
- If no test meets the bar, **do not tag any** and flag it explicitly in the plan.

## Validation

Required before landing. Provide the exact commands for every compatible local consumer. Do not mark
the task complete until the user confirms those tests pass locally.

```bash
cd packages/sdk-e2e

# If packages/sdk or packages/inference changed
npm run install:build:full

# Otherwise (only test code in packages/sdk-e2e changed)
npm run install:build

npx qvac-test run:local:desktop --filter <feature>-
npx qvac-test run:local:electron --filter <feature>- # the body runs here, or the skip is intended
npx qvac-test run:local:android --filter <feature>-  # or run:local:ios; required before smoke
```

Always use `install:build:full` once `packages/sdk` itself changed, even if `packages/inference` has no
diff lines of its own — `install:build:sdk` trusts the published `@qvac/inference` range, which can already
be behind the checked-out `packages/inference` source from unrelated merged work.

Before pushing, run the cheap gates listed under "Developing new tests" in
[`packages/sdk-e2e/README.md`](../../../packages/sdk-e2e/README.md).

## Quality checklist

Before presenting the plan:

- [ ] Feature surface understood from code; any genuine gaps raised as targeted clarifying questions.
- [ ] Model-output strategy picked and justified — not defaulted to `type`.
- [ ] Happy, sad, and error cases drafted.
- [ ] Body and placement chosen; desktop, mobile, Electron and Snap coverage checked; mobile memory /
      filesystem / platform concerns addressed.
- [ ] Smoke candidate selected or explicitly skipped with reason.
- [ ] Local validation command prepared with the correct `--filter` prefix.

Before marking scaffolding complete:

- [ ] Test definitions aggregated in `catalog/test-definitions.ts`; any SDK wire type they need
      comes from `catalog/wire-types.ts`, never from `@qvac/sdk`.
- [ ] Every leg that runs a step-only test sets `executor.stepBindings` in its consumer.
- [ ] Executors registered in every compatible consumer, Electron included (it covers the Snap);
      unsupported legs skipped in `catalog/platform-skips.ts`.
- [ ] Models added to `catalog/resource-table.ts` with `on` naming every leg that runs the
      tests, `snap` included; JSON copy regenerated.
- [ ] README's cheap gates pass.
- [ ] User has confirmed the new tests pass through each compatible local consumer command.
- [ ] User reminded to run `/qv-docs-update` when the tested surface is user-facing. Never auto-run
      it — the skill is manual-only.

## References

- Templates and the expectation table → [`references/scaffolding.md`](references/scaffolding.md).
- Executor placement, smoke policy, rebuild flow, cheap gates →
  [`packages/sdk-e2e/AGENTS.md`](../../../packages/sdk-e2e/AGENTS.md) and
  [`packages/sdk-e2e/README.md`](../../../packages/sdk-e2e/README.md).
- Expectation schema → `@qvac/test-suite` `dist/schemas/expectations.js`.
- Existing examples:
  - Declarative body: `packages/sdk-e2e/catalog/tts-moss-tests.ts` (step-only, no executor).
  - Strong output assertion: `packages/sdk-e2e/catalog/translation-bergamot-tests.ts`
    (`contains-any` over expected French tokens).
  - Error path: `packages/sdk-e2e/catalog/vision-tests.ts` (`throws-error` with `errorContains`).
  - Shape fallback: `packages/sdk-e2e/catalog/completion-tests.ts` (`type: "string"`).
