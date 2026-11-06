# @qvac/sglang

Experimental package on the `sglang` branch. It is not wired into CI or the
SDK release flow.

The vcpkg overlay port at `vcpkg/ports/sglang-cpp` builds
[jpgaribotti/sglang-cpp](https://github.com/jpgaribotti/sglang-cpp)
`de1d78416f47a4fc541ca96af582b2f63429be2f` and installs:

- `qvac_grid_server` and `qvac_grid_rank_worker`
- the model registry, runtime compile sidecar, and any selected kernel packages

`pnpm build` copies that install into `dist/` so the package can launch the
server. The rank worker is placed next to the server. `dist/lib/qvac-grid`
is the `--artifacts` package root. By default the build does not include model
kernel packages. `QVAC_GRID_PACKAGE_DIR` can point at prebuilt packages; the
port's AOT kernel build path has not yet been validated. A server built without
kernel packages cannot run inference.

## Host toolchain

Upstream CMake finds these on the machine. They are not vcpkg ports. Use the
stock Linux triplet from `cmake-vcpkg` (libstdc++). The shared monorepo
triplets force libc++, which does not match official LibTorch.

| Variable                           | Required                                | Role                                        |
| ---------------------------------- | --------------------------------------- | ------------------------------------------- |
| `GITHUB_TOKEN` or `GH_TOKEN`       | yes                                     | read access to the private repository       |
| `Torch_DIR` or `CMAKE_PREFIX_PATH` | yes                                     | LibTorch CMake package                      |
| `QVAC_GRID_TVM_FFI_ROOT`           | yes                                     | TVM-FFI library and headers                 |
| `QVAC_GRID_FLASHINFER_ROOT`        | yes                                     | FlashInfer headers for CUDA modules         |
| `QVAC_GRID_CUDA_ROOT`              | when CUDA is not on the default path    | CUDA toolkit matching LibTorch              |
| `QVAC_GRID_NCCL_ROOT`              | when NCCL is not on the default path    | NCCL matching LibTorch                      |
| `QVAC_GRID_ZMQ_ROOT`               | when ZeroMQ is not on the default path  | libzmq and cppzmq                           |
| `QVAC_GRID_MSGPACK_ROOT`           | when msgpack is not on the default path | msgpack-c headers                           |
| `QVAC_GRID_XGRAMMAR_ROOT`          | for constrained decoding                | XGrammar C++ package                        |
| `QVAC_GRID_CUDA_ARCH`              | no                                      | e.g. `90a`, `120a`, or `121a`               |
| `QVAC_GRID_PACKAGE_DIR`            | for prebuilt kernels                    | directory of kernel packages for the target |
| `QVAC_GRID_BUILD_AOT_KERNELS`      | to compile kernel packages              | set to `ON` with the required build tools   |

The reference toolchain and runtime requirements are documented in the pinned
QVAC Grid source's `README.md` and `docker/build.Dockerfile`. In particular,
serving requires the pinned Python compile-sidecar environment, CUDA toolkit,
and external libraries in addition to a compatible kernel package. The port
downloads and patches the pinned upstream SGLang source during its download
phase; it does not install the remaining host dependencies.

```sh
corepack pnpm --filter @qvac/sglang build
```

## Launch

```sh
corepack pnpm --filter @qvac/sglang exec sglang-cpp-server \
  --model /path/to/checkpoint \
  --host 127.0.0.1 \
  --port 30000 \
  --tp-size 2
```

From JavaScript, `startServer({ model, port, tpSize })` spawns the same
binary. `--artifacts` defaults to the staged package.
