# QIP: Linux `@qvac/fabric` owns the in-process C++ runtime

*Status:* Draft — for team discussion
*Authors:* @juan.arias
*Created:* 2026-09-15

## :mag: Problem

On Linux, `@qvac/fabric` and every fabric-consuming addon each **statically link their own libc++** (`-stdlib=libc++ -static-libstdc++`). libc++ matches exception types **by typeinfo address**. Two copies of `std::exception` in one process are different types.

When llama/libcommon inside `qvac__fabric@0.bare` throws (for example `repeat-penalty must be finite and greater than 0`), the addon’s `catch (std::exception&)` does not match. The throw reaches `JSCATCH`’s `catch (...)` and JS sees `INTERNAL_ERROR` / `"Unknown error"`. Darwin and Windows share one C++ runtime, so the same path surfaces a structured `InvalidArgument` with the real message.

This is a **Linux-only degradation of the native error contract** (Principle 6: errors are part of the contract; Principle 2: capability parity). It is not a missing validation: fabric does reject the bad value.

It was found on [PR #4454](https://github.com/tetherto/qvac/pull/4454) (`feat/QVAC-22415`, migrate `@qvac/llm-llamacpp` onto the shared fabric runtime). Integration job [test-linux-x64](https://github.com/tetherto/qvac/actions/runs/34856102892/job/104306800114) failed **250/251**: only `Negative repeat penalty surfaces argument error`. Linux arm64 (CPU) failed the same way; darwin-arm64 and win32-x64 passed with:

```
commonParamsParse: error while handling argument "--repeat-penalty":
error: repeat-penalty must be finite and greater than 0
```

`load_mode` was already validated in the addon “so fabric-thrown exceptions do not cross the native boundary on Windows.” Repeat-penalty is the same class of throw, now visible on Linux after the dynamic-fabric migration. Patching one handler does not close the class: any future fabric `std::exception` across that DSO will flatten on Linux.

A decision is needed **before merging the fabric migration** and before more addons take the same link shape. The install contract must stay self-contained: prebuilds must not grow a need for LLVM `libc++.so.1` on the host (Principle 9).

## :bulb: Solution

**Approve making `@qvac/fabric` the unique owner of the C++ runtime for Linux in-process consumers that `DT_NEEDED` `qvac__fabric@0.bare`.**

Keep embedding libc++ **inside** the fabric prebuild (`-static-libstdc++` on the fabric module). Change what is **visible**:

1. **Fabric (Linux)** exports the cxxabi / libc++ surface addons need to unwind and catch (`__cxa_*`, `__gxx_personality_v0`, `std::exception` typeinfo / vtables — exact set proven by a link of one consumer with `-nostdlib++`). Today `symbols.map` ends with `local: *;`, which hides that copy.
2. **Linux addons** compile with the same libc++ **headers** (clang-22, already required) but **do not link a second runtime**: drop `-static-libstdc++` on the addon module and link with `-nostdlib++` (or equivalent) so C++ runtime symbols resolve from fabric via the existing `DT_NEEDED`.
3. **Lockstep:** a fabric that exports cxxabi and an addon that still statically links libc++ can interpose weak typeinfo. Ship as one coordinated prebuild set, not mixed old addons + new fabric on Linux.

Responsibilities:

| Binary | Linux C++ runtime |
| --- | --- |
| `qvac__fabric@0.bare` | Owns and exports one libc++ / libc++abi |
| Consumer `.bare` (`llm-llamacpp`, …) | Headers only; import runtime from fabric |
| `libqvac-ggml-*.so` backends | Unchanged: private static libc++ ; C ggml-backend ABI; `dlopen(..., RTLD_LOCAL)` |

Android stays `ANDROID_STL=c++_shared` (one NDK `libc++_shared.so` in the APK). Darwin/iOS keep OS libc++; Windows keeps the MSVC CRT. Those platforms already catch fabric exceptions.

This is a **Linux native ABI of the fabric module**, not a JS SDK API change. Observable JS behavior on Linux should match Darwin/Windows for fabric-thrown `std::exception`: structured code + `what()`. Hosts still need glibc, not LLVM libc++.

## :twisted_rightwards_arrows: Alternatives considered

**Host or sibling `libc++.so.1` (shared dylib).** One typeinfo, but the SDK would depend on an LLVM C++ runtime on the machine or a new shipped `.so`. Rejected: breaks the self-contained prebuild contract that `-static-libstdc++` exists to protect.

**Catch in the addon / validate each fabric-throwing argument.** Restores one test (`repeat_penalty`, as `load_mode` already does) without an ABI change. Rejected as the *strategy*: every new libcommon check re-opens Linux `Unknown error`. Acceptable only as a stop-gap if this QIP is deferred.

**Export `_ZTI*` from fabric but keep dual static libc++.** ELF visibility cannot merge two statically linked libc++ copies; addon `catch (std::exception&)` still uses the addon’s typeinfo pointer. Insufficient.

## :scales: Consequences

**Accept.** Linux error messages from fabric handlers become real `InvalidArgument` text instead of `Unknown error`. Addon `.bare` files lose a duplicate libc++, which should **shrink** them; fabric’s exported surface grows. The ASan `alloc_dealloc_mismatch` split (fabric `new` vs addon `delete`) is the same uniqueness bug and should narrow once both sides use fabric’s operators.

**Pay.** Fabric’s public Linux ABI includes cxxabi, not only `llama_*` / `ggml_*` / `common_*`. Addon CMake (`qvac_addon_project_setup`) becomes Linux-specific and must stay lockstep with fabric’s libc++ version (already clang-22). Mixing an old statically linked addon with a cxxabi-exporting fabric on Linux is unsupported. Weak GNU unique typeinfo exported from fabric could interpose onto `RTLD_LOCAL` backends; backends **keep** `-static-libstdc++` and we verify typeinfo does not migrate (see Appendix).

**Do not pay.** No host `libc++-dev` at runtime. No Android STL change. No `DT_NEEDED` from ggml backends onto fabric.

## :no_entry_sign: Out of scope

- Android, Darwin, iOS, Windows link models
- Changing how ggml backends are loaded (`RTLD_LOCAL`, private `libggml-base`)
- Banning C++ exceptions from libcommon; this QIP makes catching them work on Linux
- JS error-code taxonomy beyond restoring native `what()` / `StatusError` mapping
- ASan-instrumented fabric in the npm prebuild (`QVAC_FABRIC_ASAN=1` already uses shared libc++ for tests)

## :sparkles: Nice to haves

- Document the Linux cxxabi export set next to `symbols.map` / `INTEGRATION.md` as a supported fabric ABI
- Drop Linux `ASAN_OPTIONS=alloc_dealloc_mismatch=0` on addon-test if mismatch disappears
- A small C++ gtest that throws `std::invalid_argument` from a fabric-called handler and catches it in addon code (faster than the full LLM integration test)

## :paperclip: Appendix

### How the failure presents

`LoadFitNormalization.cpp` wraps fabric arg handlers in `catch (std::exception&)` and rethrows `StatusError` with `commonParamsParse: error while handling argument "..."`. On Linux that catch is skipped; `JsUtils.hpp` `JSCATCH` `catch (...)` maps to `INTERNAL_ERROR` / `"Unknown error"`. Activate is synchronous (`LlamaInterface.activate`); the message is not `Unknown error at JsAsyncTask`.

Evidence: [run 34856102892](https://github.com/tetherto/qvac/actions/runs/34856102892) / [job 104306800114](https://github.com/tetherto/qvac/actions/runs/34856102892/job/104306800114); same TAP failure on both Linux x64 GPU images and both Linux arm64 CPU images.

### Current Linux link (why typeinfo splits)

- Fabric: `packages/fabric/CMakeLists.txt` — Linux `-static-libstdc++`; ASan build **drops** it because a module-local static libc++ also duplicates `operator new`/`delete`.
- Addons: `cmake/qvac-addon/qvac-addon.cmake` `qvac_addon_project_setup` — same flags. `qvac_addon_finalize` `--exclude-libs,ALL` on Linux (hides static libs the addon links; must not hide imports from fabric).
- Fabric `symbols.map`: export `llama_*` / `ggml_*` / `common_*` / … then `local: *;` — hides fabric’s libc++ even though it is inside the `.bare`.

### Backends (do not fold into this change)

The `qvac-fabric` vcpkg port appends `-static-libstdc++` to Linux `VCPKG_LINKER_FLAGS` so `libqvac-ggml-*.so` do not `DT_NEEDED libc++.so.1` (stock Ubuntu otherwise fails `dlopen`). Comment in the port: module↔addon is the C ggml-backend ABI; per-module libc++ copies must not exchange C++ objects. Load path: `ggml_backend_load_all_from_path` → `dlopen(..., RTLD_NOW | RTLD_LOCAL)`. Those modules also carry a private `libggml-base` (separate `g_logger_state`). They are not `DT_NEEDED` clients of fabric and **cannot** import fabric cxxabi without a new NEEDED or `RTLD_GLOBAL`.

### Implementation sketch (not the approval surface)

**Fabric Linux module**

- Keep libc++ **inside** the module, but **whole-archive** `libc++.a` (`-nostdlib++` plus `$<LINK_LIBRARY:WHOLE_ARCHIVE,…>`) instead of pulling it in with `-static-libstdc++`. Required, for the same reason ggml is already whole-archived: `-static-libstdc++` links only the archive members llama/ggml/common themselves reference, and a version script filters symbols that are present rather than pulling members in. A probe measured 111 unresolved references for a single consumer translation unit using `ostringstream`, `regex` and a function-local static.
- Extend the version script `global` list with the runtime, all as **mangled** patterns: `__cxa_*`, `__dynamic_cast`, `_Unwind_*`, `__gxx_personality_v0`, `_ZT*` (typeinfo / typeinfo names / vtables / VTTs and thunks), `_Znw*` / `_Zna*` / `_Zdl*` / `_Zda*` (`operator new` / `delete`), and `_ZNSt*` / `_ZNKSt*` / `_ZNVSt*` / `_ZNRSt*` / `_ZSt*` / `_ZGVNSt*` for the standard library itself. They cannot go in the existing `extern "C++"` block, which matches demangled names: `typeinfo for std::exception` and `operator new(unsigned long)` have no usable prefix, and a demangled function template leads with its **return type**, so `std::*` silently misses `void std::__1::__sort<…>(…)` and every other out-of-line template instantiation a consumer needs.
- The block must apply **only to the link that embeds libc++**, so it lives in `symbols-linux-cxx-runtime.map` and is spliced into `symbols.map` at a marker by the CMake version-script step. `symbols.map` itself is shared by every ELF target — Android, and the Linux `QVAC_FABRIC_ASAN` build, both of which link a libc++ shared library and define none of these symbols. Applying the block there is wrong twice over: lld defaults to `--no-undefined-version` and rejects the entries named without a wildcard outright, while the wildcard entries silently export llama/ggml's own typeinfo, vtables and `std::` template instantiations that `local: *;` had hidden — 45 extra symbols from a single representative translation unit, so far more across the real module.
- Confirm no `DT_NEEDED libc++.so.1` on `qvac__fabric@0.bare`.

**Addons Linux**

- `qvac_addon_import_fabric_cxx_runtime(<target>)` adds `-nostdlib++` on Linux, applied per target from `qvac_addon_link_fabric` (the `.bare` module) and `qvac_addon_stage_fabric_for_test` (test and fuzz binaries). Per-target rather than in `qvac_addon_project_setup`, because a target that does *not* link fabric — a fuzz target declared without `LINK_FABRIC`, for instance — has nothing to resolve libc++ from and must keep its own.
- `qvac_addon_project_setup` therefore stops deciding the runtime linkage: it keeps `-stdlib=libc++` (the library, needed to compile) and drops the directory-scoped `-static-libstdc++`, which every fabric-linked target would only render inert. The other half of the choice is `qvac_addon_static_cxx_runtime(<target>)`, applied by `qvac_addon_add_fuzz_target` when `LINK_FABRIC` is omitted — verified load-bearing: without it such a binary picks up `DT_NEEDED libc++.so.1` / `libc++abi.so.1` and stops running on a host without LLVM. Leaving the flag directory-scoped instead would cost a blanket `-Wno-unused-command-line-argument` on every fabric-linked target to silence the driver's "argument unused" note, which is a diagnostic worth keeping.
- Keep `DT_NEEDED qvac__fabric@0.bare`.
- Non-template addons (`asr-ggml`, …) need the same Linux flags if they later consume fabric; this QIP’s must-ship set is **current `qvac_addon_link_fabric` consumers**.

**Verification**

- `llm-llamacpp` is not a fabric consumer on `main`, so the in-tree guard is a `model-fit` unit case: an unknown `cache-type-k` is rejected only inside fabric, and `parseGenericConfig` wraps the same parser in the same `catch (const std::exception&)` that `LoadFitNormalization.cpp` does. It asserts the catch matched *by type*, separating that from a `catch (...)` that matched anything — which is exactly the pre-fix Linux behaviour.
- Once `llm-llamacpp` migrates, re-run `config-parameters.test.js` “Negative repeat penalty…” on linux-x64 and linux-arm64; expect the Darwin message, not `Unknown error`.
- Android is the one other ELF target sharing `symbols.map`, so its prebuild is part of the verification surface even though its link model does not change: expect the `android-*` link line to carry no `-nostdlib++` and no whole-archived `libc++.a`, and its exported set to be unchanged.
- `readelf -d` on a backend `.so`: still no `libc++.so.1`; still no `qvac__fabric@0.bare`.
- Spot-check `readelf -s` that backend `_ZTISt9exception` did not become a unique-symbol alias to fabric’s (interposition watch).
- Addon-test ASan: fabric's `operator new` / `delete` are now interposable, so an ASan-linked test executable should serve both sides. Try restoring `alloc_dealloc_mismatch=1` on one package; if it still fires, keep the relaxation and record it as leftover debt.

### Related in-tree comments

- `packages/llm-llamacpp/CHANGELOG.md` — local `load_mode` validation to avoid fabric exceptions crossing the native boundary on Windows.
- `packages/classification-ggml/test/unit/CMakeLists.txt` — ASan vs static fabric libc++ `new`/`delete`.
- `packages/translation-nmtcpp` / `ocr-ggml` lazy-init backends — `RTLD_LOCAL` and per-`.so` ggml-base copies.
