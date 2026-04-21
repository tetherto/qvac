# `qvac-lib-infer-llamacpp-llm` Implementation Migration Plan

## Scope

This plan implements the architecture in `docs/structure-proposal.md` for `tools_compact` and sliding behavior:

1. Extract `ToolsCompactController` (state machine + validation + trim decisions).
2. Extract `ContextSlider` (shared sliding helper for text/mtmd contexts).
3. Migrate tests to deterministic coverage that runs in CI without requiring a local Qwen model.

The output of this plan is one implementation PR split into multiple logical commits, with explicit acceptance criteria and test migration decisions.

## Goals

- Move `tools_compact` logic out of `LlmContext`/`LlamaModel` scattered paths into one controller.
- Remove duplicated sliding ladders in `TextLlmContext` and `MtmdLlmContext`.
- Improve reliability of test suite by removing model-dependent duplicate tests that are frequently skipped.
- Keep behavior unchanged during the refactor phase; fixes can land in a follow-up PR.

## Non-goals

- No new product behavior in refactor PRs.
- No changes to reasoning-specific Qwen logic (`handleQwen3ReasoningEOS`).
- No broad cleanup outside `tools_compact` and sliding call paths.

## Current Baseline (Migration Inputs)

- `docs/structure-proposal.md` defines target ownership and method boundaries.
- `docs/tools-compact.md` defines a cache-aware prompt-shape contract
  (user-tail strict, tool/assistant-tail conditional on KV cache presence,
  plus contiguous attachment rules when tools are present).
- Existing tests include:
  - Model-dependent C++ tests that skip when Qwen model is missing.
  - Integration brittle tests that cover runtime behavior and cache/sliding outcomes.
  - Template-level unit tests that are deterministic and model-free.

## Single PR Plan

Implement in one PR, split by commit boundaries (3 or more commits) to preserve reviewability and bisectability.

## Commit 1 - Extract `ToolsCompactController` (No behavior change)

### Files to add

- `addon/src/model-interface/ToolsCompactController.hpp`
- `addon/src/model-interface/ToolsCompactController.cpp`

### Files to update

- `addon/src/model-interface/LlmContext.hpp`
- `addon/src/model-interface/TextLlmContext.hpp`
- `addon/src/model-interface/TextLlmContext.cpp`
- `addon/src/model-interface/MtmdLlmContext.hpp`
- `addon/src/model-interface/MtmdLlmContext.cpp`
- `addon/src/model-interface/LlamaModel.hpp`
- `addon/src/model-interface/LlamaModel.cpp`
- `CMakeLists.txt`
- `test/unit/CMakeLists.txt`

### Implementation checklist

- Remove `DynamicToolsState` declaration/member/accessors from `LlmContext`.
- Add `ToolsCompactController` owned by `LlamaModel` (`std::unique_ptr`).
- Pass `ToolsCompactController&` into `TextLlmContext`/`MtmdLlmContext` constructors.
- Move these concerns into controller methods:
  - Prompt-shape validation (with `PromptLayout` helper input).
  - Tokenize boundary capture (`onTokenize`).
  - Eval completion boundary set (`onEvalComplete`).
  - Generation completion trim decision (`onGenerationComplete`).
  - Debug snapshot for runtime debug stats.
- Keep all public `LlamaModel` method signatures unchanged.

### Acceptance criteria

- Refactor compiles and existing behavior remains unchanged.
- No `dynamicToolsState()` references remain.
- `runtimeDebugStats` and `getNPastBeforeTools()` read from controller.

## Commit 2 - Extract `ContextSlider` (No behavior change)

### Files to add

- `addon/src/model-interface/ContextSlider.hpp`
- `addon/src/model-interface/ContextSlider.cpp`

### Files to update

- `addon/src/model-interface/TextLlmContext.cpp`
- `addon/src/model-interface/MtmdLlmContext.cpp`
- `CMakeLists.txt`
- `test/unit/CMakeLists.txt` (if standalone tests are added)

### Implementation checklist

- Introduce `SlideOutcome` + `trySlidePrefill()` and `trySlideGeneration()`.
- Replace duplicated slide ladders in both contexts with helper calls + `switch`.
- Route discard clamping + anchor shift through `ToolsCompactController` hooks.
- Keep exceptions and overflow behavior equivalent to current behavior.

### Acceptance criteria

- Both context files no longer contain duplicate ladder logic.
- Slide behavior remains equivalent in integration tests (`sliding-context` and `tools-compact` flows).

## Commit 3 - Test migration + cleanup (Targeted behavior checks)

This commit can include minor fixes already identified in proposal notes, but should focus on making test coverage deterministic and CI-reliable.

### Files to add

- `test/unit/test_tools_compact_controller.cpp` (new, model-free)
- Optional: `test/unit/test_context_slider.cpp` (if helper-level deterministic coverage is feasible)

### Files to update/remove

