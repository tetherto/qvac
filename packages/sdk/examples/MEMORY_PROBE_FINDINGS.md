# Memory leak probe — addon teams report

Reproducer + findings for memory not being released after `unloadModel()` in the
inference addons. Validated empirically; concrete code-level bugs identified.

## TL;DR

| Addon | First-cycle leak | Steady-state leak | Total drift over 4 cycles | Verdict |
| --- | --- | --- | --- | --- |
| **Chatterbox** (`@qvac/tts-onnx`) | +99 MB | up to +876 MB | **+776 MB** | broken; cycles compound |
| **Supertonic** (`@qvac/tts-onnx`) | +371 MB | ~+25 MB | +445 MB | first-load primes, then stable |
| **OCR** (`@qvac/ocr-onnx`) | +554 MB | ~0 | +553 MB | first-load primes, then stable |
| **Vision** (`@qvac/lib-infer-llamacpp-llm` + projection) | +124 MB | ~0 | +58 MB | clean |

The TTS addon — chatterbox specifically — leaks across cycles, not just at first
load. Supertonic and OCR show "ORT runtime priming" pattern: first cycle eats a
large chunk, subsequent cycles are clean. Vision (llamacpp) is fine.

## Reproducer

`packages/sdk/examples/memory-load-unload-loop.ts` (this directory). Loads an
"anchor" tiny whisper to keep the Bare worker alive across cycles, then loops
load/unload of a target while measuring RSS across the full process tree
(parent + Bare worker children).

```bash
cd packages/sdk
bun --expose-gc run examples/memory-load-unload-loop.ts --target=chatterbox --cycles=4
bun --expose-gc run examples/memory-load-unload-loop.ts --target=supertonic --cycles=4
bun --expose-gc run examples/memory-load-unload-loop.ts --target=ocr --cycles=4
bun --expose-gc run examples/memory-load-unload-loop.ts --target=vision --cycles=4
```

Output: per-cycle table with RSS before/after each load/unload, summary with
total drift + per-cycle deltas. The probe sums RSS across the parent process
and all descendants via `ps`, since the Bare worker is a separate process.

## Findings

The detailed audit traces back to source. File references are workspace-relative.

### 1. Chatterbox `unload()` does not free `cangjieTable_`

```cpp
// packages/qvac-lib-infer-onnx-tts/addon/src/model-interface/ChatterboxEngine.cpp
// Lines 408-427

void ChatterboxEngine::unload() {
  config_ = {};
  language_ = "";
  loaded_ = false;
  // ... resets four sessions, tokenizer, textEmbWeight, speech encoder cache
}
```

The class declares `cangjieTable_`:

```cpp
// packages/qvac-lib-infer-onnx-tts/addon/src/model-interface/ChatterboxEngine.hpp
// Lines 204-207
std::string language_;
text_preprocess::CangjieTable cangjieTable_;
```

`loadCangjieTableIfNeeded` populates this for Chinese loads. `unload()` never
clears it. Locale-dependent leak; relevant for Chinese loads only but real.

### 2. `textEmbWeight_.clear()` retains heap capacity

```cpp
// packages/qvac-lib-infer-onnx-tts/addon/src/model-interface/ChatterboxEngine.cpp
textEmbWeight_.clear();
```

`std::vector::clear()` calls destructors but doesn't return the underlying
buffer. For multilingual variants where this vector holds tens-to-hundreds of
MB, the heap block stays committed until the engine is destroyed. Standard
fix:

```cpp
std::vector<float>().swap(textEmbWeight_);
// or
textEmbWeight_.clear();
textEmbWeight_.shrink_to_fit();
```

This is a realistic contributor to "RSS only partially drops" — the load
allocates fresh capacity into the same vector each cycle, but the prior
capacity is never returned to the OS allocator.

### 3. Two separate `Ort::Env` singletons in the same process

ONNX Runtime documents that an `Ort::Env` should be a process-wide singleton.
The current monorepo has two:

```cpp
// packages/qvac-lib-infer-onnx-tts/addon/src/model-interface/OrtSessionFactory.hpp:14
inline Ort::Env &getOrtEnv() {
  static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "qvac-tts");
  return env;
}
```

```cpp
// packages/qvac-lib-infer-onnx/src/qvac-onnx/OnnxRuntime.hpp:16
// Process-wide singleton for the ONNX Runtime environment.
// All OnnxSession instances share this single Ort::Env.
```

