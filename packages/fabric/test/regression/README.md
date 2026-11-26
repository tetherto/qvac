# Shared core regression coverage

These tests establish the baseline for extracting ggml-base and moving Linux
libc++ ownership into it. They do not change shipped linkage. Run them explicitly:
the duplicated layout is expected to fail callback tests, and Windows Debug
builds can fail the allocation test. A known failure remains a failing test;
there is no inverted pass condition or expected-failure allowlist.

## Native module boundary

The standalone CMake project in `../native` supports either an installed ggml
package or an exact source checkout. Allocation uses the **real requested
backend module**, its device buffer type, and the caller's ggml free API. Failure
to load that backend, enumerate a device, or allocate a buffer is a failure,
never a CPU fallback or skip. This works for CPU on machines without a GPU, and
can be repeated for each GPU module on a host supporting it.

Logging and abort use a small deterministic emitter MODULE linked to the same
real ggml-base target that backends use. It calls ggml's internal logging emitter
and public abort API; it does not implement a fake allocator or synchronize
callbacks. This tests core state across the module boundary without depending
on incidental GPU-driver messages. It does not replace hardware backend logging
or production Bare callback/inference coverage.

From the repository root, against an existing Linux vcpkg install:

```sh
cmake -S packages/fabric/test/native -B /tmp/ggml-boundary \
  -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
  -DCMAKE_BUILD_TYPE=Release \
  -Dggml_DIR="$PWD/packages/fabric/build/_vcpkg/x64-linux/share/ggml" \
  -DQVAC_TEST_BACKEND="$PWD/packages/fabric/prebuilds/linux-x64/qvac__fabric-linux-x64/libqvac-ggml-cpu-x64.so"
cmake --build /tmp/ggml-boundary
ctest --test-dir /tmp/ggml-boundary --output-on-failure
```

Use the exact package/headers that built the modules, and the matching compiler
and runtime flags. The Linux default is Clang/libc++; use
`-DQVAC_TEST_LIBCXX=OFF` only for a package built with the GNU runtime. The
standalone executable is an allocation/callback test, not proof of the
production host's runtime bindings; run the Bare audit below too.

To build a real CPU backend directly from the fork, without a GPU SDK:

```sh
cmake -S packages/fabric/test/native -B /tmp/ggml-boundary-static \
  -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
  -DCMAKE_BUILD_TYPE=Debug -DBUILD_SHARED_LIBS=OFF \
  -DQVAC_GGML_SOURCE_DIR=/absolute/path/to/qvac-fabric-llm.cpp/ggml
cmake --build /tmp/ggml-boundary-static
ctest --test-dir /tmp/ggml-boundary-static --output-on-failure
```

Repeat in a separate build directory with `-DBUILD_SHARED_LIBS=ON` as a positive
control. The shared control should pass all three tests. This is a test build
of the existing fork's shared-library mode, not the production migration or a
validation of the proposed exported-libc++ packaging.

On Windows, use a Visual Studio developer terminal and the exact fork checkout:

```powershell
cmake -S packages/fabric/test/native -B build/ggml-boundary-static -A x64 `
  -DQVAC_GGML_SOURCE_DIR=C:/src/qvac-fabric-llm.cpp/ggml `
  -DBUILD_SHARED_LIBS=OFF
cmake --build build/ggml-boundary-static --config Debug
ctest --test-dir build/ggml-boundary-static -C Debug --output-on-failure
```

Both the caller and real CPU DLL are built with `/MTd`. The caller captures CRT
assertions as failures rather than accepting a Release run as ownership proof.
Release-only imported Windows packages are rejected. Repeat with shared mode
in a different directory for the control. Windows requires an actual Windows
run; a Linux pass cannot establish CRT ownership.

`module-logger` registers before loading the module, replaces the callback,
and clears its stack-owned userdata before another emission. `module-abort`
runs in a subprocess: only the callback's exact sentinel exit is accepted;
SIGABRT, load failures, and other exits fail.

## Bare coexistence and actual Linux bindings

Run fabric and diffusion in a fresh process for each load order. The worker loads
explicit prebuild files, initializes both backend sets, checks diffusion's CPU
selection, and calls each again after co-loading. It downloads no models. This
is backend initialization and registry stability coverage, not an inference
comparison or a test of diffusion sharing the new core.

