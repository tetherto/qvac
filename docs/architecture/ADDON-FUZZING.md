# Native Addon Fuzz Testing

This document records the findings and the chosen approach for adding fuzz
testing to QVAC's native (C++) inference addons. It is the reference for
maintainers and agents implementing, reviewing, or extending fuzz coverage
across the addon fleet.

Status: **Phase 0 landed for `classification-ggml`** (template fuzz helper +
first `FUZZ_TEST`); remaining phases not yet started. Chosen framework:
**Google FuzzTest** (backed by libFuzzer), with OSS-Fuzz as an optional later
phase.

> **FuzzTest itself is sourced via CMake `FetchContent`; its dependencies come
> from vcpkg where vcpkg can supply them.** There is no `fuzztest` vcpkg port
> (upstream request
> [microsoft/vcpkg#36901](https://github.com/microsoft/vcpkg/issues/36901) was
> closed as not-planned: FuzzTest ships no `install()` rules), so FuzzTest is
> pinned to a commit and pulled via `FetchContent`, gated behind `BUILD_FUZZING`.
> Pinned source built through the normal CMake dep flow is allowed by the
> dependency-pinning rule and is **not** remote code execution.
>
> Of the four dependencies FuzzTest would otherwise `FetchContent` itself,
> **GoogleTest and the ANTLR4 C++ runtime are redirected at vcpkg** — see
> "Dependency sourcing" below for how, and for why Abseil and RE2 can't be yet.
> The reason this matters beyond build time: there is now exactly **one**
> GoogleTest in play (the vcpkg one), which is what retired the whole
> target-name-collision workaround the first iteration needed.

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
  same established pattern, mapping a `fuzz` vcpkg manifest feature the way
  `BUILD_TESTING` maps `tests`. On top of that it triggers a `FetchContent` pull
  of a pinned FuzzTest and short-circuits the addon's normal `project()` into a
  fuzz-only configure.

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

- FuzzTest still compiles from source, along with the Abseil + RE2 part of its
  dependency stack (see "Dependency sourcing"), scoped behind
  `BUILD_FUZZING=OFF` so normal builds and the existing coverage job are
  unaffected. It is a dedicated build, never on the default path.
- **Abseil pin override (bug #2091).** FuzzTest (as of `2026-06-29` and `main`)
  `FetchContent`s Abseil `20260526.0`, whose `absl_strings` CMake target links to
  itself — a fatal generate-time error under the vcpkg toolchain. The template
  overrides FuzzTest's `abseil-cpp` declaration with the upstream fix commit
  (`d21659a`, 2026-07-01). Drop the override once a FuzzTest release pins a
  post-fix Abseil, or once Abseil moves to vcpkg.
- **Whole fetched subtree forced to C++20.** FuzzTest hard-sets
  `CMAKE_CXX_STANDARD 17` for its subtree, but `absl::SourceLocation` aliases
  `std::source_location` under C++20, so an Abseil built at C++17 emits different
  `MakeErrorImpl(...)` symbols than a C++20 consumer TU (our addon code needs
  `std::span`) references — an undefined-symbol link error. The template lifts
  every fetched target to C++20 after `FetchContent` to keep one consistent ABI.
  This is also the open question for moving Abseil to vcpkg: the vcpkg `abseil`
  port carries a `003-force-cxx-17.patch` and builds at the compiler default, so
  a vcpkg Abseil would need a triplet that sets `-std=c++20` (Abseil then detects
  at-least-C++20 and propagates `cxx_std_20`).
- **The vcpkg-supplied dependencies are not sanitizer-instrumented.** FuzzTest's
  own libraries are built in the fuzz tree under
  `fuzztest_setup_fuzzing_flags()`, so they carry the same ASan/coverage flags as
  the code under test; GoogleTest and ANTLR4 come from the vcpkg binary cache
  without them. The same mixing already exists in the plain `test:cpp` build
  (ASan `addon-test` linking a non-ASan vcpkg gtest) and both bounded and
  coverage-guided runs are clean, but it does mean sanitizer coverage stops at
  those two libraries' boundary. If it ever produces false
  `container-overflow` reports, the fix is a sanitizer overlay triplet
  (`x64-linux-fuzz`) rather than relaxing `ASAN_OPTIONS`.
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
  `BUILD_TESTING` / `ENABLE_COVERAGE`, and enables the `fuzz` vcpkg manifest
  feature. `BUILD_FUZZING` **without** `BUILD_TESTING` short-circuits into a
  **fuzz-only configure** (`add_subdirectory(test/fuzz)` then `return()`),
  skipping the `.bare` module and the `@qvac/fabric` runtime so a pure
  parse/transform fuzz driver keeps full ASan + LSan.
- **`BUILD_TESTING` + `BUILD_FUZZING` build together** in one tree, because both
  the unit tests and the fuzz targets link the same vcpkg GoogleTest — nothing
  special is required to make that work. The combined configure builds only the
  two test executables; the production `.bare` module is skipped so the fuzzing
  toolchain never instruments the shipped addon. A plain `BUILD_TESTING`-only
  build is unchanged: full production module, no FuzzTest fetch. Because the
  combined configure caches `BUILD_FUZZING=ON`, it uses its own tree
  (`bare-make … -b build-fuzz`, wired into the `test:cpp:fuzz*` npm scripts) so it
  never poisons the default `build/` cache.
- **`qvac_addon_enable_fuzztest()`** — resolves the vcpkg-supplied dependencies,
  then fetches + builds a pinned FuzzTest once per configure (idempotent),
  overriding FuzzTest's Abseil pin (bug #2091) and forcing the fetched subtree to
  C++20. Defines `link_fuzztest()` / `fuzztest_setup_fuzzing_flags()`.
- **`qvac_addon_add_fuzz_target(<name> SOURCES … [INCLUDE_DIRS …] [LINK_LIBS …]
  [LINK_FABRIC])`** — builds a plain `add_executable`, calls
  `fuzztest_setup_fuzzing_flags()` (adds coverage instrumentation in fuzzing
  mode), links FuzzTest + its GoogleTest, applies `-fsanitize=address`
  + `-fno-omit-frame-pointer` (non-Windows) for the bounded unit-test runs, and
  registers a `ctest` case. Only when `LINK_FABRIC` is given does it link the
  fabric headers/module and call `qvac_addon_stage_fabric_for_test()`. Omitting
  `LINK_FABRIC` (the default, preferred for pure parse/transform targets) keeps
  full ASan + LSan.
- **Two run modes off one source.** Default configure builds FuzzTest's
  unit-test mode: every `FUZZ_TEST` runs bounded via `ctest` (free per-PR
  regression coverage). Configure with `-D FUZZTEST_FUZZING_MODE=ON` for
  coverage-guided fuzzing, then run `<binary> --fuzz=Suite.Test [--fuzz_for=…]`.
- **Runner parity.** A fuzz binary that links fabric must run under the same
  `ASAN_OPTIONS=alloc_dealloc_mismatch=0:detect_leaks=0` that
  `scripts/run-cpp-tests.js` applies to `addon-test`; a non-fabric fuzz binary
  (the `classification-ggml` Phase 0 target) runs with default (full) options —
  `scripts/run-cpp-fuzz.js` deliberately sets **no** `ASAN_OPTIONS` relaxations.
- **Drift guard.** Because the wiring is in the template, the planned
  `scripts/check-addon-cmake.mjs` guard covers it — a re-inlined fuzz block or a
  missing `qvac_addon_add_fuzz_target` call is a CI failure like any other
  template drift.

### Dependency sourcing

FuzzTest's `cmake/BuildDependencies.cmake` `FetchContent`s four dependencies at
its own pins. `FetchContent` honours the **first** declaration for a given name,
so `qvac_addon_enable_fuzztest()` declares them before pulling FuzzTest and wins.
Adding `FIND_PACKAGE_ARGS` (CMake ≥ 3.24) to a declaration makes
`FetchContent_MakeAvailable()` satisfy it with `find_package()` instead of
cloning — which is how a dependency gets served from the vcpkg binary cache
without patching FuzzTest.

| FuzzTest pin | Source | Why |
| --- | --- | --- |
| GoogleTest `v1.17.0` | **vcpkg** (`gtest`, same version) | Also removes the second GoogleTest, and with it the target-name collision. |
| ANTLR4 C++ runtime `4.13.2` | **vcpkg** (`antlr4`, same version) | Pulls `libuuid` transitively. |
| Abseil `20260526.0` | FetchContent | FuzzTest's `fuzztest::fuzzing_bit_gen` needs `absl/random/mocking_access.h`, absent from vcpkg's newest Abseil (`20260107.1`, still current on vcpkg master as of 2026-07-29). |
| RE2 `2025-11-05` | FetchContent | Must follow Abseil: vcpkg's `re2` links vcpkg's Abseil, so taking it from vcpkg alongside a source-built Abseil would put two Abseils in one link. |

The two vcpkg packages are declared in the package manifest's `fuzz` feature
(`vcpkg.json`) and listed in the `microsoft/vcpkg` allowlist in
`vcpkg-configuration.json`; `qvac_addon_preproject()` activates the feature
whenever `BUILD_FUZZING` is on. `qvac_addon_enable_fuzztest()` `find_package`s
both **before** declaring anything, so a manifest missing the feature fails
naming the package rather than with an unresolved link target. The declarations
deliberately carry no download fallback — silently falling back to a source
GoogleTest would reintroduce the duplicate the redirect exists to prevent.

**To move Abseil and RE2 across** (which also retires the #2091 override), one of:
upstream vcpkg bumps `abseil` to ≥ `20260526.0`; an `abseil` port is added to
`qvac-registry-vcpkg` (a small port — unlike `fuzztest`, Abseil installs cleanly —
and `abseil` then comes off the `microsoft/vcpkg` allowlist); or FuzzTest is
pinned back to a release matching vcpkg's Abseil, which couples every future
FuzzTest bump to vcpkg's Abseil cadence. Verify the C++17/C++20 Abseil ABI note
in "Accepted trade-offs" before choosing.

## Implementation phases

Sequencing is bound to the CMake-template + fabric migration: an addon becomes
fuzzable when it adopts the template, so fuzz rollout follows the template
migration order (`docs/architecture/ADDON-CMAKE-TEMPLATE.md`, Phase 1:
`classification-ggml` → `vla-ggml`, `ocr-ggml`, `translation-nmtcpp` → the
llama addons once fabric's llama packaging is ready). Whisper / parakeet / tts /
diffusion (separate vcpkg ports) are fuzzed after they migrate. Within that
order the plan front-loads the shared parsing families that protect several
addons at once.

- **Phase 0 — template fuzz helper + spike (`classification-ggml`). ✅ Done.**
  Added the `BUILD_FUZZING` option in `qvac_addon_preproject`, the
  `qvac_addon_enable_fuzztest()` + `qvac_addon_add_fuzz_target()` helpers (pinned
  FuzzTest via `FetchContent`, Abseil #2091 override, C++20 subtree forcing) to
  `cmake/qvac-addon/qvac-addon.cmake`, a `test/fuzz` `FUZZ_TEST` over
  `preprocessToTensor` built **without** `LINK_FABRIC` (full ASan + LSan), and
  `fuzz*` npm scripts + `scripts/run-cpp-fuzz.js`. Validated locally: bounded
  unit-test run passes clean, and 20 s coverage-guided fuzzing (`~933k` runs)
  found no crash/leak. Follow-up (also done): GoogleTest and ANTLR4 moved from
  FetchContent to vcpkg — see "Dependency sourcing" — revalidated with a clean
  fuzz-only build, the combined tests+fuzz build (29 unit tests + bounded fuzz),
  and 20 s coverage-guided fuzzing (`~1.12M` runs, clean).
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
  `cpp-tests-*` workflows (free per-PR regression coverage). **Landed for
  `classification-ggml`:** on **Linux** (matching the `if(NOT WIN32)` ASan gate)
  `cpp-tests-classification.yml` does a **single** combined configure+build+run
  — `test:cpp:fuzz:build` then `test:cpp:fuzz:run` — so the CMake configure cost
  is paid once for both `addon-test` and the bounded fuzz target (sharing
  the vcpkg GoogleTest) instead of configuring `build/` and `build-fuzz/`
  separately. The combined run step sets **no** `ASAN_OPTIONS`: the unit-test
  runner self-applies the relaxed fabric-boundary options while the fuzz runner
  keeps full ASan + LSan (its target doesn't link fabric). darwin/win32 keep the
  `test:cpp` path (no fuzzing). It reuses the caller's existing
  SHA-bound fork gate (no new trust wiring). Still open: what remains on
  FetchContent (FuzzTest, Abseil, RE2) runs cold each job because Manual
  Workspace Cleanup wipes `build-fuzz/`, so either move Abseil/RE2 to vcpkg (see
  "Dependency sourcing") or cache the pinned sources/build. Then add a separate scheduled
  / `workflow_dispatch` fuzzing job that builds with `-DFUZZTEST_FUZZING_MODE=ON`
  and runs `--fuzz_for=<duration>` (coverage-guided, time-boxed) with a
  wall-clock budget per target on a self-hosted `qvac-*` Linux runner, applying
  the correct `ASAN_OPTIONS` per target (full for non-fabric targets, relaxed
  for fabric-linked ones) and uploading crash reproducers + updated corpus as
  artifacts. Keep continuous fuzzing off the per-PR critical path and SHA-bound
  per the fork-CI trust policy.
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
- **Build-time cost.** GoogleTest and ANTLR4 come from the vcpkg binary cache;
  FuzzTest + Abseil + RE2 are still fetched and compiled, only under
  `BUILD_FUZZING=ON`, so normal builds and coverage are unaffected. The fuzz
  configure therefore still needs network access for those pinned sources — fine
  for the local/scheduled fuzz job, and reducible further by moving Abseil/RE2 to
  vcpkg (see "Dependency sourcing").
- **Upstream-pin maintenance.** The FuzzTest commit, the Abseil #2091 override,
  and the C++20 subtree forcing are all workarounds for the current FuzzTest
  release. Each is documented at its definition in `qvac-addon.cmake` with a
  "drop this once…" note; revisit on every FuzzTest bump. A bump can also move
  the version floor on FuzzTest's vcpkg-supplied dependencies, so re-check
  "Dependency sourcing" against what the new pin requires.
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

- `cmake/qvac-addon/qvac-addon.cmake` — the shared addon build template; home of
  `BUILD_FUZZING`, `qvac_addon_enable_fuzztest()`, `qvac_addon_add_fuzz_target()`
  (with the FuzzTest pin, Abseil #2091 override, and C++20 subtree forcing) and
  the existing `qvac_addon_stage_fabric_for_test()` the fuzz harness reuses.
- `packages/classification-ggml/test/fuzz/` — Phase 0 reference: the
  `CMakeLists.txt` fuzz wiring and `preprocess_fuzz.cpp` (`FUZZ_TEST` over
  `preprocessToTensor`, no fabric link).
- `packages/classification-ggml/vcpkg.json` /
  `packages/classification-ggml/vcpkg-configuration.json` — the `fuzz` manifest
  feature and the `microsoft/vcpkg` allowlist entries that back it.
- `packages/classification-ggml/scripts/run-cpp-fuzz.js` — bounded /
  `--continuous` fuzz runner (full ASan + LSan, no `ASAN_OPTIONS` relaxation);
  wired via the `fuzz`, `fuzz:build`, `fuzz:run`, `fuzz:continuous` npm scripts
  (fuzz-only tree) and the `test:cpp:fuzz*` scripts (combined tests+fuzz tree).
  Both runners take `--build-dir <dir>` (default `build` / `build-fuzz`) so the
  combined `build-fuzz` tree can host `addon-test` and `preprocess-fuzz` together.
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
  test workflow; on Linux runs a single combined `test:cpp:fuzz:build` +
  `test:cpp:fuzz:run` (unit tests + bounded fuzz, one configure), while
  darwin/win32 keep the `test:cpp` unit-only path.
- `.cursor/rules/devops/github-actions.mdc` — CI trust policy for fork PRs
  (SHA-bound authorization) that any self-hosted fuzz job must follow.