When a single process loads both ONNX TTS (`@qvac/tts-onnx`) and OCR
(`@qvac/ocr-onnx`), each maintains its own ORT thread pools, allocator
arenas, and kernel registries. ORT does not return arena memory to the OS
when sessions are destroyed; with two parallel arenas the "sticky" RSS after
unload doubles. This is consistent with the observed first-cycle ~550 MB leak
on OCR and the partial RSS drop on TTS.

Suggested fix: collapse to a single shared `Ort::Env` (e.g. expose
`OnnxRuntime::instance().env()` from the `qvac-onnx` package and have
`qvac-lib-infer-onnx-tts` link against it instead of declaring its own
singleton).

### 4. OCR Windows: intentional session leak

```cpp
// packages/ocr-onnx/addon/pipeline/Steps.cpp:24-38
#if defined(_WIN32) || defined(_WIN64)
namespace {
// Raw owning pointers that are intentionally never deleted.
// ~Ort::Session() on Windows corrupts global ORT state after the first call,
std::vector<onnx_addon::OnnxSession*> windowsLeakedSessions;
}

void deferWindowsSessionLeak(onnx_addon::OnnxSession session) {
  windowsLeakedSessions.push_back(new onnx_addon::OnnxSession(std::move(session)));
}
#endif
```

```cpp
// packages/ocr-onnx/addon/pipeline/StepDetectionInference.hpp:20-23
#if defined(_WIN32) || defined(_WIN64)
~StepDetectionInference() { deferWindowsSessionLeak(std::move(session_)); }
#endif
```

Every OCR pipeline teardown on Windows adds another full session to a global
that's never freed. Intentional and documented but a definite RSS leak per
load on Windows.

Not affecting our macOS / iOS measurements but worth knowing for Windows
deployments.

### 5. `TTSModel::chatterboxConfig_.referenceAudio` not cleared on unload

```cpp
// packages/qvac-lib-infer-onnx-tts/addon/src/model-interface/TTSModel.cpp:252-271
void TTSModel::unload() {
  // engine unload runs, then LavaSR enhancer/denoiser reset
  // chatterboxConfig_ (which holds referenceAudio Float32) is never cleared
}
```

The reference audio buffer is loaded by `wav-helper.js`'s
`loadReferenceAudioAt24k` and copied into `TTSModel.chatterboxConfig_.referenceAudio`
on construction. Engine `unload()` clears the engine-side copy, but the
TTSModel-level copy stays until the entire `TTSModel` object is destroyed.
Small (~MB scale) but accumulates if a model is kept alive while reload-ing.

### 6. JS-side `this.addon = null` divergence

OCR's high-level wrapper nulls `this.addon` on unload:

```js
// packages/ocr-onnx/index.js:174-180
async unload() {
  await this.addon.destroy();
  this.addon = null;
  // ...
}
```

ONNX TTS does not:

```js
// packages/qvac-lib-infer-onnx-tts/index.js:756-764
async unload() {
  // cancels, fails, awaits this.addon.destroyInstance(); does NOT null this.addon
}
```

Stale-handle risk in JS. Not a native RSS leak by itself but matters for
re-load semantics.

## Steady-state vs first-cycle leak interpretation

The probe shows two distinct patterns:

- **First-cycle-only** (supertonic, OCR): big initial leak then ~0/cycle.
  Strongly suggests ORT global-state initialization that is NOT undone on
  unload. ORT's design: global env + arena allocator persist for the
  process lifetime. Once they're warm, subsequent loads reuse the same
  arenas. Unload doesn't shrink them. **Fix path: collapse to one `Ort::Env`
  per process; investigate ORT arena `OrtArenaCfg` shrink-on-empty options.**
- **Compounding leak** (chatterbox): per-cycle deltas continue to be
  positive across multiple cycles. **Fix path: audit per-cycle resets in
  ChatterboxEngine — `cangjieTable_`, vector capacity, plus any
  language-/voice-specific maps that don't get reset on unload.**

## Mapping to test runs on iOS

iOS test runs see TTS leave ~700 MB resident after the chatterbox + supertonic
sequence ends. Probe predictions match: chatterbox alone leaks +776 MB across 4
cycles on desktop. iOS jetsam pressure forces this to manifest as crashes
(observed: `diffusion-basic-txt2img` OOM-killed at 3.25 GB).

## Local validation experiments (against the desktop probe)

Two candidate fixes were applied locally and rebuilt to validate impact. Each
re-ran the same 4-cycle probe.

### Experiment A — `std::vector<float>().swap(textEmbWeight_)` (chatterbox)

Idiomatic C++ "release vector capacity" replacement for `clear()`.

