# Native Addon Fuzz Testing

This document records the findings and the chosen approach for adding fuzz
testing to QVAC's native (C++) inference addons. It is the reference for
maintainers and agents implementing, reviewing, or extending fuzz coverage
across the addon fleet.

Status: **Phase 0 implemented for `classification-ggml`** (template fuzz
helper + a `FUZZ_TEST` per `preprocessToTensor` branch, each seeded so both
branches are reachable in bounded mode), including bounded Linux CI coverage.
Fleet rollout, corpus/dictionary scale-up, scheduled continuous fuzzing, and
optional OSS-Fuzz onboarding remain future phases. Chosen framework: **Google FuzzTest** (backed by
libFuzzer).

> **The entire fuzz dependency stack comes from vcpkg — FuzzTest included.**
> FuzzTest, Abseil, RE2, GoogleTest and the ANTLR4 C++ runtime all resolve
> through `find_package()` against the binary cache, so no fuzz configure clones
> or compiles a dependency and none of it needs network access of its own; see
> "Dependency sourcing" below. Three of the five are QVAC ports in
> `qvac-registry-vcpkg`, each for a reason upstream won't fix: `abseil` because
> FuzzTest needs a newer one than any registry serves, `re2` because no stock
> install ships the internal headers FuzzTest includes, and `fuzztest` because
> FuzzTest ships no `install()` rules at all (upstream request
> [microsoft/vcpkg#36901](https://github.com/microsoft/vcpkg/issues/36901) was
> closed as not-planned on those grounds).
>
> The reason this matters beyond build time: there is exactly **one** GoogleTest
> in play (the vcpkg one), which is what retired the whole target-name-collision
> workaround the first iteration needed.

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
  `qvac_addon_stage_fabric_for_test`) keeps **full** ASan + LSan and
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
  `BUILD_TESTING` maps `tests`. On top of that it short-circuits the addon's
  normal `project()` into a fuzz-only configure.

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
   the ASan already used by the native test harness.

### Accepted trade-offs

- **Three ports in `qvac-registry-vcpkg` to maintain**, one per thing upstream
  won't supply: `abseil` `20260526.0` because FuzzTest needs a newer Abseil than
  any registry serves, `re2` because no stock install ships the internal headers
  FuzzTest includes, and `fuzztest` because FuzzTest ships no `install()` rules.
  Sections for each below. In exchange nothing is compiled per build tree, the
  fuzz configure needs no network access, and the FetchContent'd Abseil plus the
  abseil#2091 declaration override the first iteration needed are retired.
- **The `re2` and `fuzztest` ports move together.** FuzzTest includes RE2's
  private headers, which carry no stability promise, so a FuzzTest bump means
  re-checking the include closure and bumping both — a coupling `FetchContent`
  handled implicitly by building whatever FuzzTest pinned. The `fuzztest` port
  adds its own bump cost: nothing it does is patched in, but four accommodations
  exist because the project isn't meant to be installed, and each is a place a
  release can break (see "The `fuzztest` registry port").
- **FuzzTest built at C++20.** It hard-sets `CMAKE_CXX_STANDARD 17` for its
  subtree, but our addon TUs need C++20 (`std::span`) and a fuzz driver
  instantiates FuzzTest templates over types those TUs define, so both halves
  must agree on the standard. The port's install rules lift every target to
  C++20; the Abseil port is built at C++20 for the matching ABI reason and
  propagates `cxx_std_20` to its dependents.
- **GoogleTest and ANTLR4 are not sanitizer-instrumented.** FuzzTest's own
  libraries are built in the fuzz tree with the same ASan/coverage flags as the
  code under test, and Abseil is ASan-instrumented by its port's `asan` feature
  because it has to be (see below), but GoogleTest and ANTLR4 come from the vcpkg binary
  cache without them. That is not a gap in those two ports: **no** upstream vcpkg
  port exposes a sanitizer feature — zero of the ~2850 in the registry — because
  vcpkg treats a sanitizer as a property of the whole install tree and puts it in
  a triplet rather than a per-port feature. The two that do have one are ours,
  and only because Abseil's swisstable layout changes under ASan (RE2 mirrors it
  because it links Abseil). GoogleTest and ANTLR4 have no ASan-conditional ABI,
  so mixing them in links and runs fine; it just means sanitizer coverage stops
  at their boundary. The same mixing already exists in the plain `test:cpp` build
  (ASan `addon-test` linking a non-ASan vcpkg gtest) and both bounded and
  coverage-guided runs are clean.
