# SDK Plugin Integration Checklist

Domain-specific checklist for reviewing `tetherto/qvac` PRs that touch SDK plugin code. Loaded conditionally from `SKILL.md` step 6b.

**Source of truth:** the SDK pod's plugin integration checklist. When the canonical checklist evolves, paste the new version into "The checklist" section below. The snapshot here is assumed current unless the user says otherwise.

---

## When to apply (trigger paths)

Apply this checklist **only** when the PR is in `tetherto/qvac` AND touches at least one of:

- `packages/sdk/server/bare/plugins/**` — plugin code itself
- `packages/sdk/schemas/plugin.ts` — plugin contract types, `ADDON_*` constants, `SDK_DEFAULT_PLUGINS`
- `packages/sdk/schemas/load-model.ts` — load-model contract; plugin schema changes flow through here
- New `packages/sdk/schemas/*-config.ts` files — typically a new plugin config schema
- `packages/sdk/server/worker.ts` — plugin registration
- `packages/sdk/commands/bundle/**` — bundler `BUILTIN_PLUGINS` mapping (a new plugin must be registered here to be bundleable)

**Don't trigger on:**

- `packages/sdk/client/**` only — covered by general SDK cursor rules
- `packages/sdk/utils/**`, `packages/sdk/profiling/**` — internal helpers
- `packages/sdk/models/registry/**` only — auto-gen registry drift
- `packages/sdk/e2e/**` only — test-only additions

For non-plugin SDK PRs, the general SDK conventions are already enforced by the workspace cursor rules (`.cursor/rules/sdk/main.mdc`, `e2e.mdc`, etc.) — re-running this checklist would just be noise.

---

## How to apply

The checklist's value is **catching plugin-architecture gaps the cursor rules don't cover** — the `definePlugin` contract, 1:1 plugin↔package coupling, cross-cutting registration points (`server/worker.ts` + `plugins/index.ts` + `package.json` exports + bundler `BUILTIN_PLUGINS`), strict unknown-key policy on plugin configs, role-based companion naming, and the streaming protocol with exactly one terminal `done: true`.

When applying:

1. **Walk the checklist mentally** but skip items that are obviously N/A for the PR (e.g. "no new plugin → skip bundler `BUILTIN_PLUGINS`", "no companion artifacts → skip role-based companion naming"). Don't list N/A items in the output.
2. **Verify each non-N/A item against the diff or the worktree.** Same confidence-floor rule as the rest of the skill: a finding is either verified (you read the code at the PR head SHA) or framed as an honest question. No speculation.
3. **Surface only what matters.** Don't dump a wall of green checkmarks. The output highlights gaps and "needs attention" items, with at most a single `✅ aligned` line summarizing the rest.
4. **Real blocking gaps feed the inline-comment selection too.** A gap that lives on a specific line (e.g. a plugin not added to `server/worker.ts`, a flat companion field instead of role-based naming) becomes a finding in step 6's severity classification and flows into the step 7b inline-comment picker, pinned to that file:line. The checklist block in the overview is the cross-cutting summary, not a replacement for line-level comments.

---

## Output integration

When triggered, add an optional `### SDK plugin checklist` section to the step 7a chat overview (after `### Verified (no action)`, before the closing `PR diff:` line). Findings that warrant inline comments are classified by severity in step 6 like any other finding and picked in step 7b — they are not posted separately.

````markdown
### SDK plugin checklist

✅ Aligned — <one short line summarizing the bulk that passes>

⚠️ Gaps / needs attention
- **<item>** — <what's missing or stale, plus file:line if applicable>
- **<item>** — <...>

🤔 Worth a check (non-blocking)
- <one-liner> — <why>
````

Rules for this section:

- **Skip the section entirely** if the PR triggers the checklist but every item is aligned or N/A. Just don't emit it.
- **Skip `🤔 Worth a check`** if there's nothing in it. Don't write "(none)".
- If `⚠️ Gaps` is empty, skip the whole section per the rule above.
- Keep each gap item to one or two lines. Push line-level nuance into the inline comment under step 7b/8.
- Prefer concrete claims over abstract ones. "no comment justifying `skipPrimaryModelPathValidation: true` on plugin.ts:89" beats "documentation gap on plugin contract".

---

## The checklist

> Use this checklist when adding or reviewing a new plugin. Every item should be verified before merge.

### API Design Philosophy

