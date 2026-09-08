# 💥 Breaking Changes v0.18.0

## Remove SDK dynamic tools mode (toolsMode)

PR: [#3380](https://github.com/tetherto/qvac/pull/3380)

**BEFORE:**
```typescript
// old — SDK dynamic tools mode
import { loadModel, TOOLS_MODE, type ToolsMode } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: QWEN3_1_7B_INST_Q4,
  modelType: 'llm',
  modelConfig: { ctx_size: 4096, tools: true, toolsMode: TOOLS_MODE.dynamic }
})
```

**AFTER:**
```typescript
// new — TOOLS_MODE/ToolsMode exports removed; tools are always prepended
// after the system message (the previous static default). The `toolsMode`
// key must be removed: passing it to loadModel now throws a validation
// error rather than being ignored.
import { loadModel } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: QWEN3_1_7B_INST_Q4,
  modelType: 'llm',
  modelConfig: { ctx_size: 4096, tools: true }
})
```

## 📦 Release coordination (deferred, no version bump in this PR)

Per the no-version-bump plan, these are captured at the next coordinated release rather than in this PR:

- **SDK release notes** must document the removed public `TOOLS_MODE`/`ToolsMode` exports + `toolsMode` config field, state that the key must be removed (it is rejected, not ignored), note the one-time KV-cache invalidation described above, and version the release as breaking.
- **opencode plugin changelog** should note that the `toolsMode: 'static'` pin was dropped (behavior-neutral — `static` was the default and the key no longer exists) at the plugin's next release.
- **Lockstep with #3373:** the `@qvac/sdk` release that advances its `@qvac/llm-llamacpp` dependency past the addon's `tools_compact` removal must include this change, so no build pairs the old `tools_mode`→`tools_compact` mapping with a new addon. This cannot happen silently — the addon shipped the removal as a minor bump (0.43.0) and the SDK pins `^0.39.3`, which caret-on-zero-major caps below 0.40.0 — so the requirement binds to the PR that raises that range, not to any existing published build.


---
- To see the specific tasks where the Asana app for GitHub is being used, see below:
  - https://app.asana.com/0/0/1217241821002583

---

## Add CosyVoice3 TTS support to the SDK

PR: [#3857](https://github.com/tetherto/qvac/pull/3857)

**BEFORE:**
```typescript
textToSpeech({ modelId, text, pace: 'very fast' }) // accepted, engine-dependent behavior
```

**AFTER:**
```typescript
textToSpeech({ modelId, text, pace: 'fast' }) // pace: 'slow' | 'moderate' | 'fast'
```

---

