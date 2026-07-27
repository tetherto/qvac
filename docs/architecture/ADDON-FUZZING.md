# Native Addon Fuzz Testing

This document records the findings and the chosen approach for adding fuzz
testing to QVAC's native (C++) inference addons. It is the reference for
maintainers and agents implementing, reviewing, or extending fuzz coverage
across the addon fleet.

Status: **design approved, implementation not yet started.** Chosen framework:
**Google FuzzTest** (backed by libFuzzer), with OSS-Fuzz as an optional later
phase.

> **This effort rides on the shared CMake template + fabric migration.** As of
> the `qvac-addon` CMake template
> ([`cmake/qvac-addon/qvac-addon.cmake`](../../cmake/qvac-addon/qvac-addon.cmake),
> see `docs/architecture/ADDON-CMAKE-TEMPLATE.md`), addon builds are being
> unified onto shared helpers and their ggml runtime moved to the shared
> `@qvac/fabric` prebuild. Fuzz support is added **as a helper in that same
> template and onboarded per addon in the same PR that migrates it** — not as
> per-package boilerplate. The rule is: **template adoption == fabric migration
> == fuzz onboarding.** This also means the limited-ASan boundary the fabric
> migration introduced (below) is inherited by fuzz binaries and shapes the
> harness design.

## Scope

Scope is **every QVAC native addon** — all packages whose `package.json`
declares `"addon": true` — **except the ONNX Runtime addons** (`onnx`,
`ocr-onnx`), which are out of scope for this effort. The in-scope addons are
C++20 Bare addons built with CMake + vcpkg on the centrally-pinned
**clang-22 / libc++** toolchain, linked against `ggml` / `llama.cpp` /
`whisper.cpp` / `stable-diffusion.cpp`.

### Addon inventory

| Package | Family / backend | Role | C++ GTest harness (`test:cpp`) |
| --- | --- | --- | --- |
| `classification-ggml` | ggml | image classification | ✅ |
| `ocr-ggml` | ggml | OCR (easyocr / doctr) | ✅ |
| `tts-ggml` | ggml | text-to-speech (supertonic / chatterbox) | ✅ |
| `vla-ggml` | ggml | vision-language-action | ✅ |
| `audiogen-ggml` | ggml | music / audio generation (acestep) | ❌ (harness needed) |
| `llm-llamacpp` | llama.cpp | text / multimodal LLM | ✅ |
| `embed-llamacpp` | llama.cpp | embeddings (BERT) | ✅ |
| `translation-nmtcpp` | NMT | translation | ✅ |
| `transcription-whispercpp` | whisper.cpp | speech-to-text | ✅ |
| `bci-whispercpp` | whisper.cpp | BCI neural-signal transcription | ✅ |
| `transcription-parakeet` | parakeet | speech-to-text | ✅ |
| `diffusion-cpp` | stable-diffusion.cpp | image / video generation | ✅ |
| `fabric` | shared ggml + llama.cpp runtime host | infra (no direct input parsing) | ❌ |

The ONNX Runtime addons (`onnx`, `ocr-onnx`) are intentionally excluded from
this effort and are not listed above.

Fuzzing targets **pure parse/transform functions** that consume
attacker-influenceable bytes. It deliberately does **not** target full
`runJob` / end-to-end inference paths (non-deterministic, backend-stateful, and
dominated by matrix math rather than input parsing).

## Findings: what we're building on

Four properties of the current C++ build/test setup make fuzzing cheap to add
across the fleet.

### 1. A shared per-package GoogleTest harness already isolates the parsing code

Most addons build a standalone `addon-test` binary via `npm run test:cpp:build`
(`bare-make generate -D BUILD_TESTING=ON && bare-make build --target
addon-test`); the `test/unit/CMakeLists.txt` compiles the model-interface
`.cpp` sources **directly** into that binary. The parsing/decoding code is
therefore already exercised outside the JS/addon (Bare) boundary, in an
ordinary native executable. A fuzz target is *the same shape* — a plain
`add_executable()` linking the same TUs — so it slots straight into this
pattern. Two in-scope packages (`audiogen-ggml`, `fabric`) lack the harness
today and need it stood up first (or, for `fabric`, may stay out of scope as
pure infra).

### 2. A shared CMake template now owns the addon/test build shape

