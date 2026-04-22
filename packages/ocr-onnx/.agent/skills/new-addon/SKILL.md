---
name: new-addon
description: Scaffold an empty "hello world" inference addon (package tree + CI workflows) that inherits from qvac-lib-inference-addon-cpp, optionally wired to an inference backend.
argument-hint: "<package-name> <backend:onnxruntime|qvac-fabric|ggml|none>"
---

# New Addon — Hello-World Scaffold

Create a new addon package at `packages/<package-name>/` with the same structure used by the existing addons (tests, CMake, vcpkg, JS entry, CI workflows). The C++ side exposes one function `sayHello(name) -> string` and includes at least one `qvac-lib-inference-addon-cpp` header, so it "inherits" from the base addon. An inference backend (ONNX Runtime, qvac-fabric, raw ggml, or none) is wired in based on the second argument.

Arguments in `$ARGUMENTS`:
1. **package name** (required) — full directory name, e.g. `qvac-lib-infer-hello`
2. **backend** (required) — one of `onnxruntime`, `qvac-fabric`, `ggml`, `none`

If either is missing, stop and ask the user.

## Step 1 — Parse args and derive names

Let `PKG = $1`, `BACKEND = $2`.

Validate:
- `PKG` matches `^[a-z][a-z0-9-]+$`
- `BACKEND` ∈ `{onnxruntime, qvac-fabric, ggml, none}`
- `packages/$PKG` does **not** already exist (stop if it does)

Derive (use these rules, announce the derived values to the user before proceeding):
- `SHORT_NAME` = last hyphen-segment of `PKG` (e.g. `qvac-lib-infer-hello` → `hello`)
- `NPM_NAME` = `@qvac/$SHORT_NAME`
- `CPP_NAMESPACE` = `PKG` with `-` → `_` (e.g. `qvac_lib_infer_hello`)
- `DISPLAY_NAME` = `SHORT_NAME` with first letter uppercased (e.g. `Hello`)
- `EXPORT_FN_NAME` = camelCase of `PKG` + `Exports` (e.g. `qvacLibInferHelloExports`)

## Step 2 — Resolve backend-specific substitutions

Use this table to fill in `BACKEND_VCPKG_DEPS`, `BACKEND_NPM_DEPS_JSON`, `BACKEND_CMAKE_FIND`, `BACKEND_CMAKE_LINK`, `BACKEND_LABEL`.

### `onnxruntime` — via `@qvac/onnx` npm package (not vcpkg)
- `BACKEND_VCPKG_DEPS` = empty string
- `BACKEND_NPM_DEPS_JSON` =
  ```json
  {
    "@qvac/onnx": "^0.14.0"
  }
  ```
- `BACKEND_CMAKE_FIND` =
  ```
  set(qvac-onnx_DIR "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/@qvac/onnx/prebuilds/share/qvac-onnx/cmake")
  find_package(qvac-onnx CONFIG REQUIRED)
  ```
- `BACKEND_CMAKE_LINK` =
  ```
  target_link_libraries(${{{PACKAGE_NAME}}} PRIVATE qvac-onnx::qvac-onnx-static)
  ```
- `BACKEND_LABEL` = `ONNX Runtime (@qvac/onnx)`

### `qvac-fabric` — llama.cpp via qvac-fabric vcpkg port
- `BACKEND_VCPKG_DEPS` =
  ```json
  {"name": "qvac-fabric", "version>=": "7248.2.3"},
  ```
- `BACKEND_NPM_DEPS_JSON` = `{}`
- `BACKEND_CMAKE_FIND` = `find_package(llama CONFIG REQUIRED)`
- `BACKEND_CMAKE_LINK` =
  ```
  target_link_libraries(${{{PACKAGE_NAME}}} PRIVATE llama::llama llama::common)
  ```
- `BACKEND_LABEL` = `qvac-fabric (llama.cpp)`

### `ggml` — raw ggml via vcpkg
- `BACKEND_VCPKG_DEPS` =
  ```json
  {"name": "ggml", "version>=": "2026-01-30#5"},
  ```