```sh
node packages/fabric/test/regression/coexistence.js \
  --fabric "$PWD/packages/fabric/prebuilds/linux-x64/qvac__fabric-linux-x64.bare" \
  --diffusion "$PWD/packages/diffusion-cpp/prebuilds/linux-x64/qvac__diffusion-cpp-linux-x64.bare" \
  --diffusion-backends "$PWD/packages/diffusion-cpp/prebuilds/linux-x64/qvac__diffusion-cpp-linux-x64" \
  --report-dir /tmp/ggml-coexistence
```

Use `--bare /absolute/path/to/bare-sidecar/prebuilds/linux-x64/bare` to repeat
with the actual sidecar host. The runner uses `LD_DEBUG=bindings,versions` and
`LD_BIND_NOW=1` and checks observed runtime providers, not just NEEDED entries
or the presence of version suffixes. It fails if fabric imports runtime symbols
from the wrong provider, if diffusion imports core/runtime symbols from the
QVAC provider, or if a requested client was not observed. Private definitions
bound within the link are not visible in the loader trace and are not claimed
as verified by this check.

After extraction, pass `--qvac-provider /absolute/path/to/libqvac-ggml-base.so`
instead of the default fabric provider. The option is repeatable if more than
one provider is intentionally part of an experiment. Add
`--qvac-client /absolute/path/to/consumer.bare` for other clients actually loaded
by the worker; each must have observed runtime bindings. This worker currently
loads fabric and diffusion, so exercising more addons requires extending it.

Add `--gnu-client /absolute/path/to/libqvac-ggml-xdna.so` to require observed
XDNA C++ imports to resolve to `libstdc++.so.6`. Add XRT libraries explicitly
with the same option to audit them as well. Missing XRT or an unloaded backend
fails this requested audit rather than silently passing. A private static CUDA
runtime needs additional binary inspection: locally bound symbols do not appear
in a loader trace. Existing module runtime guards remain necessary.

The report directory contains a JSON summary with SHA256 hashes of the addons,
runtime providers, actual native Bare host, and backend modules observed during
loader initialization. Each order records its host and loaded backend paths.
It also contains stdout for each worker and loader diagnostics. Binding lines
are retained only for audited clients to bound trace
size when ROCm dependencies are present. Errors, version diagnostics, and worker
output remain available. A 60-second deadline per order prevents loader or
driver hangs from leaving the test running indefinitely.

For a CPU-only diagnostic, set `QVAC_FABRIC_BACKENDS_DIR` to a directory
containing the exact build's CPU module. This must be reported as subset coverage;
do not use a different revision's backend to make the test load.

## Local baseline on Linux

Recorded on 19 November 2026. The source controls use fabric fork commit
`8d2d538e1220ad26e17ddcdf481830ec53f56fbf`. The available fabric vcpkg package
and CPU prebuild give these results:

| Check | Duplicated core | Shared source control |
| --- | --- | --- |
| Real CPU allocation and API free | Pass | Pass |
| Module logger registration and replacement | Fail | Pass |
| Module abort reaches caller callback | Fail | Pass |

With the exact CPU prebuild staged for fabric, both Bare coexistence workers
complete and select diffusion CPU. The strict binding audit fails in both orders:
fabric's allocation/deallocation operators resolve to Bare, even though the
trace records the QVAC_FABRIC_ABI_1 version requirement. This is evidence that
version suffixes alone do not establish the actual provider. It is retained as
a baseline finding, not exempted or fixed by these tests.

The baseline does not establish Windows `/MTd`, XDNA/XRT, GPU, Android, or
bare-sidecar results. Run those against matching artifacts on the appropriate
hosts before using them as migration acceptance evidence.

## Harness checks

`npm run test:unit` in the fabric package includes the binding-parser and policy
tests. They exercise wrong providers, XDNA collisions, diffusion leakage,
missing observations, and runtime-provider relocation. The artifact-dependent
coexistence audit runs separately using the commands above.