The `qvac-addon` template (`cmake/qvac-addon/qvac-addon.cmake`) extracts the
addon build spine into helpers (`qvac_addon_preproject`,
`qvac_addon_project_setup`, `qvac_addon_use_fabric`, `qvac_addon_link_fabric`,
`qvac_addon_finalize`) plus a **test-harness staging helper**
`qvac_addon_stage_fabric_for_test(<target> <fabric_target>)` that copies the
shared `qvac__fabric@0.bare` runtime + its ggml backends next to a plain test
executable, sets `$ORIGIN`/`@loader_path` rpath, and links the win32 delay-load
helper. `classification-ggml` is migrated; the rest follow.

This is the single most important change for fuzzing: **the `BUILD_FUZZING`
option and a `qvac_addon_add_fuzz_target()` helper belong in this template**, so
every addon gets identical fuzz wiring as it migrates, and a fuzz binary that
must link the shared runtime reuses `qvac_addon_stage_fabric_for_test()` for the
exact same staging the test binary already relies on. The planned CI drift guard
(`scripts/check-addon-cmake.mjs`) then protects the fuzz wiring too.

### 3. Sanitizers are wired into the test binary — but ASan is *limited* at the fabric boundary

The migrated `test/unit/CMakeLists.txt` still links AddressSanitizer
(`-fsanitize=address`, non-Windows) with `-fno-omit-frame-pointer`, and keeps
the `ENABLE_COVERAGE` option. **But** the fabric migration made ASan
*deliberately limited*: `addon-test` links ASan while dynamically loading the
non-ASan, `-static-libstdc++` `@qvac/fabric` prebuild, so objects crossing the
module boundary trip alloc/dealloc-mismatch and fabric's long-lived globals +
dlopen'd backends look like leaks at exit. The runner
(`scripts/run-cpp-tests.js`) and CI therefore run with
`ASAN_OPTIONS=alloc_dealloc_mismatch=0:detect_leaks=0`.

Two consequences for fuzzing, both important:

- **LeakSanitizer is off at the fabric boundary.** libFuzzer normally leans on
  LSan to catch leaks; a fuzz binary that links fabric inherits `detect_leaks=0`
  and loses that bug class. **Preferred mitigation: don't link fabric for
  targets that don't need it.** The image, text, audio-buffer, and config
  parsers are pure CPU code with no ggml dependency — compiling only those TUs
  into the fuzz binary (no `qvac_addon_link_fabric` / no
  `qvac_addon_stage_fabric_for_test`) keeps **full** ASan + UBSan + LSan and
  avoids the boundary entirely.
- **Targets that genuinely need the runtime** (e.g. a GGUF loader that calls
  into ggml/gguf through fabric) pay the same limited-ASan cost as `addon-test`,
  run with the same relaxed `ASAN_OPTIONS`, and give up leak findings — unless a
  dedicated fuzz job builds an ASan-instrumented fabric
  (`QVAC_FABRIC_ASAN=1` → shared libc++), which the npm prebuild does not ship.

### 4. Toolchain and CI already favor clang + libFuzzer

- The monorepo pins **clang-22 / libc++** centrally in
  `.github/actions/setup-llvm` (the single source of truth for the LLVM major).
  libFuzzer ships with that clang, so no new compiler is required.
- C++ tests run through per-package reusable workflows (e.g.
  `cpp-tests-classification.yml`, invoked from `on-pr-classification-ggml.yml`)
  on self-hosted `qvac-*` runners, gated by the SHA-bound fork-CI trust policy.
- Builds are CMake + vcpkg with existing `BUILD_TESTING` and `ENABLE_COVERAGE`
  options — a `BUILD_FUZZING` option added to `qvac_addon_preproject` follows the
  same established pattern (and maps a `fuzz` vcpkg feature for FuzzTest + Abseil
  + RE2, mirroring how `BUILD_TESTING` maps the `tests` feature).

## Attack surface (grouped by shared input family)

The fleet shares a small number of untrusted-input families. The highest-value
strategy is to **fuzz the shared parsing code once and protect many addons** —
several packages wrap the same `stb_image`, `gguf`, and text-parsing code.

