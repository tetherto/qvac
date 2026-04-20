# Tools Compact Profile Investigation

## Purpose

Document current design friction around `tools_compact` compatibility and profile derivation, then identify the safest implementation option based on current code paths.

## Context

Today the runtime configuration path effectively does this:

1. Parse user flag `tools_compact` (boolean intent).
2. Detect model architecture compatibility.
3. If compatible, derive `ToolsCompactProfile` (currently marker only).
4. If not compatible, disable `tools_compact` and continue.

This creates two related concerns:

- Runtime support is hard-gated to Qwen3 in `commonParamsParse`.
- Feature state is represented by both:
  - `outToolsCompact` (bool)
  - `outToolsCompactProfile` (struct)

## Current Problems

### 1) Split state (`bool` + `profile`) can drift

`outToolsCompact` and `outToolsCompactProfile` can become logically inconsistent if a future code path updates one and not the other.

Examples:

- bool enabled but empty/invalid profile marker
- profile set but bool disabled

Even if guarded in current code, this is fragile under future edits.

### 2) Capability and activation are mixed

`tools_compact` intent from user config and model capability are merged in one procedural flow. This makes it harder to reason about:

- "feature requested but unsupported"
- "feature requested and supported"
- "feature not requested"

### 3) Marker source is not yet the explicit capability contract

`ChatTemplateUtils` already has `selectToolsCompactMarker(architecture)`, but runtime still treats compatibility as a separate branch concept. The marker lookup should be the primary capability source:

- marker present -> model supports tools_compact protocol
- marker absent -> model does not support tools_compact protocol

### 4) `requested` / `supported` can also drift if represented as plain booleans

A naive "resolved object with booleans" still allows impossible combinations unless every call site keeps invariants in sync. This is better than today's split state, but still not fully type-safe.

## What Current Code Actually Needs

From current implementation:

- Context/template path only needs one runtime bit: `tools_.enabled()`.
- Chain-completion logic (`onGenerationComplete`) needs one model capability datum: `toolCallStartMarker`.
- Parse-time diagnostics must still distinguish:
  - not requested
  - requested but unsupported
  - requested and supported

This suggests runtime state and diagnostics should be separated:

- runtime source of truth: optional profile
- diagnostics source of truth: typed resolution reason

## Investigation Goals

1. Make feature state representation unambiguous.
2. Keep compatibility detection centralized in one place.
3. Preserve current behavior for unsupported models:
   - no crash
   - clear warning
   - feature effectively disabled
4. Minimize future regression surface when adding new model families.

## Design Options

## Option A - Keep `bool + profile`, but formalize invariants

Keep both values, but codify strict invariants and enforce them at boundaries.

Invariants:

- `enabled == false` implies profile marker may be empty.
- `enabled == true` implies profile marker must be non-empty.

Pros:

- Smallest refactor; low disruption.
- Keeps explicit user intent flag visible.

Cons:

- Two-state model remains easier to misuse.
- Requires continued defensive checks in multiple places.

## Option B - Replace with profile-only feature state

Use one value as source of truth:

- `std::optional<ToolsCompactProfile> profile`
  - present -> enabled and supported
  - absent -> disabled (either not requested or unsupported)

User intent can still be logged separately during parse.

Pros:

- Single source of truth for runtime behavior.
- Fewer inconsistent states.
- Natural extension path when profile grows beyond marker.

Cons:

- Requires signature updates where bool is currently passed.
- Need explicit handling/logging so "not requested" vs "unsupported" remains observable.

## Option C - Explicit resolved config object (bool fields)

Introduce a small resolved config type:

```cpp
struct ResolvedToolsCompactConfig {
  bool requested = false;
  bool supported = false;
  std::optional<ToolsCompactProfile> profile;
};
```

Rules:

- `supported == profile.has_value()`
- runtime enablement is `profile.has_value()`
- logging can distinguish all states cleanly (`requested` and `supported`)