- **Where that mixing does bite is false `container-overflow` reports**, because
  vector redzone poisoning is a libstdc++/libc++ mechanism: uninstrumented code
  touching an instrumented vector's redzone is indistinguishable from a real
  overflow. One such report exists today, at build time inside the `fuzztest`
  port, where the single check is disabled for that build (see below). If one
  ever appears at *runtime* in a fuzz binary, the fix is a sanitizer overlay
  triplet (`x64-linux-fuzz`) rather than a blanket `ASAN_OPTIONS` relaxation. The
  triplet is the last resort it sounds like: it rebuilds the whole dependency
  graph under a separate binary-cache namespace, forfeiting the sharing with
  every other build in the repo that this migration was for.
- **Coverage instrumentation is set on the fuzz target, not via FuzzTest's
  `fuzztest_setup_fuzzing_flags()`.** That macro appends to `CMAKE_CXX_FLAGS`,
  which is directory-scoped and read at generate time, so calling it from a CMake
  function (which is what `qvac_addon_add_fuzz_target` is) silently drops the
  flags and leaves the fuzzer with no feedback on the code under test. The
  corollary is a constraint on future edits: whatever changes the target's
  debug/sanitizer posture must change it for the FuzzTest libraries too, because
  both instantiate the same Abseil container templates. Adding `-UNDEBUG` to just
  one side is an ODR violation.
- Continuous-fuzzing mode is Linux/clang-first. Fuzzing is treated as a
  **Linux-only** CI concern, consistent with the existing `if(NOT WIN32)` ASan
  gating. Instrumented Windows fuzz builds are not supported.
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
  build is unchanged: full production module, no FuzzTest in the link. Every configure
  shares the default `build/` tree, so one vcpkg install tree serves all of them
  — but `BUILD_FUZZING` is a cached option, and when it is stale-`ON` the
  production `.bare` module silently disappears from the build. Every npm script
  that configures the tree therefore states `BUILD_FUZZING` explicitly (`OFF` in
  `build:native` and `test:cpp:build`), rather than inheriting whatever the last
  configure left behind.
- **`qvac_addon_enable_fuzztest()`** — `find_package`s FuzzTest and the four
  packages under it, once per configure (idempotent). `link_fuzztest()` comes
  with the `fuzztest` package, which installs FuzzTest's own
  `AddFuzzTest.cmake` and includes it from its config.
- **`qvac_addon_add_fuzz_target(<name> SOURCES … [INCLUDE_DIRS …] [LINK_LIBS …]
  [LINK_FABRIC])`** — builds a plain `add_executable`, links FuzzTest + its
  GoogleTest, applies `-fsanitize=address` + `-fno-omit-frame-pointer`
  (non-Windows) in both modes plus coverage instrumentation in fuzzing mode, and
  registers a `ctest` case. Only when `LINK_FABRIC` is given does it link the
  fabric headers/module and call `qvac_addon_stage_fabric_for_test()`. Omitting
  `LINK_FABRIC` (the default, preferred for pure parse/transform targets) keeps
  full ASan + LSan.
- **Two run modes off one source.** Default configure builds FuzzTest's
  unit-test mode: every `FUZZ_TEST` runs bounded via `ctest` (free per-PR
  regression coverage). Configure with `-D FUZZTEST_FUZZING_MODE=ON` for
  coverage-guided fuzzing, then run `<binary> --fuzz=Suite.Test [--fuzz_for=…]`
  — or, through the runner, `npm run fuzz:continuous -- --fuzz_for=30m`.
- **Runner parity.** A fuzz binary that links fabric must run under the same
  `ASAN_OPTIONS=alloc_dealloc_mismatch=0:detect_leaks=0` that
  `scripts/run-cpp-tests.js` applies to `addon-test`; a non-fabric fuzz binary
  (the `classification-ggml` Phase 0 target) runs at full strength. Both
  postures are **set explicitly, never inherited** — ASan replaces its defaults
  with `ASAN_OPTIONS` wholesale, so a value left over from an `addon-test`
  session would otherwise switch LeakSanitizer off with no trace in the log.
  `scripts/run-cpp-fuzz.js` defaults to `detect_leaks=1:abort_on_error=1`, warns
  loudly when it inherits something else, and always echoes the effective
  string; `qvac_addon_add_fuzz_target()` sets the matching `ENVIRONMENT`
  property on the `ctest` case (relaxed only under `LINK_FABRIC`).