Fabric's package-owned `cpp:build` and `cpp:tests` targets run the installed-port
boundary tests on Linux x64 and Windows x64 through the standard `PR build and
test` workflow. Apply `run-cpp-addon-tests` to run them.
`ci/boundary-regressions.mjs` installs the registry version requested by
`test/native/vcpkg.json`, builds both Release and Debug dependencies, and links
the probes against the installed Debug shared core and CPU backend. It does not
select a local source checkout or run static/shared source controls.

The standard job uploads `cpp-test-results.xml`, including failure output.
This adds no separate workflow or Merge Guard status key. It does not run the
artifact-dependent Bare coexistence audit or hardware backend tests.

To run the same installed-port workflow locally, provision the repository's
vcpkg/Bare toolchain and Vulkan SDK, and set `VCPKG_ROOT` to the vcpkg checkout.
From the repository root on Linux x64:

```sh
pnpm exec nx run @qvac/fabric:cpp:build:linux-x64
pnpm exec nx run @qvac/fabric:cpp:tests:linux-x64
```

On Windows x64, use the `win32-x64` configuration for both targets. Tests and
installed dependencies are kept under `packages/fabric/build/boundary-port`.
For direct source-checkout experiments, use the standalone CMake commands in
[Native module boundary](#native-module-boundary); those are separate from the
registry-port CI workflow.

## Shared-core packaging (step 2)

Dynamic-backend builds now use shared ggml core libraries by default. Both the
Fabric and native regression manifests request registry `qvac-fabric` version
`12032.1.0`. This uses the signed upstream `v12032.1.0` tag at merge commit
`d067e8bd0f7fea2a0ec60ceb20dae42b8ba48f1c`, with no source patches or
shared-core feature. No temporary qvac-fabric overlay is needed, and registry
baselines remain unchanged so unrelated packages retain their resolved versions.

Top-level `BUILD_SHARED_LIBS` remains off: enabling it also changes llama and
mtmd into shared libraries. The source instead sets it within ggml when
`GGML_BACKEND_DL` is selected. llama/helpers remain static; ggml-base, the
backend registry and vector-index become shared libraries with ABI-1 filenames.
CPU-only non-DL builds and Apple retain their previous linkage.

Linux ggml-base embeds and exports libc++ under `QVAC_GGML_BASE_ABI_1`.
Libc++ backends and fabric import it. CUDA keeps private static libstdc++;
XDNA keeps system shared libstdc++/XRT. GNU runtime selection and symbol export
maps live in the fork; installed binary ownership checks live in the port.
Android retains NDK `libc++_shared.so`.

The loader no longer forwards loggers between ggml-base copies or exports
per-backend logger setters. Backend scoring, initialization and later logs use
the shared core's callback directly. The source loader tests cover callback
replacement, userdata, error/continuation messages and reset. Port runtime
fixtures exercise CUDA-only, XDNA-only and combined shared-core linkage; the
old helper that built a separate GNU ggml-base is removed.

The libraries ship in fabric's existing platform package, with `$ORIGIN`
lookup on Linux/Android. Windows core DLLs sit beside the `.bare` entry point;
import libraries and backend DLLs stay in its companion directory. Platform
metadata and `qvac_fabric_import_shared_core(prebuilds host)` support importing
the same package from development consumers. No additional npm package is needed.

To invoke the same registry-port build and tests directly:

```sh
cd packages/fabric
node ci/boundary-regressions.mjs build
node ci/boundary-regressions.mjs test
```

Use the usual provisioned vcpkg/Bare toolchain and Vulkan SDK. The small test
manifest requests GPU backends and vector-index, so it exercises the normal
DL port configuration, all CPU variants, Vulkan and RPC. It builds both
Release and Debug dependencies, then links the tests to the installed Debug
core and a real CPU module. Windows uses the shared Debug CRT (`/MDd`) and
rejects missing Debug core metadata. Logger/abort probes link that same core.
Linux and Windows also verify typed exceptions, `exception_ptr`, stream RTTI and
allocation/destruction across a shared C++ boundary. Linux additionally checks
versioned imports.
Full fabric prebuild CI uses the same registry release and checks staged ELF imports.

The registry `12032.1.0` installed-port Windows x64 validation passes all four
Debug tests with the shared triplet: backend allocation, module logger, module
abort and shared C++ runtime ownership. All 13 direct Fabric consumer CMake
projects use the shared setup helper. Diffusion uses the shared triplet through
its independent setup and explicitly applies the same CRT selection and Release
runtime staging.


Windows source validation with MSVC 14.44, LLVM 23.1.4 and `/MTd` passes the
CPU allocate/free, logger and abort tests. A Release DLL whole-archiving
llama/common/mtmd against the shared core also links and loads successfully.

The historical static-CRT C++ stream/vector probe fails under
`/MTd`: a caller-owned vector is passed into `Uint8BufferStreamBuf`, and the
core reports `__acrt_first_block == header` during DLL teardown. The no-stream
control passes. This is separate from the fixed linker/export collision.
The current LLM addon loads from disk and rejects weight streaming. Its old
`initFromMemory` helper has no production callers in this checkout, so this
probe does not establish a failure in the active model-loading path. The
exported `llama_model_load_from_buffer` API still calls this constructor across
the fabric/core DLL boundary and has the same ownership problem if those
binaries use separate static CRTs.
This static-CRT reproduction is source-only and instruments the core with a
test CRT report hook. The installed-port CI now uses `/MDd` and exercises the
same vector transfer in `shared-cxx-runtime`, along with exception and RTTI
ownership.
Run it in a VS developer shell, with native CMake/Ninja/clang-cl executables:

```powershell
cmake -S packages/fabric/test/native -B build/windows-stream -G Ninja `
  -DCMAKE_BUILD_TYPE=Debug -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl `
  -DQVAC_GGML_SOURCE_DIR=C:/path/to/fabric/ggml `
  -DCMAKE_PROJECT_INCLUDE="$PWD/packages/fabric/test/regression/windows-stream/hook.cmake"
cmake --build build/windows-stream
ctest --test-dir build/windows-stream --output-on-failure
```

The report hook terminates the child with status 86 on any CRT assertion,
including assertions after `main` returns; checking a counter in `main` would
miss this failure. The hook does not change allocation behavior and is never
compiled into shipped core libraries.

### Windows shared CRT control

`windows-shared-crt` is the standalone control that established shared CRT
ownership using `/MDd` in Debug and `/MD` in Release. Production builds now
use those settings through the shared Windows triplets and post-project
CMake helper; the historical `/MTd` source reproduction remains separate.
Both control builds use the actual shared-core source checkout and a real CPU backend. A separate DLL
whole-archives llama/common/mtmd, matching fabric's archive layout, while a
client executable checks typed exceptions, `exception_ptr`, stream RTTI and
allocation/destruction across DLL boundaries. This DLL is a link/ownership
control; it is not the actual Bare addon.

In a VS developer shell with native CMake/Ninja/clang-cl executables:

```powershell
$source = 'packages/fabric/test/regression/windows-shared-crt'
cmake -S $source -B build/windows-shared-crt-debug -G Ninja `
  -DCMAKE_BUILD_TYPE=Debug -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl `
  -DQVAC_FABRIC_SOURCE_DIR=C:/path/to/fabric
cmake --build build/windows-shared-crt-debug --parallel 6
ctest --test-dir build/windows-shared-crt-debug --output-on-failure

cmake -S $source -B build/windows-shared-crt-release -G Ninja `
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl `
  -DQVAC_FABRIC_SOURCE_DIR=C:/path/to/fabric `
  -DMSVC_REDIST_DIR='C:/path/to/VS/VC/Redist/MSVC/toolset-version'
cmake --build build/windows-shared-crt-release --parallel 6
ctest --test-dir build/windows-shared-crt-release --output-on-failure
cmake --install build/windows-shared-crt-release --prefix build/windows-crt-package `
  --component crt-experiment
& ./build/windows-crt-package/bin/runtime_boundary.exe
```

Debug additionally runs the original stream/vector probe with its fatal CRT
assertion hook. Release copies the toolset's redistributable runtime DLLs into
the executable directory and installs a standalone test bundle. Its runtime
test verifies that `msvcp140.dll` and `vcruntime140.dll` actually loaded from
that directory, so a globally installed redistributable cannot mask failure.
The OS-provided UCRT remains a system dependency on supported modern Windows.
Debug runtime DLLs are used only on the development machine and are never
included in the distributable bundle. This is a manual experiment, outside the
installed-port CI target. The production build now applies the CRT flags and
runtime staging directly; no experiment hook is needed.

Validated with MSVC 14.44 and LLVM 23.1.4 against source `f89291d9c`:
all six Debug tests pass, including the stream/vector probe that fails under
`/MTd`. The Release C++ boundary test passes both in the build tree and in the
installed bundle with `PATH` restricted to the Windows system directory.
`msvcp140.dll`, `vcruntime140.dll` and `vcruntime140_1.dll` report loading from
the bundle. PE imports confirm that the caller, fabric-like DLL, core and CPU
backend use the shared runtime. The existing four Linux boundary tests also
pass after making the probe's intentionally throwing C-linkage function
explicitly `noexcept(false)`, as required by Windows `/EHsc` assumptions.

### Packaged Bare inference

`packaged-inference.js` is the consumer smoke app used for CPU and CUDA
validation. Copy it into an empty directory as `index.js`, install locally
packed llm-llamacpp, fabric and platform tarballs (using npm overrides for
fabric and its platform package), and create `config.json`:

```json
{"model":"/absolute/path/to/model.gguf","device":"cpu"}
```

For NVIDIA testing, use `"device":"gpu","backend":"cuda"`. Run the app
with the pinned Bare runtime. It checks two nonempty responses, the reported
device, and clean model unload. Native logging is explicitly registered so
the runner can require a positive GPU layer-offload count. Inspect loaded
module paths separately: exactly one shared base and all qvac modules must
come from the installed app, without build-tree search paths. On Windows,
restrict PATH to System32 and verify the packaged MSVC runtime DLLs load from
the app too. CUDA dependencies may come from the installed toolkit/driver.

Validation after rebasing on qvac main `66872e64d` and refreshing the source
from `temp-12032`:

| Platform | Coverage |
| --- | --- |
| Linux x64 | Installed-port Debug/Release build and four boundary tests; ELF package ownership check; locally packed Fabric 0.33.0, its split CUDA carrier, and llm-llamacpp 0.72.1; two Qwen 3 0.6B CPU requests and clean unload under Bare 1.38.0. |
| Windows x64 | Six `/MDd` boundary tests and the Release boundary test; locally packed Fabric/LLM packages under Bare 1.36.0; CPU with SmolLM2 135M and CUDA with Gemma 3 1B (27/27 layers) and Qwen 3.5 2B (26/26 layers), using an RTX 3080 Ti Laptop GPU and CUDA 13.2. Each model completed two requests and unloaded with exit zero. The module audit found one base and app-local qvac/MSVC DLLs. |
| Android arm64 | NDK 29 CPU build, allocation/logger/abort probes on a Pixel 10 Pro XL, and two Qwen 3 0.6B CPU requests with clean unload under Bare 1.36.0 over ADB. The shell app loads from local npm tarballs without LD_LIBRARY_PATH; the NDK's libc++_shared.so is included in this test fixture. This does not test APK packaging or its linker namespace. |

That validation used source `b21b1ce813`, including the Android RUNPATH fix.
The current port uses upstream `v12032.1.0`, including the logger cleanup,
the optional Windows nm check and the documented linkage-generation policy. CMake suppresses Android
INSTALL_RPATH, so the source explicitly emits `$ORIGIN` for core and backend
libraries, and Fabric emits the companion directory on its `.bare` module.
`ci/verify-android-shared-core.mjs` checks the emitted binaries and rejects
the original missing-RUNPATH package. Android supports DT_RUNPATH from API 24;
these builds target API 29. Those Windows inference runs used isolated `/MD`
overrides. The shared Windows triplets, common addon setup and Fabric packaging
now select that runtime directly; consumers still need to adopt the released
Fabric package in the follow-up migration.

Linux binding audits found the same Bare interception of the allocation-operator
family in released Fabric and the shared-core build. No other C++ runtime symbols
from the audited QVAC libraries resolved to Bare. This is preexisting behavior
and is resolved as a migration blocker; allocation-failure/new-handler behavior
has not been exercised. Bare-sidecar inference passed outside the sandbox.

The shared-CRT ownership path must stay green in the installed-port tests.
Android APK loading and remaining GPU/NPU execution coverage remain unverified.
This PR does not update all consumer npm ranges or remove their compatibility paths.