Pros:

- Best observability.
- Clear migration path to richer capability matrix.
- Avoids ambiguous bool/profile coupling.

Cons:

- Still permits impossible states unless invariants are manually enforced.
- Slightly more verbose plumbing than Option B.

## Option D - Typed resolution + optional profile (recommended)

Use a typed resolved result where invalid combinations are not representable:

```cpp
enum class ToolsCompactResolution {
  NotRequested,
  RequestedUnsupported,
  RequestedSupported
};

struct ResolvedToolsCompact {
  ToolsCompactResolution resolution;
  std::optional<ToolsCompactProfile> profile; // present only for RequestedSupported
};
```

Rules:

- `RequestedSupported` implies `profile.has_value() == true`.
- `NotRequested` and `RequestedUnsupported` imply `profile.has_value() == false`.
- Runtime enablement is derived only from `profile.has_value()`.

Pros:

- Type-level guard against boolean drift.
- Keeps observability without carrying duplicate runtime booleans.
- Natural fit with current controller API evolution (`enabled` can be derived from profile).

Cons:

- Slightly larger change than Option B.
- Requires updating parse output plumbing and related tests.

## Marker as Capability Contract

`ChatTemplateUtils` should remain the single capability provider for tools_compact protocol support:

- Introduce/keep one API that returns marker by architecture.
- Runtime compatibility decision must be derived from that API only.
- Avoid duplicate architecture allow-lists outside `ChatTemplateUtils`.

Desired rule:

- `marker = selectToolsCompactMarker(architecture)`
- if `marker` is absent, tools_compact cannot be enabled for that model family.

## Recommended Implementation

Implement a narrow RFC-sized change based on Option D:

1. Add `ResolvedToolsCompact` and `ToolsCompactResolution` in model-interface layer.
2. Replace `(bool outToolsCompact, ToolsCompactProfile outProfile)` outputs with one resolved object.
3. Construct controller from resolved profile:
   - either `ToolsCompactController(std::optional<ToolsCompactProfile>)`
   - or keep constructor and pass `enabled = profile.has_value()`.
4. Use marker presence as the sole support gate (no separate architecture allow-list in `LlamaModel`).
5. Keep warning behavior:
   - if requested + unsupported -> warning and disabled runtime behavior.
6. Add a small parse helper to centralize decision logic:

```cpp
ResolvedToolsCompact resolveToolsCompact(
    bool requested,
    const std::string& architecture);
```

This helper should be the only place that maps `(requested, architecture)` to `(resolution, profile)`.

## Why Option D Is Better Than Option C

- Option C improves visibility but still depends on synchronized booleans.
- Option D keeps the same visibility while reducing representational entropy:
  - one enum for reason
  - one optional for runtime state
- This gives clearer downstream handling:
  - logging branches on `resolution`
  - runtime branches on `profile.has_value()`

## Validation Checklist for Follow-up PR

- Unit tests:
  - `NotRequested` -> no profile
  - `RequestedUnsupported` -> no profile + warning path
  - `RequestedSupported` -> profile present
- Integration tests:
  - unsupported family ignores `tools_compact` safely
  - supported family still trims correctly
- Docs:
  - align `tools-compact.md` support matrix wording with resolved behavior
  - update follow-up notes to reference resolved config flow

## Suggested Migration Sequence

1. Introduce `ResolvedToolsCompact` and resolver helper (no behavior change).
2. Switch `commonParamsParse` outputs to resolved type.
3. Update controller construction to derive enablement from `profile`.
4. Add/adjust tests for resolution states.
5. Remove obsolete bool/profile dual-state plumbing.

## Open Questions

1. Should we preserve explicit telemetry for "requested but unsupported" in runtime stats?
2. Should unsupported-model behavior remain warning-only, or become configurable (strict mode)?
3. Do we want a future profile field for prompt-contract variations per family (not just marker)?