| Input family | Addons that consume it | Representative targets | Why it's a good target |
| --- | --- | --- | --- |
| **Encoded image bytes** (JPEG/PNG via `stb_image` + resize) | `classification-ggml`, `ocr-ggml`, `vla-ggml`, `diffusion-cpp` (init/img2img/mask) | `preprocess::decodeToRgb`, `preprocessToTensor`, `validateRawRgb` | classic memory-safety hotspot; hand-rolled bounds/dimension checks must hold on malformed headers |
| **Model-file headers** (GGUF / safetensors) | all (custom wrappers over upstream loaders) | `easyocr::ggml::GgufLoader`, `vla` `safetensors_lite.hpp` / `gguf_helpers.hpp` | header/length-field parsing → integer-overflow / OOB; the *QVAC wrappers* are in scope, upstream loaders are triage-only |
| **Prompt / model text** (chat templates, GBNF grammar, tool-call & reasoning parsers, tokenizer/vocab) | `llm-llamacpp`, `embed-llamacpp`, `translation-nmtcpp`, `tts-ggml` | reasoning/tool-call parsers (`ReasoningBlockCompactor`, `ReasoningUtils`), template + grammar handling, tokenization | pure string transforms over untrusted text; ideal in-process fuzz targets with no backend state |
| **Audio buffers** (PCM conversion, resampling, streaming windows) | `transcription-whispercpp`, `transcription-parakeet`, `bci-whispercpp`, `tts-ggml`, `audiogen-ggml` | `PcmConversion`, `OutputResampler`, streaming processors | numeric buffer math over caller-supplied sample counts / rates |
| **Config JSON** (per-model options) | `tts-ggml` (`ChatterboxConfig`/`SupertonicConfig`), `audiogen-ggml` (`AcestepConfig`), whisper/parakeet configs | config parse/validate | small structured parsers over untrusted config values |

Existing invariants worth pinning under fuzzing (only unit-tested on the happy
path today), from the image family reference implementation:

- `decodeToRgb` header-checks dimensions (`MAX_IMAGE_DIMENSION`) **before**
  allocating the full RGB buffer.
- `validateRawRgb` enforces `size == width * height * channels` and rejects
  zero/oversized dimensions.

Fuzzing proves those hold across *malformed* inputs, not just curated fixtures.

## Chosen framework: Google FuzzTest (backed by libFuzzer)

### Options considered

| Framework | Model | Fit for this repo |
| --- | --- | --- |
| **Google FuzzTest** (chosen) | property-based tests inside GoogleTest; libFuzzer/Centipede backend | **Best fit.** Reuses the existing GoogleTest harness every addon already has; fuzz targets double as bounded regression tests in normal CI; structured domains suit the image/GGUF/text surfaces; stays on the pinned clang-22. |
| libFuzzer (raw) | in-process `LLVMFuzzerTestOneInput` | Lowest friction to start and ships with clang, but raw byte-buffer entry points are unstructured and each target is a separate one-off harness convention. Used *underneath* FuzzTest. |
| AFL++ / Honggfuzz | out-of-process fork/persistent mode | Overkill for in-process library-API fuzzing; needs `afl-clang-fast`/harness plumbing that fights the clang-22 pin. Not chosen. |
| OSS-Fuzz | continuous-fuzzing *service*, not an engine | Consumes libFuzzer/FuzzTest targets. Best as a later phase for 24/7 fuzzing + auto bug filing once targets exist. |

### Why FuzzTest

1. **Reuses GoogleTest.** Every addon already standardizes on GoogleTest; a
   `FUZZ_TEST(Suite, Prop)` lives beside existing `TEST(...)` cases in the same
   file, with no new harness convention to learn per package.
2. **Fuzz targets double as regression tests.** With no fuzzing engine linked, a
   FuzzTest runs a bounded number of iterations as an ordinary unit test. It
   becomes a long-running fuzzer only in a dedicated job — free coverage on
   every PR without adding to the critical path.
3. **Structured input domains.** Domains (`Arbitrary<std::vector<uint8_t>>`,
   integer/struct domains) express the image-dimension, GGUF-header, and
   text-parser targets far more precisely than raw byte buffers.
4. **No toolchain churn.** Uses the already-pinned clang-22 and composes with
   the ASan/UBSan already in the build.

### Accepted trade-offs

- FuzzTest pulls in Abseil + RE2 (via vcpkg), scoped behind `BUILD_FUZZING=OFF`
  so normal builds and the existing coverage job are unaffected.
- Continuous-fuzzing mode is Linux/clang-first. Fuzzing is treated as a
  **Linux-only** CI concern, consistent with the existing `if(NOT WIN32)` ASan
  gating.
- Fuzz binaries that link `@qvac/fabric` inherit the limited-ASan boundary
  (`detect_leaks=0`), so leak findings require either not linking fabric
  (preferred, see Finding 3) or a dedicated ASan-instrumented-fabric fuzz job.

