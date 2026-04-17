# Refactor — Team Brief

---

## TL;DR

PR \#1379 ships a useful feature (`tools_compact`) but the code for it is sprinkled across six places in four files, and it deepens an existing duplication between our two LLM context classes. We propose **two small, sequential, no-behavior-change follow-up PRs** that consolidate the feature into one controller and deduplicate the sliding-window code into a shared helper. Net: **\~100 fewer lines of production code, one home per concern, and three known bugs become trivial to fix afterward.**

---

## The problem, in one page

### Problem 1: `tools_compact` doesn't have a home

The feature "anchor tools in the KV cache and compact them after a tool chain completes" is currently implemented like this:

```
┌────────────────────────────────────────────────────────────────────┐
│  LlmContext.hpp                                                    │
│    └─ DynamicToolsState           ← state + slide math             │
│                                                                    │
│  TextLlmContext.cpp                                                │
│    ├─ tokenizeChat                ← double-tokenize for boundary   │
│    └─ evalMessageWithTools        ← recordToolBoundary call        │
│                                                                    │
│  MtmdLlmContext.cpp                                                │
│    ├─ tokenizeChat                ← SAME double-tokenize, copy #2  │
│    └─ evalMessageWithTools        ← SAME recordToolBoundary, #2    │
│                                                                    │
│  LlamaModel.cpp                                                    │
│    ├─ formatPrompt                ← prompt-shape validation        │
│    ├─ processPromptImpl           ← post-generation trim           │
│    └─ runtimeDebugStats           ← debug fields on ReloadableState│
└────────────────────────────────────────────────────────────────────┘
```

**Any future change to `tools_compact` touches at least 3 of those 6 places.** That's the classic sign of a missing abstraction — the feature is everywhere and nowhere.

### Problem 2: Text and Mtmd contexts duplicate the sliding-window path

The KV-cache sliding logic (what happens when the context fills up and we need to discard old tokens to make room) exists in **two near-duplicate copies**, one in each context:

| What | Text | Mtmd |
| :---- | :---- | :---- |
| Prefill slide ladder | `TextLlmContext.cpp:309-357` | `MtmdLlmContext.cpp:273-318` |
| Generation-time slide | `TextLlmContext.cpp:423-470` | `MtmdLlmContext.cpp:381-428` |

Every change PR \#1379 made to sliding had to be done **twice** — doubling both the implementation and the review surface.

### Problem 3: Validation and testing are fragile

Because the feature's validation (prompt-shape checks) is embedded in `LlamaModel::formatPrompt`'s generic JSON parser, and because its state machine is tangled with the context class that owns a `llama_context`:

- **Validation is under-enforced**. `docs/tools-compact.md` promises four rules; the code only enforces one of them, and even that one has a buggy predicate (`isLastUserMsg` uses raw JSON indices — wrong for the canonical valid shape). PR \#1379 review already flagged this.  
- **Tests require a loaded Qwen3 model**. On CI without the model file they silently `GTEST_SKIP`. This is why the `isLastUserMsg` bug above went uncaught — the rejection tests designed to find it never run on CI.  
- **There's dead code**. `firstToolIndex` is computed but never read. It looks like the seed of a contiguity check that was never finished.

---

## The solution, conceptually

### Give the feature a home — `ToolsCompactController`

One class, one file pair, owns the whole feature end-to-end:

```
┌────────────────────────────────────────────────────────────────────┐
│  ToolsCompactController (NEW)                                      │
│                                                                    │
│    validatePrompt()        ← replaces formatPrompt's embedded guard│
│    onTokenize()            ← replaces the double-tokenize blocks   │
│    onEvalComplete()        ← replaces recordToolBoundary calls     │
│    clampDiscard()          ← used by the sliding helper (below)    │
│    onSlide()               ← used by the sliding helper (below)    │
│    onGenerationComplete()  ← replaces post-generation trim         │
│    debugSnapshot()         ← replaces runtimeDebugStats plumbing   │
└────────────────────────────────────────────────────────────────────┘
```

Owned by `LlamaModel`. Contexts hold a reference. Nobody reaches into the controller to read private state; they call a method.

### Give duplicated sliding a helper — `ContextSlider`

Two free functions replace the two near-duplicate ladders:

```
trySlidePrefill(llama_context*, nPast, firstMsgTokens, nTokens,
                nDiscarded, ToolsCompactController&) → SlideOutcome

trySlideGeneration(llama_context*, nPast, firstMsgTokens,
                   nDiscarded, ToolsCompactController&) → SlideOutcome

SlideOutcome = { Slid | FullWipe | Overflow | NotNeeded, newNPast, discarded }
```