- **Drift guard.** Because the wiring is in the template, the planned
  `scripts/check-addon-cmake.mjs` guard covers it — a re-inlined fuzz block or a
  missing `qvac_addon_add_fuzz_target` call is a CI failure like any other
  template drift.

### Dependency sourcing

Everything in the fuzz link comes from vcpkg. FuzzTest's own
`cmake/BuildDependencies.cmake` would `FetchContent` four dependencies at its own
pins; the `fuzztest` port pre-empts those declarations (`FetchContent` honours the
**first** declaration for a given name, and `FIND_PACKAGE_ARGS` makes it resolve
via `find_package()`), so the package is built against the same vcpkg Abseil,
RE2, GoogleTest and ANTLR4 that consumers link.

| FuzzTest pin | Source | Why |
| --- | --- | --- |
| GoogleTest `v1.17.0` | **vcpkg** (`gtest`, same version) | Also removes the second GoogleTest, and with it the target-name collision. |
| ANTLR4 C++ runtime `4.13.2` | **vcpkg** (`antlr4`, same version) | Pulls `libuuid` transitively. |
| Abseil `20260526.0` | **vcpkg** (`abseil`, `qvac-registry-vcpkg`, same version) | Upstream vcpkg is on `20260107.1` (still, on vcpkg master as of 2026-07-29), which predates the `absl/random/mocking_access.h` that `fuzztest::fuzzing_bit_gen` needs, and this registry's `abseil` was pinned to `20240722.0` for onnxruntime — so the registry gained a dated `20260526.0` port. See below. |
| RE2 `2025-11-05` | **vcpkg** (`re2`, `qvac-registry-vcpkg`, same version) | Needed a port of its own, for a structural reason rather than version skew: `fuzztest/internal/domains/regexp_dfa.cc` includes RE2's internal `re2/prog.h` + `re2/regexp.h` to walk a compiled regex into a DFA, and every stock RE2 install ships only the four public headers. The registry port installs the internal ones. See below. |
| FuzzTest `2026-06-29` (itself) | **vcpkg** (`fuzztest`, `qvac-registry-vcpkg`, same release) | Ships no `install()` rules, so the port supplies them. See below. |

The vcpkg packages are declared in the package manifest's `fuzz` feature
(`vcpkg.json`); the ones resolved from Microsoft are listed in that registry's
allowlist in `vcpkg-configuration.json`. `qvac_addon_preproject()` activates the
feature whenever `BUILD_FUZZING` is on. `qvac_addon_enable_fuzztest()` names all
five explicitly even though the `fuzztest` config `find_dependency`s the other
four, so a manifest missing the feature fails naming the package rather than with
an unresolved link target.

One source for everything is what keeps a single Abseil in the link: vcpkg's
`re2` links vcpkg's `abseil`, and the `fuzztest` package binds to the same
imported `absl::` targets. Sourcing any one of them from `FetchContent` while the
rest come from vcpkg is what would put two Abseils in one link.

### The `abseil` registry port

`ports/abseil/` in `qvac-registry-vcpkg`, at version `20260526.0`. It replaces the
previous onnxruntime-pinned port (`version-string: "onnxruntime"`, Abseil
`20240722.0`) **at HEAD only**: both old entries stay in `versions/a-/abseil.json`,
so `ocr-onnx` keeps resolving what it resolves today from its pinned baseline. The
manifest asks for `abseil[asan]` with `"version>=": "20260526.0"`, so the floor is
stated where the dependency is declared rather than left to the baseline.

It is upstream's portfile with three deliberate differences:

- **Built at C++20** (`-DCMAKE_CXX_STANDARD=20`). Abseil's ABI depends on the
  standard — `absl::SourceLocation` aliases `std::source_location` under C++20 —
  so a default-standard (C++17) Abseil emits different `MakeErrorImpl(...)`
  symbols than our C++20 TUs reference, which is an undefined-symbol link error.
  `ABSL_PROPAGATE_CXX_STD=ON` then puts `cxx_std_20` on the installed `absl::`
  targets, so RE2 and FuzzTest inherit the same standard automatically. Verify
  with `INTERFACE_COMPILE_FEATURES "cxx_std_20"` in the installed
  `share/absl/abslTargets.cmake`.
