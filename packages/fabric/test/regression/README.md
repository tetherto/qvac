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

The report directory contains a JSON summary with input binary SHA256 hashes,
stdout for each worker, and loader diagnostics. Binding lines are retained only for audited clients to bound trace
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
missing observations, and runtime-provider relocation. Native and coexistence
tests remain explicit during the baseline phase because their confirmed
failures are the behaviors the later migration must resolve.

Fabric's package-owned `cpp:build` and `cpp:tests` targets run these source-based
tests on Linux and Windows through the standard `PR build and test` workflow.
Apply `run-cpp-addon-tests` to run them. `ci/boundary-regressions.mjs` pins the
source revision used for the local controls and runs both layouts even if one
fails. Static failures stay red; the shared build is the positive control.
The standard job uploads each build's `cpp-test-results.xml`, including failure
output. This adds no separate workflow or Merge Guard status key. It does not
run the artifact-dependent Bare coexistence audit or hardware backend tests.

To rehearse locally with an existing clean checkout of the pinned source:

```sh
QVAC_GGML_BOUNDARY_SOURCE=/absolute/path/to/qvac-fabric-llm.cpp \
  pnpm exec nx run @qvac/fabric:cpp:build:linux-x64
pnpm exec nx run @qvac/fabric:cpp:tests:linux-x64
```