Each context's slide-related functions collapse to a `switch` over the outcome.

---

## Class ownership map

### Where `LlmContext` lives today

File: `packages/qvac-lib-infer-llamacpp-llm/addon/src/model-interface/LlmContext.hpp` (350 lines). The file currently declares **two** classes back-to-back:

| Lines | Declaration |
| :---- | :---- |
| 114-174 | `class DynamicToolsState` — holds the whole `tools_compact` state |
| 176-350 | `class LlmContext` — the abstract base for `TextLlmContext` / `MtmdLlmContext`; contains `DynamicToolsState dynamicToolsState_` as a private member and exposes `dynamicToolsState()` accessors |

That means every `LlmContext` subclass (including any test mock that happens to inherit `LlmContext`) carries `tools_compact` state it may not want.

### Before — who owns what today

| Class | Owns |
| :---- | :---- |
| `LlmContext` (abstract) | The full `tools_compact` state, via `DynamicToolsState dynamicToolsState_` member. Exposes `dynamicToolsState()` accessor (mutable \+ const). |
| `TextLlmContext : LlmContext` | Everything text-specific **\+** inherited `dynamicToolsState_`. |
| `MtmdLlmContext : LlmContext` | Everything vision-specific **\+** inherited `dynamicToolsState_`. |
| `LlamaModel` | `std::unique_ptr<LlmContext> llmContext_` (inside `ReloadableState`), plus scratch fields `lastNPastBeforeTools_` and `lastToolsTrimmed_` on `ReloadableState` for debug stats. Reads the state it morally drives via `state_->llmContext_->dynamicToolsState().xxx()` chains. |

Pain points:

- `LlamaModel` **reaches two pointers deep** (`state_->llmContext_->dynamicToolsState()`) to poke at state whose decisions (config, validation, trim) live on `LlamaModel` itself.  
- **State lives on the abstract base** — there's no way for a future subclass to opt out of carrying it.

### After — who owns what (post-Refactor 1\)

`LlmContext.hpp` shrinks to \~250 lines. `DynamicToolsState` is **removed** from this file and moves into its own `ToolsCompactController.{hpp,cpp}` pair.

| Class | Owns | Exposes |
| :---- | :---- | :---- |
| **`ToolsCompactController`** (NEW) | Every bit of `tools_compact` state: `enabled_`, `nConversationOnlyTokens_`, `nPastBeforeTools_`, `lastRunInfo_` (anchor \+ trimmed flag, used by debug stats). | `validatePrompt`, `onTokenize`, `onEvalComplete`, `clampDiscard`, `onSlide`, `onGenerationComplete`, `debugSnapshot`, `reset`, `enabled`, `anchor`. |
| **`LlmContext`** (abstract) | **Nothing `tools_compact`\-related.** Same virtual interface as before (`evalMessage`, `generateResponse`, `getNPast`, …) — byte-identical from the outside. | Unchanged. |
| **`TextLlmContext : LlmContext`** | All its existing text-specific state \+ one new non-owning field: `ToolsCompactController& tools_`. | Unchanged public interface. |
| **`MtmdLlmContext : LlmContext`** | All its existing vision-specific state \+ the same non-owning `ToolsCompactController& tools_`. | Unchanged public interface. |
| **`LlamaModel`** | `std::unique_ptr<ToolsCompactController> tools_` (sole owner) **and** `std::unique_ptr<LlmContext> llmContext_` (sole owner, unchanged). `ReloadableState::lastNPastBeforeTools_` and `lastToolsTrimmed_` are **deleted** — their values are now inside `ToolsCompactController::lastRunInfo_`. | Unchanged public interface. |

### Class details — what each class looks like after

#### `ToolsCompactController` — NEW

Lives in `ToolsCompactController.{hpp,cpp}`. One class, one file pair, \~180 lines of implementation. Owns everything about `tools_compact`.