- **One patch only**, for abseil#2091 (`absl_strings` linked to itself, fatal at
  generate time; fixed upstream 2026-07-01, after the `20260526.0` tag). Upstream
  vcpkg's `003-force-cxx-17.patch` only relaxes Abseil's "compiler defaults to
  < C++17" `FATAL_ERROR`, which the explicit C++20 makes unreachable, and its
  mingw / gcc13 patches target toolchains QVAC doesn't build with.
- **An `asan` feature**, which the `fuzz` manifest feature requests.
  Abseil's swisstable ABI depends on the sanitizer: under ASan,
  `raw_hash_set` stores a generation counter in the backing array and
  `CommonFields` carries a pointer to it
  (`ABSL_SWISSTABLE_ENABLE_GENERATIONS`). The container is a template, so an
  ASan-instrumented consumer compiles the generations-enabled layout inline while
  the out-of-line resize/insert helpers in an uninstrumented `libabsl` allocate
  the layout without it — the header code reads a generation that isn't there and
  dies with `SIGSEGV` in `raw_hash_set::begin()`. Every fuzz target links ASan, so
  its Abseil must be built with it. It is a feature rather than the default
  because it makes the installed libraries unlinkable without
  `-fsanitize=address`, and because the feature earns a separate binary-cache
  entry instead of poisoning the default one.

**Coexistence with the onnxruntime-pinned Abseil.** The port that was there is
version-sensitive for `onnxruntime`, and a second port under a distinct name is
not an option: another name would not be picked up by other ports' `abseil`
dependency, and two Abseils cannot coexist in one install tree (same installed
files). So the new one takes over the `abseil` name with a *dated* version scheme,
and the old `version-string: "onnxruntime"` entries stay in the version database —
older baselines resolve them unchanged. What makes this safe rather than a silent
upgrade for the other consumers (`onnxruntime`, `sentencepiece`, `marian-dev`, none
validated at `20260526.0`) is that `onnxruntime` constrains Abseil with
`version>= "onnxruntime#1"`: a non-comparable scheme, so resolving it *together*
with the dated version is a hard error rather than an implicit bump.

### The `re2` registry port

`ports/re2/` in `qvac-registry-vcpkg`, at version-date `2025-11-05`. Same source
and version as upstream `microsoft/vcpkg`'s `re2` — the SHA512 is upstream's,
unchanged — with two additions:

- **It installs the internal headers.** RE2 lists four headers in `RE2_HEADERS`
  (`filtered_re2.h`, `re2.h`, `set.h`, `stringpiece.h`); FuzzTest needs
  `prog.h` and `regexp.h`, which pull in `pod_array.h`, `sparse_array.h`,
  `sparse_set.h` and `util/utf.h`. Those six are the complete closure — the
  three array/set headers include only each other and `utf.h` includes nothing.
  `util/utf.h` is installed at `include/re2/util/utf.h`, beside `regexp.h`,
  rather than at `include/util/utf.h`: `regexp.h` includes it with quotes, and a
  quoted include is searched relative to the including file first, so this
  resolves without adding a generic `util/` directory to the shared include root
  where it would be a collision risk against every other port.
- **An `asan` feature**, which pulls `abseil[asan]` with it and which the `fuzz`
  manifest feature requests. RE2 uses absl containers internally (`dfa.cc`,
  `re2.cc`, `regexp.cc`, `compile.cc`, `onepass.cc`, `prefilter_tree.h`), so it
  is subject to the same swisstable generations ABI split described above — an
  uninstrumented RE2 on an ASan Abseil is the mismatched half of that pair.

The port's version and FuzzTest's RE2 pin have to move together, because private
headers carry no stability promise. A FuzzTest bump should re-check the closure
above (`rg '#include "(re2|util)/' fuzztest-src/fuzztest/`) before bumping the
port.

Nothing else resolves `re2` from this registry: `packages/onnx` and
`packages/translation-nmtcpp` both route it to the Microsoft registry through
their `vcpkg-configuration.json` allowlists.

### The `fuzztest` registry port