- `BACKEND_NPM_DEPS_JSON` = `{}`
- `BACKEND_CMAKE_FIND` = `find_package(ggml CONFIG REQUIRED)`
- `BACKEND_CMAKE_LINK` =
  ```
  target_link_libraries(${{{PACKAGE_NAME}}} PRIVATE ggml::ggml)
  ```
- `BACKEND_LABEL` = `raw ggml`

### `none`
- `BACKEND_VCPKG_DEPS` = empty string
- `BACKEND_NPM_DEPS_JSON` = `{}`
- `BACKEND_CMAKE_FIND` = empty
- `BACKEND_CMAKE_LINK` = empty
- `BACKEND_LABEL` = `none (inference-addon-cpp only)`

## Step 3 — Create the package from templates

Directory to create: `packages/$PKG/`. Copy every file from
`packages/ocr-onnx/.agent/skills/new-addon/templates/` into `packages/$PKG/`,
performing **string substitution** on file contents. Placeholders:

| placeholder | value |
|---|---|
| `{{PACKAGE_NAME}}` | `$PKG` |
| `{{SHORT_NAME}}` | `$SHORT_NAME` |
| `{{NPM_NAME}}` | `$NPM_NAME` |
| `{{CPP_NAMESPACE}}` | `$CPP_NAMESPACE` |
| `{{DISPLAY_NAME}}` | `$DISPLAY_NAME` |
| `{{EXPORT_FN_NAME}}` | `$EXPORT_FN_NAME` |
| `{{BACKEND_VCPKG_DEPS}}` | from table above |
| `{{BACKEND_NPM_DEPS_JSON}}` | from table above |
| `{{BACKEND_CMAKE_FIND}}` | from table above |
| `{{BACKEND_CMAKE_LINK}}` | from table above |
| `{{BACKEND_LABEL}}` | from table above |

Copy `LICENSE` from `packages/qvac-lib-infer-llamacpp-embed/` verbatim into the new package (static Apache 2.0 header).

Do **not** copy `NOTICE` from another package. Instead, after the scaffold is in place, invoke the `notice-generate` skill (see `.cursor/skills/notice-generate/SKILL.md`) for this package so its third-party attributions reflect this addon's actual dependencies (backend choice, vcpkg deps, npm deps). A copied NOTICE would advertise attributions the new addon doesn't use.

File listing produced (all substituted):
- `package.json`, `CMakeLists.txt`, `vcpkg.json`, `vcpkg-configuration.json`
- `binding.js`, `index.js`, `addon.js`, `addonLogging.js`, `addonLogging.d.ts`, `index.d.ts`, `tsconfig.dts.json`
- `README.md`, `CHANGELOG.md`, `PULL_REQUEST_TEMPLATE.md`, `LICENSE` (NOTICE is **not** in templates — generated via the `notice-generate` skill in Step 4.5)
- `addon/src/js-interface/binding.cpp`
- `addon/src/addon/AddonJs.hpp`
- `addon/src/addon/AddonCpp.hpp`
- `addon/src/model-interface/HelloModel.hpp`
- `test/unit/CMakeLists.txt`
- `test/unit/test_hello.cpp`
- `test/unit/say-hello.test.js`
- `test/integration/addon.test.js`
- `test/mobile/integration-runtime.cjs`, `test/mobile/integration.auto.cjs` — **required**. The `integration-mobile-test-$PKG.yml` workflow fails early (step "Verify addon has mobile tests") if `test/mobile/*.cjs` is missing, and the "Validate mobile tests" step runs `npm run test:mobile:validate` which expects `integration.auto.cjs` to cover every file in `test/integration/`. Copy both verbatim — they contain no placeholders.
- `scripts/generate-mobile-integration-tests.js`, `scripts/validate-mobile-tests.js` — copied verbatim. Power the `test:mobile:generate` / `test:mobile:validate` npm scripts. Run `npm run test:mobile:generate` whenever you add or rename a `test/integration/*.test.js` file so `integration.auto.cjs` stays in sync.
- `vcpkg/triplets/x64-linux.cmake`, `vcpkg/triplets/arm64-linux.cmake`, `vcpkg/toolchains/linux-clang.cmake` — **required** so gtest/other vcpkg deps build with libc++ and match the addon's `-stdlib=libc++` setting. Without these the C++ unit test target will fail to link.

