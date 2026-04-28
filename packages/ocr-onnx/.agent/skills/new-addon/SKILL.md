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

Also copy `LICENSE` and `NOTICE` from `packages/qvac-lib-infer-llamacpp-embed/` verbatim into the new package (they are static Apache 2.0 files).

File listing produced (all substituted):
- `package.json`, `CMakeLists.txt`, `vcpkg.json`, `vcpkg-configuration.json`
- `binding.js`, `index.js`, `addon.js`, `index.d.ts`, `tsconfig.dts.json`
- `README.md`, `CHANGELOG.md`, `PULL_REQUEST_TEMPLATE.md`, `LICENSE`, `NOTICE`
- `addon/src/js-interface/binding.cpp`
- `addon/src/addon/AddonJs.hpp`
- `addon/src/addon/AddonCpp.hpp`
- `test/unit/CMakeLists.txt`
- `test/unit/test_hello.cpp`
- `test/unit/say-hello.test.js`
- `test/integration/addon.test.js`
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

### Step 4a — Verify all 7 workflows are present

This is a **hard gate**: if any file is missing, generate it before proceeding — do not defer to the user. A past scaffold run (VLA) shipped with only 6/7 workflows because `on-pr-*.yml` was silently skipped, leaving PRs against the new package with no tests wired up.

Run this check (in Bash) and compare the output to the expected list. The count must equal **7** and every expected filename must be present:

```bash
ls .github/workflows/ | grep -E "(^on-(pr|pr-close|merge)-$PKG\.yml$|^prebuilds-$PKG\.yml$|^integration-(test|mobile-test)-$PKG\.yml$|^cpp-tests-$SHORT_NAME\.yml$)"
```

Expected 7 filenames (substitute `$PKG` and `$SHORT_NAME`):
1. `on-pr-$PKG.yml`
2. `on-pr-close-$PKG.yml`
3. `on-merge-$PKG.yml`
4. `prebuilds-$PKG.yml`
5. `integration-test-$PKG.yml`
6. `integration-mobile-test-$PKG.yml`
7. `cpp-tests-$SHORT_NAME.yml`

If any is missing, return to Step 4 and generate just the missing one(s) from the corresponding `*embed*` template. Do not skip `on-pr-$PKG.yml` under any circumstances — it is the workflow that runs sanity checks, cpp-lint, cpp-tests, ts-checks, prebuilds, and integration tests on every PR against the new package. Without it, PRs land untested.

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
- **CI workflows generated** — list every filename (must be exactly 7, see Step 4a). Report like:
  ```
  CI workflows (7/7):
  - on-pr-$PKG.yml
  - on-pr-close-$PKG.yml
  - on-merge-$PKG.yml
  - prebuilds-$PKG.yml
  - integration-test-$PKG.yml
  - integration-mobile-test-$PKG.yml
  - cpp-tests-$SHORT_NAME.yml
  ```
  If the count is anything other than 7, flag it as an error in the summary and stop — do not claim success.
- Test results: unit/integration/cpp — pass/fail
- Next step hint: replace the hello-world stub in `addon/src/addon/AddonCpp.hpp` with real logic; add model-interface files under `addon/src/model-interface/`.

## Notes

- The scaffold intentionally uses the minimal `qvac-lib-inference-addon-cpp` surface (`JsUtils.hpp` / `JsArgsParser` / `JSCATCH`) — enough to demonstrate inheritance. When the addon grows, wire in `JsInterface`, `ModelInterfaces`, `AddonJs`, and the output-handler machinery the way `qvac-lib-infer-llamacpp-embed/addon/src/addon/AddonJs.hpp` does.
- Do **not** invent vcpkg versions. Use the versions shown in this skill; if they've drifted, copy the current version from `packages/qvac-lib-infer-llamacpp-embed/vcpkg.json` (for `qvac-fabric`) or `packages/lib-infer-diffusion/vcpkg.json` (for `ggml`).
- Do **not** commit `.npmrc`, `node_modules/`, `build/`, or `prebuilds/` from the new package.