## Build integration: the shared CMake template

Fuzz support is added to `cmake/qvac-addon/qvac-addon.cmake` and consumed by
each addon exactly the way the test harness is, so onboarding an addon is a few
lines in the PR that already migrates it to the template + fabric.

- **`BUILD_FUZZING` option** lives in `qvac_addon_preproject` next to
  `BUILD_TESTING` / `ENABLE_COVERAGE`, and appends a `fuzz` entry to
  `VCPKG_MANIFEST_FEATURES` (FuzzTest + Abseil + RE2), mirroring how
  `BUILD_TESTING` appends `tests`.
- **`qvac_addon_add_fuzz_target(<name> SOURCES … [LINK_FABRIC])`** — a new helper
  that builds a plain `add_executable`, applies
  `-fsanitize=address,undefined,fuzzer` (non-Windows), wires FuzzTest/GTest, and
  — **only when `LINK_FABRIC` is given** — calls the existing
  `qvac_addon_stage_fabric_for_test()` so the runtime `.bare` + backends stage
  next to the fuzz binary. Omitting `LINK_FABRIC` (the default, preferred for the
  pure parse/transform targets) keeps full ASan + LSan.
- **Runner parity.** A fuzz binary that links fabric must run under the same
  `ASAN_OPTIONS=alloc_dealloc_mismatch=0:detect_leaks=0` that
  `scripts/run-cpp-tests.js` applies to `addon-test`; a non-fabric fuzz binary
  runs with default (full) options. The scheduled fuzz job selects the right
  option string per target.
- **Drift guard.** Because the wiring is in the template, the planned
  `scripts/check-addon-cmake.mjs` guard covers it — a re-inlined fuzz block or a
  missing `qvac_addon_add_fuzz_target` call is a CI failure like any other
  template drift.

## Implementation phases