**JS unit test pattern:** `test/unit/*.test.js` must only import from pure-JS helper modules (e.g. `addon.js`), **never** from `index.js` or `binding.js`. CI's `ts-checks` job runs `npm run test:unit --if-present` without building the native addon, so unit tests that load the `.bare` binding will fail with `ADDON_NOT_FOUND`. Mirror the pattern used by `packages/qvac-lib-infer-llamacpp-embed/addon.js` + `test/unit/map-addon-event.test.js`: the scaffold's `addon.js` exports a pure-JS `normalizeName()` helper, `index.js` composes it with `binding.sayHello()`, and the unit test asserts against `normalizeName` only. Integration tests (`test/integration/*.test.js`) are allowed to load the native addon.

## Step 4 — Generate CI workflows

Use `packages/qvac-lib-infer-llamacpp-embed` as the CI reference. For each of the following workflow files in `.github/workflows/`, copy it, rename, and substitute:

Copy **all of these**:
- `on-pr-qvac-lib-infer-llamacpp-embed.yml`
- `on-pr-close-qvac-lib-infer-llamacpp-embed.yml`
- `on-merge-qvac-lib-infer-llamacpp-embed.yml`
- `prebuilds-qvac-lib-infer-llamacpp-embed.yml`
- `integration-test-qvac-lib-infer-llamacpp-embed.yml`
- `integration-mobile-test-qvac-lib-infer-llamacpp-embed.yml`
- `cpp-tests-embed.yml`

**Skip (do not copy):**
- `benchmark-qvac-lib-infer-llamacpp-embed.yml`

For each copied workflow:
1. Rename the file: replace `qvac-lib-infer-llamacpp-embed` with `$PKG`, and replace `embed` (in filenames like `cpp-tests-embed.yml`) with `$SHORT_NAME`. Target name example: `cpp-tests-$SHORT_NAME.yml`, `on-pr-$PKG.yml`.
2. In file contents, substitute:
   - `qvac-lib-infer-llamacpp-embed` → `$PKG` (literal, everywhere)
   - `*embed*` (inside `paths:` triggers) → `*$PKG*`
   - Display-name references like `(Embed)` in `name:` fields → `($DISPLAY_NAME)`
   - Job-name references and uses-of-callable-workflows that reference `cpp-tests-embed.yml` → `cpp-tests-$SHORT_NAME.yml`
   - Remove any benchmark references: drop job blocks that call `./.github/workflows/benchmark-*.yml` and any `needs:` list entries pointing to those jobs.
3. Within each copied workflow, strip/remove any step or job that does **model-specific work** not applicable to a hello-world addon (e.g. downloading or verifying model checkpoints). When in doubt, preserve the structure — the build + unit + integration test jobs must remain.

Create an additional small file the on-pr workflow consumes if referenced:
- If `cpp-tests-$SHORT_NAME.yml` references a `.lsan-suppressions.txt` at the package root and you didn't ship one, drop the reference rather than creating the file.

## Step 4.5 — Generate NOTICE via the `notice-generate` skill

Invoke the `notice-generate` skill (`.cursor/skills/notice-generate/SKILL.md`) for the new package. It scans this package's actual dependencies (npm, vcpkg, model files) and writes a correct `NOTICE` at `packages/$PKG/NOTICE`. Do **not** copy a NOTICE from another package — attributions would be wrong for this addon's backend and deps.

If the skill reports missing env (`GH_TOKEN`, `HF_TOKEN`, `NPM_TOKEN`), surface that to the user and stop; do not fabricate a NOTICE file.

