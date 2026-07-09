# @qvac/fabric

Shared bare addon that hosts the **qvac-fabric** runtime (Tether's fork of
`llama.cpp` + `ggml`) as a single prebuilt shared library. Consumer addons
(`@qvac/llm-llamacpp`, `@qvac/embed-llamacpp`, …) declare `@qvac/fabric` as an
npm dependency and dynamically link against it, so the multi-hundred-megabyte
llama/ggml runtime is **built once** and **loaded once per process** instead of
being statically embedded into every addon.

It is modeled on [`@qvac/onnx`](../onnx) and follows the same
npm + `prebuilds/` + `include_bare_module(... PREBUILD)` + companion-`.bare`
pattern. See [INTEGRATION.md](./INTEGRATION.md) for the consumer guide.

## What it ships

- **Prebuilt `.bare` shared library** (`prebuilds/<platform>/qvac__fabric.bare`)
  — contains `libllama`, `libcommon`, `libmtmd`, and `libggml-base`. It exports the full
  `llama_* / LLAMA_* / ggml_* / gguf_* / mtmd_*` C API plus the `common_*` and
  `json_schema_to_grammar` C++ symbols.
- **C++ headers** (`prebuilds/include/`) — `ggml*.h`, `gguf.h` at the root and
  `llama.h`, `llama-cpp.h`, `common/*.h`, `mtmd/*.h` under `include/llama/`.
- **CMake config** (`prebuilds/share/qvac-fabric/`) — `find_package(qvac-fabric)`
  exposes `qvac-fabric::headers` for compile-time includes
- **ggml compute backends** — on **Linux and Android**, separate shared libraries
  ship under `prebuilds/<platform>/qvac__fabric/` and are loaded at runtime via
  `ggml_backend_load_all_from_path()`. On **macOS, Windows, and iOS** the backends
  are linked statically inside `qvac__fabric.bare` and self-register on load.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Consumer addons (.bare)                                   │
│  @qvac/llm-llamacpp   @qvac/embed-llamacpp   …             │
│  link qvac-fabric::headers + DT_NEEDED qvac__fabric@0.bare │
└───────────────────────────┬────────────────────────────────┘
                            │ (ELF SONAME dedup → one load)
┌───────────────────────────▼────────────────────────────────┐
│  qvac__fabric@0.bare  (this package)                        │
│  libllama · libcommon · libmtmd · libggml-base              │
│  + ggml backends (.so on Linux/Android; static elsewhere)   │
│  exports llama_* / LLAMA_* / ggml_* / gguf_* / mtmd_* /     │
│          common_* / json_schema_to_grammar                  │
└───────────────────────────┬────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────┐
│  qvac-fabric vcpkg port (forked llama.cpp + ggml)           │
└──────────────────────────────────────────────────────────┘
```

**Key design points:**

- **Single runtime load** — Every consumer addon's `.bare` has
  `DT_NEEDED: qvac__fabric@0.bare`. The dynamic linker deduplicates by SONAME,
  so the llama/ggml runtime is loaded exactly once per process, no matter how
  many fabric-based addons are present.
- **No JS API** — `@qvac/fabric` is a carrier module. Consumers `require()` it
  only to register the `.bare` with the bare runtime before resolving their own
  addon (see INTEGRATION.md Step 5). All inference happens through the consumer's
  own C++ code against the shipped headers.
- **Backends** — ggml compute backends resolve their `ggml_*` references against
  the single loaded `qvac__fabric@0.bare`.

## Build

```bash
npm install
npm run build   # bare-make generate && bare-make build && bare-make install
```

## Supported platforms

| Platform | Triplet | Backends |
|----------|---------|----------|
| Linux | `x64-linux`, `arm64-linux` | shared `.so` under `prebuilds/<platform>/qvac__fabric/` |
| macOS | `arm64-osx` | static (CPU, Metal) inside `.bare` |
| Windows | (default MSVC) | static inside `.bare` |
| Android | `arm64-android` | shared `.so` under `prebuilds/<platform>/qvac__fabric/` |
| iOS | `arm64-ios` | static inside `.bare` |