Sequencing is bound to the CMake-template + fabric migration: an addon becomes
fuzzable when it adopts the template, so fuzz rollout follows the template
migration order (`docs/architecture/ADDON-CMAKE-TEMPLATE.md`, Phase 1:
`classification-ggml` → `vla-ggml`, `ocr-ggml`, `translation-nmtcpp` → the
llama addons once fabric's llama packaging is ready). Whisper / parakeet / tts /
diffusion (separate vcpkg ports) are fuzzed after they migrate. Within that
order the plan front-loads the shared parsing families that protect several
addons at once.

- **Phase 0 — template fuzz helper + spike (`classification-ggml`).** Add the
  `fuzz` vcpkg feature + FuzzTest dependency, the `BUILD_FUZZING` option in
  `qvac_addon_preproject`, and the `qvac_addon_add_fuzz_target()` helper to
  `cmake/qvac-addon/qvac-addon.cmake`. Prove it with one `FUZZ_TEST` over
  `preprocessToTensor` in `classification-ggml` (already migrated), built
  **without** `LINK_FABRIC` so it keeps full ASan + LSan. Confirm it runs both
  as a bounded unit test and in fuzzing mode locally.
- **Phase 1 — image + model-header families (as addons migrate).** As each
  direct-ggml addon adopts the template, add its fuzz targets: the image family
  (`classification-ggml`, `ocr-ggml`, `vla-ggml`; `diffusion-cpp` after it
  migrates) and the model-file-header family. Prefer the no-fabric link;
  reserve `LINK_FABRIC` for header loaders that actually call ggml/gguf. Factor
  shared parsing helpers so one target covers multiple consumers where the code
  is genuinely shared.
- **Phase 2 — text + audio + config families.** Add targets for the llama.cpp /
  NMT text parsers, the whisper/parakeet/tts audio buffer math, and the config
  JSON parsers — each landing with (or after) that addon's template migration.
- **Phase 3 — harness gaps.** Stand up the missing GTest/`addon-test` harness
  for `audiogen-ggml` (and decide whether `fabric` is in scope), then add its
  fuzz targets.
- **Phase 4 — seed corpora + dictionaries.** Seed from existing assets
  (`test/images/*.jpg`, real GGUF headers, sample audio) and add format
  dictionaries (PNG/JPEG magic, GGUF magic/version/type tags). Store minimized
  corpora in-repo or in the CI model S3 bucket.
- **Phase 5 — CI wiring.** Run fuzz targets *bounded* inside the existing
  `cpp-tests-*` workflows (free per-PR regression coverage). Add a separate
  scheduled / `workflow_dispatch` fuzzing job with a wall-clock budget per
  target on a self-hosted `qvac-*` Linux runner, applying the correct
  `ASAN_OPTIONS` per target (full for non-fabric targets, relaxed for
  fabric-linked ones) and uploading crash reproducers + updated corpus as
  artifacts. Keep it off the per-PR critical path and SHA-bound per the fork-CI
  trust policy.
- **Phase 6 (optional) — OSS-Fuzz onboarding.** Add a `projects/qvac` build
  config (Dockerfile + `build.sh`) so the same targets run continuously with
  automatic regression tracking and bug filing.

## Risks and considerations

- **Third-party crashes.** Fuzzing will surface bugs in `stb_image` and upstream
  `gguf`/`llama.cpp`/`whisper.cpp`, not just QVAC code.
  Decide per family whether those are in-scope (guard at the QVAC boundary) or
  reported upstream, so the corpus does not fill with known-upstream crashes.
  Default posture: fuzz the **QVAC wrapper**, triage upstream hits separately.
- **Limited ASan at the fabric boundary.** A fuzz binary that links
  `@qvac/fabric` inherits `alloc_dealloc_mismatch=0:detect_leaks=0`, so it loses
  LeakSanitizer coverage and part of the alloc/dealloc check — the same boundary
  `addon-test` already tolerates. Mitigate by **not linking fabric** for pure
  parse/transform targets (keeps full ASan + LSan); only header/loader targets
  that call into ggml/gguf pay the cost.
- **In-process non-determinism / global state.** Backend init and global caches
  must be reset per iteration or excluded from the fuzzed region, or libFuzzer's
  in-process model produces false crashes. Keeping targets to pure
  parse/transform functions (not `runJob`) avoids this — and is the same choice
  that lets most targets skip the fabric link.
- **Build-time cost.** FuzzTest + Abseil + RE2 stay behind `BUILD_FUZZING=OFF`
  (via the template's `fuzz` vcpkg feature); normal builds and coverage are
  unaffected.
- **Platform scope.** libFuzzer + ASan is Linux-first here; treat fuzzing as a
  Linux-only CI concern (matches the existing `if(NOT WIN32)` ASan gate).
- **Migration coupling.** An addon can't be fuzzed via the shared helper until
  it adopts the template; fuzz rollout is gated by the fabric-migration order.
  Un-migrated addons (whisper / parakeet / tts / diffusion) wait their turn
  rather than getting a bespoke fuzz build.
- **Harness gaps.** `audiogen-ggml` and `fabric` need harness work before they
  can be fuzzed; they are sequenced last so they don't block the high-value
  shared-family coverage.

## References

- `cmake/qvac-addon/qvac-addon.cmake` — the shared addon build template; where
  `BUILD_FUZZING` + `qvac_addon_add_fuzz_target()` land, and home of the existing
  `qvac_addon_stage_fabric_for_test()` the fuzz harness reuses.
- `docs/architecture/ADDON-CMAKE-TEMPLATE.md` — template design, the fabric
  migration shape, migration order, and the planned `check-addon-cmake.mjs`
  drift guard.
- `.github/actions/setup-llvm/action.yml` — pinned clang-22 toolchain (single
  source of truth for the LLVM major).
- `packages/classification-ggml/test/unit/CMakeLists.txt` — migrated reference
  harness: fabric two-target link, `qvac_addon_stage_fabric_for_test`, and the
  limited-ASan block that documents the static-libstdc++ boundary.
- `packages/classification-ggml/scripts/run-cpp-tests.js` — the runner that
  applies `ASAN_OPTIONS=alloc_dealloc_mismatch=0:detect_leaks=0`; fabric-linked
  fuzz binaries need the same.
- `packages/classification-ggml/addon/src/model-interface/ImagePreprocessor.cpp`
  — reference image-family target (decode + dimension checks; no fabric link
  needed).
- `packages/ocr-ggml/addon/src/model-interface/easyocr/gguf_loader.cpp` —
  reference model-file-header target (the kind that may need `LINK_FABRIC`).
- `.github/workflows/cpp-tests-classification.yml` — reusable per-package C++
  test workflow (the natural home for the bounded fuzz stage).
- `.cursor/rules/devops/github-actions.mdc` — CI trust policy for fork PRs
  (SHA-bound authorization) that any self-hosted fuzz job must follow.