`ports/fuzztest/` in `qvac-registry-vcpkg`, at version-date `2026-06-29`
(FuzzTest's latest release, the commit the FetchContent build used to pin). It
exists because FuzzTest ships no `install()` rule anywhere — that is the whole
reason [microsoft/vcpkg#36901](https://github.com/microsoft/vcpkg/issues/36901)
was closed as not-planned, and `main` still has none — so the port supplies them.

**Nothing is patched.** The install rules are copied into the source tree and
included from the end of `CMakeLists.txt` by a `file(APPEND)`, and the dependency
redirect rides in through `CMAKE_PROJECT_INCLUDE`, which CMake runs at the end of
`project()` and therefore ahead of FuzzTest's `BuildDependencies.cmake`. A
FuzzTest bump has no patch context to reconcile.

**The install rules are generic.** They walk the project's targets and export
whatever they find rather than naming ~30 libraries, so a release that adds or
renames one needs no edit. Four accommodations exist, and each is a place a
FuzzTest release could break:

- **Export names.** Targets are `fuzztest_<x>` with `fuzztest::<x>` aliases, so
  each gets an `EXPORT_NAME` with one prefix stripped. Exactly one:
  `string(REGEX REPLACE)` is global and turns `fuzztest_fuzztest_gtest_main`
  into `gtest_main` rather than the `fuzztest::fuzztest_gtest_main` that
  `link_fuzztest()` asks for.
- **Include-directory hygiene.** `install(EXPORT)` refuses a target whose
  interface leaks a build- or source-tree path. Most targets already wrap theirs
  in `$<BUILD_INTERFACE:>` — which is what makes exporting this project viable at
  all — but `json_grammar` and `generated_antlr_parser` use bare paths, so the
  rules wrap whatever is bare.
- **Header root.** FuzzTest's includes are rooted at its source directory and
  reach into `common/` as well as `fuzztest/` (`internal/any.h`,
  `domains/lazy.h`, `domains/bit_gen_ref.h`), and a top-level `common/` in the
  shared include root would collide with every other port. Both trees install
  under `include/fuzztest-root/`, which the exported targets carry as their
  include directory, so consumers see no difference.
- **A build-time ASan false positive.** FuzzTest builds a grammar codegen tool
  and *runs* it during the build. Under the `asan` feature that tool is
  instrumented while the vcpkg ANTLR4 it links is not, and ASan's
  container-overflow check fires on `std::vector` state crossing the boundary.
  The port disables that one check for the build — the same mixing the fuzz
  binaries already tolerate at runtime (see the GoogleTest/ANTLR4 trade-off
  above). Neither cheaper fix is available: an instrumented ANTLR4 needs the
  sanitizer triplet, since upstream ports carry no `asan` feature, and leaving
  just the codegen executable uninstrumented means patching FuzzTest's CMake for
  a per-target flag, which is the property this port is built to avoid. The
  suppression is set in the portfile's own environment, so it covers that
  build-time tool run and nothing a consumer does at runtime.

**Built with `FUZZTEST_FUZZING_MODE=OFF`**, deliberately, even though consumers
run `--fuzz=`. That option calls `fuzztest_setup_fuzzing_flags()`, which puts
ASan *and* `-fsanitize-coverage` on FuzzTest's whole scope; coverage-guided
fuzzing needs the code *under test* instrumented, which
`qvac_addon_add_fuzz_target()` handles target-scoped, and instrumenting
FuzzTest's own libraries on top of that just feeds the fuzzer edges from its own
machinery. The check that this is right: the packaged build reports the same
`Total edges` (8505) as the FetchContent build did on `preprocess-fuzz`, so the
instrumentation scope is unchanged. (That figure predates the seed work, which
compiles `stb_image_write` into the driver; compare like-for-like builds when
re-running the check, not against the number quoted here.) The one visible difference is that FuzzTest's
internal assertions stay compiled out, which is the posture its unit-test mode
uses anyway.

The `asan` feature mirrors the other two ports' and pulls `abseil[asan]` and
`re2[asan]` with it. The port is `supports: linux`, static-only, release-only.

Landed in
[qvac-registry-vcpkg#277](https://github.com/tetherto/qvac-registry-vcpkg/pull/277);
`vcpkg-configuration.json`'s `default-registry` baseline (`1d658f6`) is the
post-merge commit, so `fuzztest` resolves from the registry with no overlay.

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
  `qvac_addon_enable_fuzztest()` + `qvac_addon_add_fuzz_target()` helpers to
  `cmake/qvac-addon/qvac-addon.cmake`, `test/fuzz` `FUZZ_TEST`s over
  `preprocessToTensor` built **without** `LINK_FABRIC` (full ASan + LSan), and
  `fuzz*` npm scripts + `scripts/run-cpp-fuzz.js`. FuzzTest and its dependency
  stack resolve from vcpkg; the registry ports own the pins and C++20 build
  requirements.
- **Phase 0 follow-up — both `preprocessToTensor` branches, reachable per PR.
  ✅ Done.** `preprocessToTensor()` picks its branch off the *declared*
  dimensions, so one property function cannot cover both: with them fixed at `0`
  it decodes encoded bytes and `validateRawRgb` / `resizeToInput` /
  `normalizeToWhcn` are dead code; with them fuzzed the all-zero triple that
  selects the decode path is ~1-in-10⁹. `preprocess_fuzz.cpp` therefore carries
  two targets — `PreprocessDecodedNeverCrashes` (encoded, dimensions `0`) and
  `PreprocessRawNeverCrashes` (dimensions fuzzed with `InRange`, bounded one past
  `MAX_IMAGE_DIMENSION` / `CHANNELS` so the guards' reject side stays reachable).
  Both carry **seeds**, because bounded unit-test mode has no coverage feedback
  and neither branch is reachable by chance: random bytes clear
  `isEncodedImage()` with probability 2⁻²⁴ (JPEG) / 2⁻⁶⁴ (PNG), and
  `validateRawRgb` wants `size == width * height * channels` exactly. The seeds
  are **generated in-process by `stb_image_write`** rather than checked in as
  byte blobs, so they cannot drift from the `stb_image` that decodes them and no
  hand-computed PNG CRC lives in the tree. Two ordinary `TEST`s in the same file
  assert each seed still round-trips, so a rotten seed fails loudly instead of
  quietly demoting both fuzzers to their reject paths — the failure mode that is
  invisible in a green fuzz log. Verified by temporarily aborting on a
  *successful* `preprocessToTensor`: bounded mode reports counterexamples that
  are the 16×16 PNG seed, the JPEG seed, and `16x16x3` respectively.
- **Phase 0 follow-up — dependencies from vcpkg. ✅ Done.** GoogleTest, ANTLR4 and
  (via the registry's dated port) Abseil moved off FetchContent — see "Dependency
  sourcing". Two bugs surfaced while validating this, both worth knowing about
  because they were silent:
  - **Coverage instrumentation never reached the code under test.** The template
    called FuzzTest's `fuzztest_setup_fuzzing_flags()` from inside a CMake
    *function*; the macro appends to `CMAKE_CXX_FLAGS`, which is directory-scoped
    and read at generate time, so the flags evaporated — `compile_commands.json`
    showed the fuzz driver and `ImagePreprocessor.cpp` compiled with
    `-fsanitize=address` and no `-fsanitize-coverage`. Coverage-guided mode still
    reported progress because the FetchContent'd Abseil/RE2 in the same tree were
    instrumented and supplied a counter map, so the fuzzer was steering on their
    edges instead. Setting the flags on the target fixed it; a 60 s run now
    reports **`833` of `8505` edges covered with a `517`-input corpus** over 1.45M
    runs, growing throughout, where the pre-fix corpus stalled almost immediately.
  - **An ASan-instrumented consumer needs an ASan Abseil.** Abseil's swisstable
    layout changes under a sanitizer, so the uninstrumented vcpkg Abseil
    SIGSEGV'd in `raw_hash_set` as soon as FuzzTest's memory dictionary (a
    `flat_hash_set`) came alive — which only happened once coverage feedback
    started working. Hence the port's `asan` feature.
  Revalidated from a clean tree: fuzz-only build + bounded run, the combined
  tests+fuzz build (29 unit tests + bounded fuzz), plain `test:cpp`, and 60 s
  coverage-guided fuzzing (clean, no crash/leak).
- **Phase 0 follow-up — RE2 and FuzzTest from vcpkg too. ✅ Done.** The `re2`
  port carries the internal headers FuzzTest includes, and the `fuzztest` port
  carries the install rules FuzzTest doesn't ship, so `FetchContent` is gone from
  the fuzz path entirely — see the two port sections above. A cold fuzz build now
  compiles 3 TUs instead of 34. Validated on `preprocess-fuzz`: bounded mode, 29
  unit tests in the combined tree, and coverage-guided mode at the same 8505
  total edges as the FetchContent build, 430k execs clean.
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
- **Phase 4 — seed corpora + dictionaries.** Every target ships the minimum
  in-harness `.WithSeeds(...)` needed to make its branches reachable per PR (see
  the Phase 0 follow-up); this phase is the scale-up. Seed from existing assets
  (`test/images/*.jpg`, real GGUF headers, sample audio) via
  `ReadFilesFromDirectory`, add format dictionaries (PNG/JPEG magic, GGUF
  magic/version/type tags), and store minimized corpora in-repo or in the CI
  model S3 bucket. Also where an input domain whose parts must agree — a raw-RGB
  buffer whose length is *derived* from the fuzzed dimensions, via `FlatMap` —
  belongs, if a continuous run shows `PreprocessRawNeverCrashes` starving past
  `validateRawRgb`.
- **Phase 5 — CI wiring.** Run fuzz targets *bounded* inside the existing
  `cpp-tests-*` workflows (free per-PR regression coverage). **Landed for
  `classification-ggml`:** on **Linux** (matching the `if(NOT WIN32)` ASan gate)
  `cpp-tests-classification.yml` runs a **single** configure of the `build/`
  tree (`test:cpp:fuzz:configure`) so the CMake cost is paid once for both
  `addon-test` and the bounded fuzz target (sharing the vcpkg GoogleTest)
  instead of configuring two trees. Build and run are then **split per target
  and ordered unit-tests-first** — `test:cpp:fuzz:build:tests`, `test:cpp:run`,
  `test:cpp:fuzz:build:fuzz`, `fuzz:run` — so a fuzz compile break or a fuzz
  finding fails *after* `addon-test` has been built and run, rather than
  aborting the job before the unit tests start. That ordering does **not**
  decouple the unit tests from the fuzz *dependencies*: the shared configure
  runs with `BUILD_FUZZING=ON` and therefore resolves the `fuzz` manifest
  feature (`fuzztest[asan]`, `abseil[asan]`, `re2[asan]`, `antlr4`) before
  `addon-test` is configured at all, so a vcpkg registry or binary-cache
  failure there takes the Linux unit tests down with it — the accepted price of
  one configure over two. Neither run step sets `ASAN_OPTIONS`: the unit-test
  runner self-applies the relaxed fabric-boundary options while the fuzz runner
  keeps full ASan + LSan (its target doesn't link fabric). darwin/win32 keep the
  `test:cpp` path (no fuzzing). It reuses the caller's existing
  SHA-bound fork gate (no new trust wiring). The whole fuzz stack is vcpkg-served
  (see "Dependency sourcing"), so a job that wipes `build/` still pays only the
  vcpkg restore. Then add a separate scheduled
  / `workflow_dispatch` fuzzing job that builds with `-DFUZZTEST_FUZZING_MODE=ON`
  and runs `npm run fuzz:continuous -- --fuzz_for=<duration>` (coverage-guided,
  time-boxed — the runner forwards the flag to the binary) with a
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
- **Resource exhaustion reads as a crash.** A fuzz target's property function
  swallows the addon's "invalid input" error (`StatusError`) and lets everything
  else fail the run, but *allocating a lot of memory* is allowed behavior for a
  decoder, not a defect. `preprocess-fuzz` is the worked example:
  `MAX_IMAGE_DIMENSION` (16384) permits a 768 MiB decoded RGB buffer, and
  `decodeToRgb()` copies stb's buffer into a `std::vector` **before** freeing it,
  so a header-legal maximum image peaks near 1.5 GiB before ASan's shadow map and
  quarantine — over libFuzzer's default `-rss_limit_mb=2048`, which reports
  `out-of-memory` and writes a reproducer that reproduces forever. Bounding the
  input domain's byte count does not help: the allocation is driven by the
  *declared* dimensions, so a ~50-byte PNG `IHDR` claiming 16384×16384 with a
  truncated `IDAT` passes `stbi_info_from_memory()` and the dimension guard, and
  makes `stbi_load_from_memory()` allocate the full output buffer before it
  discovers the data is truncated. Expect this once Phase 5's continuous job runs
  against a real image corpus. Bounded per-PR mode now *does* decode real images
  — its seeds are valid PNG/JPEG — but they are **16×16**, and the allocation is
  the product of both axes: a mutation that inflates one dimension field of a
  seed header allocates kilobytes, so the pathological shape still needs both
  axes mutated large at once, which is why per-PR mode is not expected to hit
  this. Keep the seeds small for that reason. The raw-RGB target cannot hit it at
  all: `validateRawRgb` rejects unless the buffer length already equals
  `width * height * channels`, so its allocation is bounded by the fuzzer's own
  input size. Fixes are deferred, and the tempting one — a
  `catch (const std::bad_alloc&)` in the property — is the wrong one: that same
  path holds a **real defect** (the `std::vector` copy throws with stb's buffer
  still owned by nobody, leaking it), and a blanket catch would mask that plus any
  future integer-overflow bug that surfaces as an absurd allocation size. The
  options worth weighing when it comes up: give the stb buffer RAII ownership
  (fixes the leak), pass an explicit `--rss_limit_mb` / `--malloc_limit_mb` budget
  sized above the legal worst case (so runaway allocation still trips), apply a
  fuzz-only lower dimension cap to keep the target on parsing logic rather than
  the allocator, or drop the double allocation in `decodeToRgb()` entirely.
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
- **Build-time cost.** The whole stack comes from the vcpkg binary cache, so a
  cold fuzz tree compiles only the addon TUs under test and the fuzz driver
  (3 TUs / ~10s for `preprocess-fuzz`, against 34 TUs / ~27s when FuzzTest was
  fetched and built per tree). Nothing about a fuzz configure reaches the network
  beyond the vcpkg restore every other build already does. Measured on an 8-core
  Linux dev box; the dominant cost of a genuinely cold configure is the vcpkg
  registry fetch, which is shared with every other package and unrelated to
  fuzzing.
- **Upstream-pin maintenance.** The FuzzTest pin now lives in the registry port
  rather than the template, and a bump is a port change plus a revalidation pass:
  the four accommodations in "The `fuzztest` registry port" all exist because
  FuzzTest isn't built to be installed, so any of them can break on a release.
  The `re2` port must move in the same change (private headers), and a bump can
  move the version floor on the other dependencies, so re-check "Dependency
  sourcing" against what the new release requires. The abseil#2091 patch its
  port carries has a "drop this once…" note of its own.
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
  `BUILD_FUZZING`, `qvac_addon_enable_fuzztest()`,
  `qvac_addon_add_fuzz_target()`, and the existing
  `qvac_addon_stage_fabric_for_test()` the fuzz harness reuses.
- `packages/classification-ggml/test/fuzz/` — Phase 0 reference: the
  `CMakeLists.txt` fuzz wiring and `preprocess_fuzz.cpp` — one `FUZZ_TEST` per
  `preprocessToTensor` branch (encoded / raw-RGB), each seeded with
  `stb_image_write`-generated inputs, plus the `TEST`s that keep those seeds
  honest. No fabric link.
- `packages/classification-ggml/vcpkg.json` /
  `packages/classification-ggml/vcpkg-configuration.json` — the `fuzz` manifest
  feature (`abseil[asan]`, `re2[asan]`, and `fuzztest[asan]` with version
  floors, plus `antlr4` and `gtest`) and the `microsoft/vcpkg` allowlist entries
  for `antlr4`, `gtest`, and transitive `libuuid`.
- `packages/classification-ggml/scripts/run-cpp-fuzz.js` — bounded /
  `--continuous` fuzz runner (pins `ASAN_OPTIONS=detect_leaks=1:abort_on_error=1`
  and warns when it inherits a different value);
  wired via the `fuzz`, `fuzz:build`, `fuzz:run`, `fuzz:continuous` npm scripts
  (fuzz-only configure) and the `test:cpp:fuzz*` scripts (combined tests+fuzz
  configure). Both runners default to `build/` and take `--build-dir <dir>` (or
  `CPP_BUILD_DIR`) for a side-by-side tree. `--continuous` and `--build-dir` are
  the fuzz runner's only own flags; every other flag is forwarded verbatim to the
  binary, which is how the time box reaches it
  (`npm run fuzz:continuous -- --fuzz_for=30m`). Without a `--fuzz_for`,
  `fuzz:continuous` fuzzes until interrupted — that is the intended local
  default, but a CI job must always pass a duration.
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
  test workflow; on Linux does one configure then builds and runs each target in
  turn, unit tests before fuzz, while darwin/win32 keep the `test:cpp` unit-only
  path.
- `.cursor/rules/devops/github-actions.mdc` — CI trust policy for fork PRs
  (SHA-bound authorization) that any self-hosted fuzz job must follow.
