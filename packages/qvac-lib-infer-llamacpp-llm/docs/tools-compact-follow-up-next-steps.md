# Tools Compact Follow-up Next Steps

## Last Verified

- Date: 2026-04-20
- Scope: `tools_compact` marker/profile plumbing, Qwen-only support gate, cache-aware prompt contract, controller unit coverage, and docs alignment.

## How to Re-Verify

- [ ] Build C++ tests: `npm run test:cpp:build`
- [ ] Run C++ unit tests (includes `test_tools_compact_controller.cpp`): `npm run test:cpp:run`
- [ ] Regenerate integration bundle: `npm run test:integration:generate`
- [ ] Run tools-compact integration: `bare test/integration/tools-compact.test.js`
- [ ] Run sliding-context integration: `bare test/integration/sliding-context.test.js`
- [ ] Re-check docs consistency after behavior/config changes in:
  - [ ] `docs/tools-compact.md`
  - [ ] `docs/implementation-migration-plan.md`
  - [ ] `docs/tools-compact-follow-up-next-steps.md`

## Purpose

Capture post-refactor follow-up actions after implementing `structure-proposal.md`, while allowing reasonable implementation divergence when behavior remains intentional and documented.

## Current Review Findings

### 1) Marker/profile portability is implemented

- `ToolsCompactController::onGenerationComplete` now checks `ToolsCompactProfile.toolCallStartMarker` (not a hardcoded `"<tool_call>"` string).
- Marker/profile is plumbed from model initialization, keeping controller behavior template/family-aware.

### 2) Support matrix decision is implemented and documented

- `LlamaModel::commonParamsParse` keeps `tools_compact` gated to `general.architecture == "qwen3"` in this cycle.
- `docs/tools-compact.md` explicitly documents Qwen-only scope and behavior for unsupported families.

### 3) Prompt contract alignment is implemented

- Runtime uses a cache-aware empty-tools contract (strict on user-tail and selected no-cache chain states; conditional/no-op in allowed cached/final shapes).
- Documentation now matches runtime behavior and test coverage.

### 4) Reset/debug semantics are aligned

- `ToolsCompactController::reset()` intentionally preserves debug snapshot fields.
- Header comments/documentation reflect that snapshots are generation-captured and not live mutable state.

## Source of Truth Policy

`structure-proposal.md` is the architectural source of truth, not a strict line-by-line implementation lock.

Acceptable divergence:

- Different internal class/function decomposition.
- Different helper boundaries.
- Additional safety checks/logging.

Not acceptable divergence (without explicit decision + docs update):

- Changed runtime semantics for chain completion / trimming.
- Changed support matrix (which model families are supported).
- Changed prompt validation contract.

## Next Steps (Optional, Non-Blocking)

## Phase 1 - Hardening

1. Tighten marker detection beyond substring checks (e.g., structured block detection) to reduce false positives in free-form assistant text.
2. Add negative tests for marker-like text that should not be interpreted as active tool calls.

## Phase 2 - Future support expansion

1. Extend `selectToolsCompactMarker(...)` allow-list for additional model families when templates are validated.
2. Add family-specific marker and contract tests alongside each new support addition.
3. Keep Qwen-only default behavior until new family templates are verified end-to-end.

## Phase 3 - Docs maintenance

1. Keep `docs/tools-compact.md` and this follow-up doc synchronized when support matrix or contract logic changes.
2. Periodically prune historical implementation notes once they no longer aid maintainers.

## Completion Checklist

- [x] Chain completion marker is not hardcoded to Qwen syntax.
- [x] Support matrix (Qwen-only vs multi-family) is explicitly decided and documented.
- [x] Prompt validation contract is unambiguous and tested.
- [x] Unit tests cover marker detection and chosen contract behavior.
- [x] Docs reflect real behavior and implementation scope.

## Suggested Implementation Order (If Optional Work Is Started)

1. Marker detection hardening + focused unit tests.
2. Family support expansion one architecture at a time (code + tests + docs per step).
3. Documentation cleanup pass after each behavior change.