## Step 5 — Verify the scaffold builds and tests pass

Run these sequentially from `packages/$PKG/`:

1. `npm install`
2. `bare-make generate`
3. `bare-make build`
4. `bare-make install`
5. `npm run test:unit` — must pass (brittle JS test)
6. `npm run test:integration` — must pass (loads native `.bare` and asserts `sayHello()` output)
7. `npm run test:cpp` — must pass (GoogleTest C++ unit)

If any step fails:
- Print the failing step and the last ~30 lines of its output.
- Do **not** delete the scaffold; report the failure so the user can inspect.
- Common causes: vcpkg registry token missing (`GH_TOKEN`), backend-specific dep not resolvable, bare-make version too old. Point the user to `CLAUDE.md` prerequisites.

## Step 6 — Final report

Print a short summary:
- Path to new package
- Backend wired in
- Count of CI workflows generated (expect 7)
- Test results: unit/integration/cpp — pass/fail

Then **offer Step 7** explicitly:

> "The scaffold is in place with a working `sayHello` demo plus a minimal `HelloModel` showing the full AddonJs pattern. Want me to walk through the questions needed to shape `HelloModel` into your real Model (input/output types, interfaces, config, JS wrapper)? Answer 'yes' to start the interview, 'later' to stop here."

Do not start Step 7 unsolicited if the user said "just the scaffold" or similar in the original invocation.

## Step 7 — Extending to a real addon (interactive interview)

This step is **agent-driven**: the agent asks the user one question at a time, collects answers, then edits the scaffold files in place to match. The scaffold you produced in Steps 1–6 already builds — if any edit breaks the build, revert that edit and ask the user before proceeding.

The scaffold has **two** layers:

1. `sayHello` — a single synchronous C++ function exported to JS. Exercised by `test/integration/addon.test.js` and the C++ unit test. Keep it until the new Model has its own tests; it's the "proof of life" that the build + bindings are alive.
2. A full `AddonJs` pattern — `HelloModel` (implements `IModel` + `IModelCancel`) wired through `createInstance` / `runJob` in `addon/src/addon/AddonJs.hpp`, mirrored in `AddonCpp.hpp`, with `JsStringOutputHandler` as the output handler. `binding.cpp` V() already exports every function a real addon needs (`createInstance`, `runJob`, `loadWeights`, `activate`, `cancel`, `destroyInstance`, `setLogger`, `releaseLogger`).

The interview replaces **Layer 2** in place. Layer 1 stays until the user says they're ready to remove it.

### Interview loop

Ask these questions **one at a time**. After each answer, restate the decision in one line so the user can correct it before you edit files. Don't batch — batching hides mistakes.

**Q1 — What model/backend are you wrapping?**
Goal: free-text description (e.g. "a BERT-style embedder via llama.cpp", "YOLOv8 via ONNX Runtime"). Use it to pick sensible defaults for later questions and to name the new class (e.g. `BertModel`, `YoloModel`). Don't write code yet.

**Q2 — What does `process()` take as input?**
Offer the options from the table in 7.2 (text / text+array / audio samples / image / custom struct) and ask the user to pick or describe. Capture the C++ type for `using Input`.

**Q3 — What does `process()` produce?**
Same treatment — pick from the shapes in 7.2 or describe a custom output type. Capture the C++ type for `using Output` / `using OutputType`. If it's a custom class, ask where the data lives (a `std::vector<float>` + shape? a struct of strings + timings?) so you can draft the class definition.

**Q4 — Which optional Model interfaces?**
For each, ask yes/no with the concrete implication:
- `IModelCancel` — "Will a single `process()` call ever need to be cancelled mid-run? (yes for LLMs, audio streaming; no for one-shot embedders.)"
- `IModelAsyncLoad` — "Will weights come from JS as streamed blobs / shards, or loaded by the backend from a file path you pass in? Pick 'streamed' only if your runtime needs the shard-blob handoff."