- `test/unit/CMakeLists.txt`
- Remove: `test/unit/test_model_tools_qwen3.cpp`
- Remove: `test/unit/test_text_llm_context_qwen3.cpp`
- Trim or migrate selected `tools_compact`-specific cases from:
  - `test/unit/test_text_llm_context.cpp`
  - `test/unit/test_cache_management_qwen3.cpp`

### Acceptance criteria

- Prompt-shape rejection tests run without model and no longer rely on `GTEST_SKIP`.
- Anchor/clamp/trim state transitions are covered by controller tests.
- Legacy model-dependent duplicate tests are removed.

## Commit 4+ - Optional targeted follow-ups

Only if needed, keep fix-oriented cleanup in separate commits within the same PR:

- dead `firstToolIndex` cleanup
- empty-`chatMsgs` UB hardening in `tokenizeChat`
- small refactor polish that is review-safe and behavior-preserving

## Suggested Commit Messages

Use or adapt the following sequence for the single PR:

1. `mod: extract tools compact controller from llm contexts`
2. `mod: extract shared context slider helpers for text and mtmd`
3. `test: migrate tools compact coverage to deterministic unit tests`
4. `fix: harden tools compact edge cases and remove dead fields` *(optional)*
5. `doc: update tools compact structure and migration docs` *(optional)*

## Test Review: Keep vs Remove

This section is the migration decision log for current tests in scope.

### Keep (as-is or minimal touch)

- `test/unit/test_qwen3_tools_dynamic_template.cpp`
  - Deterministic template contract tests, model-free, good long-term signal.
- `test/integration/tools-compact.test.js`
  - Keep as end-to-end behavior validation (cache/token outcomes, multi-turn flows).
- `test/integration/sliding-context.test.js`
  - Keep as end-to-end sliding behavior validation.
- `test/unit/test_llama_model.cpp` (`CommonParamsParseToolsCompact*` tests)
  - Keep for config parse compatibility.

### Keep but migrate assertions to new unit tests

- `test/unit/test_cache_management_qwen3.cpp`
  - Keep cache persistence/session behavior portions that are not duplicating controller state logic.
  - Move/remove direct internal-state checks tied to `DynamicToolsState` internals.

### Remove (replace with deterministic unit coverage)

- `test/unit/test_model_tools_qwen3.cpp`
  - Remove entire file after replacement tests land in `test_tools_compact_controller.cpp`.
  - Reasons: model-required, frequently skipped, duplicates prompt contract + chain boundary checks.
- `test/unit/test_text_llm_context_qwen3.cpp`
  - Remove entire file after replacement tests land.
  - Reasons: model-required, overlaps with integration coverage and controller-focused deterministic tests.

### Remove or downscope (from mixed files)

- `test/unit/test_text_llm_context.cpp` cases focused on timing/overhead logging (`DoubleTokenizationTimeOverhead*`)
  - Remove from blocking unit suite (performance checks are non-deterministic; move to benchmark/perf suite if needed).
- `test/unit/test_cache_management_qwen3.cpp` case using `DynamicToolsState` directly
  - Replace with `ToolsCompactController` equivalent deterministic assertions.

## New Required Unit Coverage (`test_tools_compact_controller.cpp`)

Minimum deterministic matrix:

- `validatePrompt`:
  - rejects missing tools
  - rejects missing anchor message (`user`/`tool`)
  - rejects detached tool block
  - rejects split tool block
  - accepts contiguous block after last anchor
- `onTokenize` + `onEvalComplete`:
  - records anchor only when tools contribute extra tokens
  - no-op when disabled
- `clampDiscard` + `onSlide`:
  - clamps to safe boundary
  - anchor shifts left and never crosses first-message boundary
- `onGenerationComplete`:
  - degenerate boundary resets state
  - no trim when output still contains tool-call marker
  - trim decision when chain completes and `nPast > anchor`
- `debugSnapshot` + `reset`:
  - snapshot values consistent before/after lifecycle transitions

## Validation Sequence

- Build: `npm run test:cpp:build`
- Unit: `npm run test:cpp:run`
- Integration generation sanity: `npm run test:integration:generate`
- Targeted integration:
  - `bare test/integration/tools-compact.test.js`
  - `bare test/integration/sliding-context.test.js`

If commits 1/2 are strictly no-behavior-change, integration expectations should remain unchanged.

## Rollout and Risk Controls

- Keep commits 1 and 2 small and sequential to simplify review and rollback.
- Do not mix behavior fixes with extraction refactors.
- Land commit 3 (test migration) immediately after extraction commits so CI signal improves before next feature work.
- Add temporary logging only if needed during migration; remove before merge.

## Definition of Done

- `ToolsCompactController` and `ContextSlider` are the only homes for respective concerns.
- `LlmContext` has no `tools_compact` state.
- Duplicate sliding ladders are removed from context implementations.
- Model-dependent duplicate unit tests are removed and replaced with deterministic controller tests.
- Existing integration tests for tools/sliding continue to pass.