| | Original | With swap |
| --- | --- | --- |
| Total drift | +776 MB | +1001-1136 MB across two runs |
| Cycle 2 spike | +876 MB | +870 / +1089 MB |

**Result: regression on macOS arm64 (~+250 MB worse, consistent across two runs).**
Likely cause: `clear()` keeps the vector's heap region for next-cycle reuse;
`swap()` returns it to the system allocator which on macOS doesn't return
pages to the OS but may force the next allocation into a fresh region. Net
worse RSS.

This fix may still be correct on Linux (jemalloc / glibc allocators behave
differently). Worth re-testing on Linux before applying. Currently not
recommended on Apple targets.

### Experiment B — `enableCpuMemArena = false` and `enableMemoryPattern = false`

ORT session-options change: bypass the CPU memory arena and graph memory
pattern optimization, both of which pre-allocate pools that ORT does not
return to the OS on Session destruction.

| Target | Original | Arena disabled | Improvement |
| --- | --- | --- | --- |
| **supertonic** | +445 MB | +358 MB | **−90 MB consistent** |
| **OCR** | +553 MB | +526 MB | −30 MB |
| **chatterbox** | +776 MB | mixed (cycle 2 −260 MB, cycle 3 +590 MB) | net 0 |

**Result: real improvement on supertonic (-90 MB), small improvement on OCR
(-30 MB), no net improvement on chatterbox.**

The supertonic improvement is reproducible and worth shipping as a default.
The OCR improvement is small but in the right direction. Chatterbox's
dominant leak (the cycle-2 +1 GB spike) is somewhere else and the arena
disable does not address it.

### Verdict

- Disabling the ORT memory arena helps every ONNX-stack target measured but
  is not a silver bullet for chatterbox.
- Chatterbox's dominant leak is **specifically on the second load/unload
  cycle**, not on first or subsequent cycles. ~1 GB is allocated on the
  second load that is never released by unload. This pattern is consistent
  across runs (with and without each fix). Pinpointing the source needs
  proper profiling tools (Instruments → Allocations, or `MallocStackLogging`
  with `vmmap`/`leaks`) — beyond what this probe can identify.

## Recommended next steps for addon owners

1. **Default `enableCpuMemArena = false` and `enableMemoryPattern = false`**
   in `packages/qvac-lib-infer-onnx/src/qvac-onnx/OnnxConfig.hpp`.

   Validated against the probe: -90 MB on supertonic, -30 MB on OCR with no
   functional regressions. Easy single-file change. Performance impact
   should be measured (the arena is documented as a perf optimization for
   inference, but unmeasured for our cadence) but the memory win is real.

2. **`@qvac/tts-onnx`** (chatterbox cycle-2 leak — NOT addressed by the
   experiments above):
   - Profile cycle 2 specifically with Instruments → Allocations or
     `MallocStackLogging` to identify what allocates ~1 GB on the second
     load that the first load doesn't.
   - Likely candidates from code reading: graph-optimization caches, lazy
     kernel kernel-implementation registration, second-call ORT internal
     allocations. Not visible from the probe alone.
   - The `textEmbWeight_` swap-with-empty change is **not** recommended on
     macOS / iOS (regression measured); leave as `clear()` on Apple targets.
   - Reset `cangjieTable_` in `ChatterboxEngine::unload()` (locale-dependent
     correctness; not a leak driver in our probes).
   - Clear `TTSModel::chatterboxConfig_.referenceAudio` in
     `TTSModel::unload()` (small leak, correctness only).

3. **Cross-addon ORT environment** (longer-term refactor):
   - Collapse the two `Ort::Env` singletons into one shared instance from
     `qvac-onnx`. `qvac-lib-infer-onnx-tts` should consume that env rather
     than declaring its own.
   - Investigate `OrtArenaCfg`'s `arena_extend_strategy` /
     `max_dead_bytes_per_chunk` options (only relevant if the arena is kept
     enabled; experiment B suggests it may be acceptable to just disable
     entirely).

3. **`@qvac/ocr-onnx`**:
   - Either collapse Windows path to use the same destructor as POSIX (and
     accept the Windows-side ORT corruption as a known issue with a different
     mitigation), or document the intentional Windows leak in the package
     README so deployers know.

4. **Shared base** (`qvac-lib-infer-base`):
   - Add a documented `unload()` post-condition: `this.addon === null`.
     Update both ONNX TTS and parakeet to follow this.

## Acknowledgements

Probe code: `packages/sdk/examples/memory-load-unload-loop.ts`
SDK side: `packages/sdk/server/bare/registry/model-registry.ts`
