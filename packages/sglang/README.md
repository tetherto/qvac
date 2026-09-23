# @qvac/sglang

Experimental package on the `sglang` branch. It is not wired into CI or the
SDK release flow.

The vcpkg overlay port at `vcpkg/ports/sglang-cpp` builds
[jpgaribotti/sglang-cpp](https://github.com/jpgaribotti/sglang-cpp)
`9901aa955e1eadf1ee96416b28e718859e7a7c2f` and installs:

- `sglang_cpp_server`
- `sgl_qwen_rank_worker`
- the packaged AOT kernels plus `registry/models-887c401e1.json`

`pnpm build` copies that install into `dist/` so the package can launch the
server. The rank worker is placed next to the server. `dist/lib/sglang-cpp`
is the `--artifacts` package root.

## Host toolchain

Upstream CMake finds these on the machine. They are not vcpkg ports. Use the
stock Linux triplet from `cmake-vcpkg` (libstdc++). The shared monorepo
triplets force libc++, which does not match official LibTorch.

| Variable                           | Required                                | Role                                        |
| ---------------------------------- | --------------------------------------- | ------------------------------------------- |
| `GITHUB_TOKEN` or `GH_TOKEN`       | yes                                     | read access to the private repository       |
| `Torch_DIR` or `CMAKE_PREFIX_PATH` | yes                                     | LibTorch CMake package                      |
| `SGL_TVM_FFI_ROOT`                 | yes                                     | TVM-FFI used by the AOT modules             |
| `SGL_SGLANG_KERNEL_ROOT`           | yes                                     | pinned SGLang kernel sources                |
| `SGL_CUDA_ROOT`                    | when CUDA is not on the default path    | CUDA toolkit matching LibTorch              |
| `SGL_NCCL_ROOT`                    | when NCCL is not on the default path    | NCCL matching LibTorch                      |
| `SGL_ZMQ_ROOT`                     | when ZeroMQ is not on the default path  | libzmq and cppzmq                           |
| `SGL_MSGPACK_ROOT`                 | when msgpack is not on the default path | msgpack-c headers                           |
| `SGL_XGRAMMAR_ROOT`                | for constrained decoding                | XGrammar C++ package                        |
| `SGL_CUDA_ARCH`                    | no                                      | `90a` (H100, default) or `121a` (DGX Spark) |

ZeroMQ, msgpack, libunistring, CUDA, NCCL, LibTorch, TVM-FFI, the SGLang
kernel tree, and XGrammar are host packages. The port does not build them.

A local toolchain for this machine is installed under `.toolchain/` (gitignored).
It provides LibTorch 2.13.0+cu130, NCCL 2.29.7, CUDA nvcc 13.0.88, TVM-FFI
0.1.11, XGrammar 0.2.1, cppzmq 4.10.0, and SGLang kernels at `887c401e1`.

```sh
source packages/sglang/.toolchain/env.sh
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