- The SDK is a facade, not a proxy.
- Plugin API is product-oriented, not implementation-oriented.
- Usage approaches a one-liner for the common case, with advanced options available when needed.
- SDK reshapes the add-on API where it improves clarity.
- No add-on internals leak into the public SDK surface.
- Level of abstraction is proportional to the add-on's complexity.

### Structural & Architectural Alignment

- Plugin ↔ package coupling is 1:1 by design. Every native addon is its own npm package and a plugin is pinned to its package via the required `addonPackage` field. If a new capability does not justify a new addon package, implement it inside the existing plugin — do NOT split it into a new plugin reusing another addon's package.
- Plugin lives under `server/bare/plugins/<engine-usecase>/plugin.ts`.
- Folder name is canonical engine-usecase kebab-case and matches the plugin's `modelType`.
- Plugin uses `definePlugin()`; handlers use `defineHandler()` (or `defineDuplexHandler()` for client → server streaming input).
- Registers via `registerPlugin()` with a unique, canonical `modelType`, a non-empty `addonPackage`, and is validated at runtime by `pluginDefinitionRuntimeSchema`.
- Bare-runtime server code imports only Bare-compatible modules or existing SDK abstractions.
- No client/server boundary violations.
- RPC handlers orchestrate only.
- If a handler manually wraps a stream with `next`, it uses `try/finally` and calls `stream.return()` for cleanup.

### Plugin Contract

- `loadConfigSchema` is defined.
- `createModel(...)` is deterministic and performs no network I/O.
- Runtime file dependencies are resolved in `resolveConfig(...)` via `ctx.resolveModelPath(...)`.
- If plugin returns artifacts, keys are plugin-owned and do not collide with reserved/core keys.
- `resolveConfig(...)` is deterministic and concurrency-safe.
- If plugin does not require strict primary model-path file checks, sets `skipPrimaryModelPathValidation: true` **with a documented reason**.
- Streaming handlers emit protocol-compliant chunks with exactly one terminal `done: true` chunk.
- No chunks are emitted after the terminal `done: true`.

### Load Model Input / Schema Alignment

- Companion source inputs are inside `modelConfig`.
- No top-level companion source fields are introduced in the `loadModel` request shape.
- Plugin config schemas live in `schemas/<engine>-config.ts` or an existing schema module.
- Unknown-key policy is explicit (strict vs passthrough/loose) and intentional.
- No silent field drops in request transforms.
- Companion model inputs should prefer role-based naming when the role is well defined, e.g. `modelConfig.safetyCheckerModel: { src, type }` or, when no additional metadata is needed, `modelConfig.safetyCheckerModelSrc`, rather than implementation-specific or version-specific flat fields such as `modelConfig.customSafetyNet1ModelSrc`.

### Core Integration Points

- Plugin exported in `server/bare/plugins/index.ts`, registered in `server/worker.ts`, and exposed via `package.json` exports.
- Addon package is referenced by an `ADDON_*` constant in `schemas/plugin.ts` and passed through the plugin's required `addonPackage` field (no string-literal duplication).
- `SDK_DEFAULT_PLUGINS` includes the plugin when applicable.
- New engine/addon classification propagated to `schemas/model-types.ts`, `schemas/engine-addon-map.ts`, `schemas/registry.ts`, and `schemas/get-model-info.ts` as needed.
- Bundler `BUILTIN_PLUGINS` (`modelType` → `exportName`) in `commands/bundle/constants.ts` is updated for new plugins — a plugin missing here won't be bundleable.
- Package exports are updated if the plugin adds or changes public surface.

### Runtime Behavior & Safety

- Artifact resolution uses `resolveModelPath` only for uniform caching and validation.
- `createModel` consumes `modelPath` + `artifacts` + resolved `modelConfig` only.
- Streaming handlers emit protocol-compliant chunks and a final `done` signal.
- Errors use structured SDK errors (`utils/errors-server` / `utils/errors-client`) with actionable messages.
- Logging is model-scoped (`createStreamLogger`) and addon logging registration is wired.
- No unsafe paths or ad-hoc filesystem traversal logic.

### Tests & Validation

- End-to-end tests in the test suite cover the plugin's behavior.
- End-to-end example(s) exist under `packages/sdk/examples/` and reflect the current API shape.
- If adding/changing the client API, ensure `packages/sdk/e2e` is aligned.
- Typecheck and lint pass (`bun run build`).

### Breaking Changes & Docs Hygiene

- Documentation for the plugin is updated in docs; ping docs team if needed.
- API changes are documented in the PR description under **API Changes**.
- Breaking changes are documented under **Breaking Changes**.
- Lockfile / package updates are included when dependencies change.