**Q5 — What config does `createInstance` need to parse?**
Ask for the shape of the JS-side config object. Default: `{ path, config, backendsDir }` (what embed uses). User may add `{ sessionOptions, languages, … }`. Capture each field and its type (string / number / submap).

**Q6 — Which output handler?**
Using Q3's answer, propose one from 7.3 by default (`std::string` → `JsStringOutputHandler`, `std::vector<T>` → `JsTypedArrayOutputHandler<T>`, custom class → subclass `JsBaseOutputHandler`). Ask the user to confirm or override.

**Q7 — JS wrapper class?**
Three options: (a) none — leave `index.js` exposing the scaffold's `sayHello`, (b) thin — mirror `qvac-lib-infer-llamacpp-embed/index.js`, (c) feature-rich — copy another reference. Default: (b).

**Q8 — C++ test for the new Model?**
Ask if the user wants a minimal GoogleTest case using `AddonCpp::createInstance()` (see 7.7). Default: yes.

### Apply decisions

Once all eight answers are collected, edit the scaffold **incrementally**, one file at a time, in this order. After each file, report the diff summary; after all edits, rerun `npm run test:unit && npm run test:integration && npm run test:cpp` and report results.

1. Rename `addon/src/model-interface/HelloModel.hpp` → the new class name, update interfaces (Q4), `Input`/`Output` types (Q2/Q3), stub `process()` to match the new signature (don't fake inference — leave a `TODO` body that throws `not implemented`).
2. Update `AddonJs.hpp` — swap `HelloModel` for the new class, extend `createInstance` arg parsing per Q5, extend `runJob` input branches per Q2, swap the output handler per Q6.
3. Update `AddonCpp.hpp` — mirror the Model swap + output handler.
4. Update `index.js` per Q7.
5. If Q8 is yes, add `test/unit/test_<your-model>.cpp` (GoogleTest, minimal).
6. Update `package.json` `description` to reflect the real backend.
7. Leave `sayHello` / `HelloWorld::greet` / `say-hello.test.js` / `addon.test.js` in place. Only remove them when the user says the new Model has replaced them.

### Recipes (reference material for the interview)

The subsections below are what the interview *consults* when translating answers into code. They are not meant to be read top-to-bottom by the user.

### 7.1 Pick the right Model interfaces

`HelloModel` extends `IModel` + `IModelCancel`. Add more as the model grows:

- **`IModel`** (required) — `getName()`, `process(std::any) -> std::any`, `runtimeStats()`.
- **`IModelCancel`** — add if a long-running `process()` must be interruptible. `cancel()` runs on a different thread; the Model is responsible for setting a flag / atomic that `process()` polls.
- **`IModelAsyncLoad`** — add when weights come from the JS side as streamed blobs (shards). Requires implementing `waitForLoadInitialization()` and `setWeightsForFile(filename, streambuf)`. Reference: `qvac-lib-infer-llamacpp-embed/addon/src/model-interface/BertModel.hpp`.

When you add `IModelAsyncLoad`, the JS side must call `addon.loadWeights(...)` (already bound) for each shard before `addon.activate()`.

### 7.2 Choose Input / Output types

Declare on the Model:

```cpp
using Input  = /* std::string, std::vector<float>, a custom struct */;
using Output = /* std::string, std::vector<T>, a custom class */;
using OutputType = Output;
```

Reference shapes:
- **Text in, text out** (LLM, NMT): `Input = std::string`, `Output = std::string`.
- **Text in, embedding out** (Embed): `Input = std::variant<std::string, std::vector<std::string>>`, `Output = BertEmbeddings` (custom 2D class).
- **Audio in, transcript out** (Whisper, Parakeet): `Input = std::vector<float>`, `Output = Transcript` (custom struct).
- **Image in, detections out** (OCR): custom `Input` struct, `Output = std::vector<InferredText>`.

### 7.3 Pick the right output handler(s)

`OutputHandlers` is a *list* — a Model can emit multiple event types through one queue. The scaffold uses a single `JsStringOutputHandler`. Swap or add:

- `JsStringOutputHandler` — one-shot string.
- `JsStringArrayOutputHandler` — `vector<string>`.
- `JsTypedArrayOutputHandler<T>` — `vector<T>` as a JS TypedArray.
- `Js2DArrayOutputHandler<ContainerT, ElementT>` — for structured outputs like `BertEmbeddings`.
- **Custom handler** — subclass `JsBaseOutputHandler<ModelOutT>` when none of the above match (see `BertEmbeddings` → `Js2DArrayOutputHandler<BertEmbeddings, float>`).

Mirror the same choice in `AddonCpp.hpp` using `CppQueuedOutputHandler<OutputType>` so C++ tests stay in sync.

### 7.4 Grow `createInstance` argument parsing

The scaffold's `createInstance` parses only `jsHandle` and `outputCallback`. Real addons also parse a config object at arg index 1. Pattern:

```cpp
auto model = std::make_unique<YourModel>(
    args.getMapEntry(1, "path"),
    args.getSubmap(1, "config"),
    args.getMapEntry(1, "backendsDir"));
```

Add validation close to `JsArgsParser` — throw `StatusError(general_error::InvalidArgument, "...")` for missing/wrong-shape fields; the `JSCATCH` macro converts it into a JS exception.

### 7.5 Grow `runJob` input parsing

The scaffold only handles `type === "text"`. Add branches for other types:

```cpp
auto [type, jsInput] = JsInterface::getInput(args);
if (type == "text") {
  input = js::String(env, jsInput).as<std::string>(env);
} else if (type == "sequences") {
  input = parseSequences(js::Object(env, jsInput));   // you define it
} else if (type == "audio") {
  input = parseFloatTypedArray(env, jsInput);          // you define it
} else {
  throw StatusError(general_error::InvalidArgument, "Unknown input type: " + type);
}
```

Keep the JS side's `{ type, input }` contract — every real addon uses it.

### 7.6 Add a JS wrapper class

The scaffold exposes the native bindings directly; real addons wrap them in a class that provides a clean async API. Minimal vs. full examples:

- **Thin** (`qvac-lib-infer-llamacpp-embed/index.js`) — uses `@qvac/infer-base` `createJobHandler` + `exclusiveRunQueue`, maps addon events to `Output` / `JobEnded` / `Error`, streams shards via `loadWeights()`.
- **Feature-rich** (`qvac-lib-infer-whispercpp/index.js`) — adds streaming audio, VAD, reload.
- **Validation-heavy** (`packages/ocr-onnx/index.js`) — per-language filtering, file-path normalization, multi-mode selection.

Copy the thin pattern first; add features only when the Model needs them.

### 7.7 Wire the C++ test harness

The scaffold's `AddonCpp::createInstance()` returns an `AddonInstance` with a `CppQueuedOutputHandler<std::string>`. Use it from GoogleTest:

```cpp
auto instance = {{CPP_NAMESPACE}}::createInstance();
instance.addon->runJob(std::any(std::string("world")));
auto out = instance.outputHandler->wait();  // pull from queue
EXPECT_EQ(std::any_cast<std::string>(out), "hello, world");
```

This lets C++ tests exercise the full Model pipeline without spinning up a JS env.

### 7.8 Don't copy-paste a real Model file

Do not fork `BertModel.hpp` (or any other real Model) and rename it. Those files carry backend-specific assumptions — BERT pooling, llama.cpp lifecycle, cached tokenizer state — that usually don't apply to a new addon. Instead, read the `IModel` interface, sketch your own `Input` / `Output` / `process()`, and use `BertModel.hpp` only as a reference for shape.

## Notes

- Do **not** invent vcpkg versions. Use the versions shown in this skill; if they've drifted, copy the current version from `packages/qvac-lib-infer-llamacpp-embed/vcpkg.json` (for `qvac-fabric`) or `packages/lib-infer-diffusion/vcpkg.json` (for `ggml`).
- Do **not** commit `.npmrc`, `node_modules/`, `build/`, or `prebuilds/` from the new package.