```c
class ToolsCompactController {
public:
  explicit ToolsCompactController(bool enabled);

  [[nodiscard]] bool enabled() const noexcept;
  [[nodiscard]] llama_pos anchor() const noexcept;

  // ── Prompt-level (called once per inference, before tokenization) ─────
  void validatePrompt(const std::vector<common_chat_msg>& chatMsgs,
                      const std::vector<common_chat_tool>& tools,
                      const PromptLayout& layout) const;

  // ── Tokenize/eval lifecycle (called by the concrete contexts) ────────
  void onTokenize(std::size_t tokensWithTools,
                  std::size_t tokensWithoutTools);
  void onEvalComplete(llama_pos nPast, llama_pos totalTokensEvaled);

  // ── Sliding-window hooks (called by ContextSlider) ───────────────────
  [[nodiscard]] llama_pos clampDiscard(llama_pos requested,
                                      llama_pos firstMsgTokens) const noexcept;
  void onSlide(llama_pos discarded, llama_pos firstMsgTokens) noexcept;
  [[nodiscard]] bool degenerateBoundary(llama_pos firstMsgTokens) const noexcept;
  [[nodiscard]] bool usableBoundary(llama_pos firstMsgTokens) const noexcept;

  // ── Post-generation decision (called by LlamaModel::processPromptImpl) ─
  struct TrimDecision {
    bool       trim = false;
    llama_pos  tokensToRemoveFromTail = 0;
    bool       clampFirstMsgTokensToNPast = false;
  };
  [[nodiscard]] TrimDecision
  onGenerationComplete(std::string_view assistantOutput,
                       llama_pos nPast, llama_pos firstMsgTokens);

  // ── Lifecycle ────────────────────────────────────────────────────────
  void reset() noexcept;

  // ── Debug stats (read by LlamaModel::runtimeDebugStats) ──────────────
  struct DebugSnapshot {
    llama_pos nPastBeforeTools = -1;
    bool      lastToolsTrimmed = false;
  };
  [[nodiscard]] DebugSnapshot debugSnapshot() const noexcept;

private:
  const bool enabled_;
  llama_pos  nConversationOnlyTokens_ = 0;
  llama_pos  nPastBeforeTools_        = -1;

  // Captured at the start of onGenerationComplete, surfaces via
  // debugSnapshot so runtimeDebugStats reads the anchor position
  // at the moment of chain completion (not post-trim).
  struct LastRunInfo {
    llama_pos anchorAtGenerationEnd = -1;
    bool      trimmed               = false;
  };
  LastRunInfo lastRunInfo_;
};
```

Companion struct (lives in the same header so callers can populate it without depending on anything internal):

```c
struct PromptLayout {
  std::optional<size_t> firstToolIdx;   // first `{type: function}` in JSON array
  std::optional<size_t> lastToolIdx;    // last  `{type: function}` in JSON array
  std::optional<size_t> lastAnchorIdx;  // last user/tool role in JSON array
  size_t totalItems = 0;
  size_t toolCount  = 0;
};
```

#### `ContextSlider` — NEW (free functions, no state)

Lives in `ContextSlider.{hpp,cpp}`, \~120 lines total. Replaces the near-duplicate sliding ladders in both contexts.

```c
struct SlideOutcome {
  enum class Kind {
    NotNeeded,   // context had enough room
    Slid,        // successful partial slide
    FullWipe,    // fallback: wiped everything after firstMsgTokens (prefill only)
    Overflow,    // could not free enough; caller throws
  };
  Kind      kind      = Kind::NotNeeded;
  llama_pos newNPast  = 0;
  llama_pos discarded = 0;
};

SlideOutcome trySlidePrefill(llama_context* lctx, llama_pos nPast,
                             llama_pos firstMsgTokens,
                             llama_pos nTokensToAppend, llama_pos nDiscarded,
                             ToolsCompactController& tools);

SlideOutcome trySlideGeneration(llama_context* lctx, llama_pos nPast,
                                llama_pos firstMsgTokens,
                                llama_pos nDiscarded,
                                ToolsCompactController& tools);
```

Each context's slide block collapses from \~50 lines of conditionals down to a 5-line `switch` on `SlideOutcome::Kind`.

#### `LlmContext` — subtractively changed

Stays in `LlmContext.hpp`. Same abstract base class, **19 virtual methods unchanged**. Three things are deleted:

| Deletion | Was at | Why it goes |
| :---- | :---- | :---- |
| `class DynamicToolsState { ... }` (60 lines) | `LlmContext.hpp:114-174` | Replaced by `ToolsCompactController` in its own file. |
| `DynamicToolsState& dynamicToolsState()` accessors (2) | `LlmContext.hpp:277-280` | Nobody reaches through `LlmContext` for `tools_compact` state anymore. |
| `DynamicToolsState dynamicToolsState_` private member | `LlmContext.hpp:349` | Deleted along with the class. |

