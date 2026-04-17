# Tools Compact Follow-up Next Steps

## Purpose

Capture post-refactor follow-up actions after implementing `structure-proposal.md`, while allowing reasonable implementation divergence when behavior remains intentional and documented.

## Current Review Findings

### 1) Must fix: hardcoded tool-call marker in compaction completion check

- Location: `ToolsCompactController::onGenerationComplete`
- Current behavior checks only `"<tool_call>"`.
- Risk: compaction chain-completion detection is tied to Qwen-style output and is not portable to other model families / template conventions.

### 2) Phase 2 decision: keep Qwen-only gating for `tools_compact`

- Location: `LlamaModel::commonParamsParse`
- Decision: keep `tools_compact` gated to `general.architecture == "qwen3"` in this cycle.
- Gate implementation remains profile-driven so additional families can be added in a follow-up without reworking controller wiring.

### 3) Alignment decision required: strict prompt contract wording vs runtime behavior

- Docs currently describe strict contract: `tools` must be non-empty when `tools_compact` is enabled.
- Runtime validation currently treats some empty-tools shapes as no-op instead of hard rejection.
- This is either:
  - a behavior bug (if strict contract is intended), or
  - a docs mismatch (if conditional/no-op behavior is intended).

### 4) Minor consistency cleanup: reset/debug wording

- `ToolsCompactController::reset()` does not clear all debug snapshot state.
- Header wording should match behavior, or reset should clear debug fields.

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

## Next Steps (Prioritized)

## Phase 1 - Correctness and portability

1. Introduce a model/template profile input for tool-call marker detection (e.g. `ToolsCompactProfile`).
2. Pass marker/profile into `ToolsCompactController` from model initialization path.
3. Replace hardcoded `"<tool_call>"` check with profile-driven marker check.
4. Add deterministic unit tests for marker detection behavior (at minimum two marker variants).

## Phase 2 - Product/scope decisions

1. Decision: `tools_compact` remains Qwen-only in this release cycle.
2. Keep architecture gate and profile plumbing in place (Qwen profile active, other families blocked).
3. Document Qwen-only scope explicitly in `docs/tools-compact.md` and warning messages.
4. Defer allow-list expansion and family-specific markers/tests to a later phase.

## Phase 3 - Contract alignment (docs vs code)

1. Decide contract for empty-tools prompts under `tools_compact`:
   - strict rejection for all shapes, or
   - conditional/no-op behavior.
2. Update runtime validation and tests to chosen contract.
3. Update `docs/tools-compact.md` and `docs/implementation-migration-plan.md` accordingly.

## Phase 4 - Consistency cleanup

1. Align `reset()` behavior and header comments in `ToolsCompactController`.
2. Keep debug stats semantics explicit (captured at generation-complete vs live state).

## Completion Checklist

- [ ] Chain completion marker is not hardcoded to Qwen syntax.
- [x] Support matrix (Qwen-only vs multi-family) is explicitly decided and documented.
- [ ] Prompt validation contract is unambiguous and tested.
- [ ] Unit tests cover marker detection and chosen contract behavior.
- [ ] Docs reflect real behavior and implementation scope.

## Suggested Implementation Order

1. Marker/profile support + tests.
2. Support matrix decision + code/docs update.
3. Prompt contract decision + code/docs/tests update.
4. Reset/debug consistency cleanup.