One thing is added: a forward declaration `class ToolsCompactController;` near the includes, so derived classes can hold a reference.

Net: file shrinks from 350 to \~250 lines. Virtual interface byte-identical → nothing downstream breaks.

#### `TextLlmContext` — one new member, body tweaks only

Public interface and class layout are unchanged. Two changes:

**Constructor signature**:

```c
// before
TextLlmContext(common_params&, common_init_result&&, bool toolsCompact);
// after
TextLlmContext(common_params&, common_init_result&&,
               ToolsCompactController& tools);
```

**Private members** — the existing 18 stay as-is, one is added:

| Kept | Added | Removed |
| :---- | :---- | :---- |
| `llamaInit_`, `model_`, `lctx_`, `vocab_`, `smpl_`, `params_`, `tmpls_`, `antipromptTokens_`, `nPast_`, `nDiscarded_`, `firstMsgTokens_`, `nSlides_`, `threadpool_`, `threadpoolBatch_`, `utf8Buffer_`, `reasoningState_`, `isQwen3Model_`, `stopGeneration_` | `ToolsCompactController& tools_` (non-owning reference, bound in ctor) | *(nothing — `dynamicToolsState_` was inherited, now lives elsewhere)* |

**Method bodies that change** (signatures untouched):

- `tokenizeChat` — the 15-line double-tokenize block becomes one `tools_.onTokenize(withSize, withoutSize)` call.  
- `evalMessageWithTools` — ends with `tools_.onEvalComplete(nPast_, inputTokens.size())` instead of `dynamicToolsState().recordToolBoundary(...)`.  
- The prefill slide ladder and `applyContextDiscard` — each collapses to a `trySlide*` call \+ `switch` after Refactor 2\.

#### `MtmdLlmContext` — mirrors `TextLlmContext`

Same two changes: constructor parameter swap \+ one new `ToolsCompactController& tools_` reference. The 15 Mtmd-specific members (`ctxVision_`, `bitmaps_`, …) stay exactly as-is.

Same method-body rewrites (double-tokenize block, eval-complete hook, slide block). Vision-specific code paths (`initVisionContext`, `loadMedia`, `resetMedia`, chunked eval) are untouched.

#### `LlamaModel` — one new owned field, two scratch fields removed

Changes land on three parts of the class.

**Private members**:

| Added | Removed |
| :---- | :---- |
| `std::unique_ptr<ToolsCompactController> tools_;` (sole owner, declared **before** `state_` so it is destroyed **after** the context) | `ReloadableState::lastNPastBeforeTools_` (scratch debug field, now inside `ToolsCompactController::lastRunInfo_`) |
|  | `ReloadableState::lastToolsTrimmed_` (same as above) |

**Methods with body rewrites** (all public signatures unchanged):

| Method | Change |
| :---- | :---- |
| `init` | After `commonParamsParse`, construct `tools_ = std::make_unique<ToolsCompactController>(toolsCompact)`, then pass `*tools_` into `createContext`. |
| `createContext` | Parameter `bool toolsCompact` → `ToolsCompactController& tools` (forwarded to the concrete context's ctor). |
| `formatPrompt` | Populate a `PromptLayout` while walking the JSON array (tracking `firstToolIdx`, `lastToolIdx`, `lastAnchorIdx`, `toolCount`); replace the broken `isLastUserMsg`/`firstToolIndex` block with one call: `tools_->validatePrompt(chatMsgs, tools, layout)`. |
| `processPromptImpl` | The 25-line post-generation "degenerate / usable / trim" block becomes `auto d = tools_->onGenerationComplete(...)` followed by `if (d.trim) { llmContext_->removeLastNTokens(d.tokensToRemoveFromTail); ... }`. |
| `runtimeDebugStats` | Reads `tools_->debugSnapshot()` instead of `state_->lastNPastBeforeTools_` / `state_->lastToolsTrimmed_`. |
| `getNPastBeforeTools` | Delegates to `tools_->anchor()`. |

Every other public method (`process`, `runtimeStats`, `finetune`, `reload`, `cancel`, etc.) is unchanged.

---

### Ownership & lifetime chain

```
LlamaModel
 ├── std::unique_ptr<ToolsCompactController> tools_ ────────┐
 │       (sole owner, lifetime == LlamaModel)                │
 │                                                           │
 └── std::unique_ptr<LlmContext> llmContext_                 │
     (sole owner, lifetime ⊆ LlamaModel's lifetime)          │
         │                                                   │
         │ at construction: LlamaModel passes *tools_ by ref │
         ▼                                                   │
   ┌─────────────────────────────────┐                               │
   │ TextLlmContext or MtmdLlmContext│                       │
   │   ToolsCompactController& tools_├───────────────────────┘
   │   (non-owning reference)        │
   └─────────────────────────────────┘
```

**Lifetime invariant**: `ToolsCompactController` is owned by `LlamaModel`; any context `LlamaModel` creates is also owned by `LlamaModel`. The reference held by the context can never dangle.

### Why this placement (three reasons)

1. **Callers are on `LlamaModel`, not on `LlmContext`.** Configuration parse, prompt-shape validation, and post-generation trim all live in `LlamaModel`. Putting the controller on `LlamaModel` eliminates the `state_->llmContext_->dynamicToolsState().xxx()` Law-of-Demeter chains.  
     
2. **Reference on the concrete derived classes, not on the abstract base.** A C++ reference must be initialized in the constructor's member-initializer list; putting it on `LlmContext` forces every subclass — including test mocks that don't care about `tools_compact` — to thread a real controller through. Keeping the reference on the concrete `TextLlmContext` / `MtmdLlmContext` is cleaner.  
     
3. **`std::unique_ptr` makes ownership unambiguous.** There's exactly one line that decides when the controller is freed: `LlamaModel`'s destruction. No shared ownership, no refcount, no lifetime puzzle.

## What this unlocks

| Benefit | Concretely |
| :---- | :---- |
| **Feature is testable without a model** | `test_tools_compact_controller.cpp` exercises the state machine with plain C++ — no Qwen3 download, always runs on CI. The bugs flagged in \#1379 review become \~10-line fixes inside a class that has real tests. |
| **Sliding changes touch one file** | Every PR that changes KV sliding becomes half the diff and half the review. |
| **Docs and code agree** | The four prompt-shape rules in `docs/tools-compact.md` get enforced for real in `validatePrompt`. The broken `isLastUserMsg` predicate goes away. |
| **Less inappropriate intimacy** | No more `state_->llmContext_->dynamicToolsState().xxx()` chains from `LlamaModel`. |
| **Net code reduction** | \~100 fewer lines in production despite adding two new classes — because the duplicated logic collapses. |

---

## The plan

One PR, behaviorally no-op at the feature level, gated on the full existing test suite passing unchanged.

Implementation should be split across **commit-sized units** (3 or more commits) to keep review and bisect quality high.

| \# | Commit title (example) | What it does | Risk | Review effort |
| :---- | :---- | :---- | :---- | :---- |
| 1 | `refactor(llamacpp-llm): extract tools compact controller` | Creates the controller. Moves validation, tokenize hook, eval hook, trim decision, debug snapshot into it. | Low | Small |
| 2 | `refactor(llamacpp-llm): extract context slider helpers` | Replaces the four slide-related functions (two per context) with calls into `trySlidePrefill` / `trySlideGeneration`. | Low | Small |
| 3 | `test(llamacpp-llm): migrate tools compact tests to deterministic unit coverage` | Moves/removes model-dependent duplicate tests and adds model-free controller tests that run on CI. | Low | Small |
| 4+ | `fix/chore(llamacpp-llm): targeted follow-ups as needed` | Optional cleanup (dead fields, UB guardrails, minor polish) kept in separate commits if required. | Low | Small |

The full set should land as one cohesive PR.

Within that PR, keep any fix-oriented changes (for example dead `firstToolIndex`, empty-`chatMsgs` UB handling, or test migration cleanups) as separate commits so they remain easy to review and cherry-pick.

### Suggested commit messages

1. `mod: extract tools compact controller from llm contexts`
2. `mod: extract shared context slider helpers for text and mtmd`
3. `test: migrate tools compact coverage to deterministic unit tests`
4. `fix: harden tools compact edge cases and remove dead fields` *(optional, only if fixes are included)*
5. `doc: update tools compact structure and migration docs` *(optional, if docs are adjusted during implementation)*

---

## A taste of the payoff

**Before** (`LlamaModel::processPromptImpl`, the post-generation trim block — 25 lines of tangled conditionals):

```c
auto& dts = state_->llmContext_->dynamicToolsState();
state_->lastNPastBeforeTools_ = dts.nPastBeforeTools();
state_->lastToolsTrimmed_ = false;
const llama_pos firstMsgTokens = state_->llmContext_->getFirstMsgTokens();

if (dts.hasDegenerateToolBoundary(firstMsgTokens)) {
  QLOG_IF(Priority::WARNING, string_format(...));
  dts.reset();
}

if (dts.hasUsableToolBoundary(firstMsgTokens) &&
    state_->llmContext_->getNPast() > dts.nPastBeforeTools()) {
  std::string ossStr = needsOutputCapture ? oss.str() : std::string();
  const std::string& outputToCheck = needsOutputCapture ? ossStr : out;
  bool hasToolCall = outputToCheck.find("<tool_call>") != std::string::npos;
  if (!hasToolCall) {
    state_->lastToolsTrimmed_ = true;
    state_->llmContext_->removeLastNTokens(
        state_->llmContext_->getNPast() - dts.nPastBeforeTools());
    dts.reset();
    if (state_->llmContext_->getFirstMsgTokens() >
        state_->llmContext_->getNPast()) {
      state_->llmContext_->setFirstMsgTokens(state_->llmContext_->getNPast());
    }
  }
}
```

**After** (same behavior, \~10 lines of dispatch — the state machine is in the controller and has its own unit tests):

```c
auto decision = tools_->onGenerationComplete(
    outputToCheck,
    state_->llmContext_->getNPast(),
    state_->llmContext_->getFirstMsgTokens());
if (decision.trim) {
  state_->llmContext_->removeLastNTokens(decision.tokensToRemoveFromTail);
  if (decision.clampFirstMsgTokensToNPast &&
      state_->llmContext_->getFirstMsgTokens() >
          state_->llmContext_->getNPast()) {
    state_->llmContext_->setFirstMsgTokens(state_->llmContext_->getNPast());
  }
}
```

The `LlamaModel` stops making decisions about *how* `tools_compact` works. It just asks "is the chain done, should I trim?" and does the trim.

---

## Multi-family support

After Refactors 1+2 the state machine is already model-agnostic for everything except **one** hard-coded Qwen3-ism: the `<tool_call>` substring in `onGenerationComplete`. Different families emit different markers:

| Family | Tool-call marker |
| :---- | :---- |
| Qwen3 | `<tool_call>` |
| Llama 3.1 | \`\< |
| Mistral | `[TOOL_CALLS]` |

An optional follow-up (detailed in **`pr-1379-refactor-proposal.md` §11 Appendix**) introduces a tiny `ToolsCompactProfile` struct that carries the per-family marker (and future per-family knobs). `LlamaModel::init` picks a profile from `general.architecture` metadata and hands it to the controller; `onGenerationComplete` reads `profile_.toolCallMarker` instead of a hard-coded constant.

### After the optional appendix, adding a new family is 4 edits:

1. **Write the Jinja template** (unavoidable — each family's tokenizer/convention is different).  
2. **Add one arm to `selectToolsCompactProfile`** (`ChatTemplateUtils.cpp`, one line):

```c
if (archStr == "llama") return { "<|python_tag|>" };
```

3. **Add one arm to `getChatTemplateForModel`** (`ChatTemplateUtils.cpp`, \~5 lines).  
4. **Extend the config-parse allow-list** in `LlamaModel::commonParamsParse` (one line).

**No changes to `ToolsCompactController`, `ContextSlider`, `LlmContext`, or either concrete context.** The state machine stays untouched.

### When to take this appendix

- **Take it** if you know a second model family is landing within 3–6 months.  
- **Skip it** if Qwen3 is the only tools-compact target for the foreseeable future — YAGNI, and the main refactor already reduces "add a family" to small, localized edits.

---

## Settled design decisions

| Question | Decision | Why |
| :---- | :---- | :---- |
| Where does `ToolsCompactController` live? | On `LlamaModel`, passed by reference to contexts | Biggest callers (config, validation, trim) are on `LlamaModel`. Avoids `state_->llmContext_->xxx()` chains. |
| Is `ContextSlider` a class? | No — namespaced free functions | Stateless helper, same pattern as existing `ChatTemplateUtils`. |
| Support non-Qwen3 model families in scope? | Yes, it needs to be implemented | Controller is already model-agnostic after Refactor 1 except for the `<tool_call>` substring. The appendix flips that to a per-family value and leaves the state machine untouched. |
| Also refactor Qwen3 reasoning (`handleQwen3ReasoningEOS`)? | No | Separate feature, separate PR if ever. |

---
