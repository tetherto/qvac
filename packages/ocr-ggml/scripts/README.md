# `@qvac/ocr-ggml` — scripts

Helper scripts for development and packaging. These are kept here for the
repository workflow and are **not** shipped to npm consumers.

## `check_ggml_backends.sh`

Diagnostic that reports which ggml backends and BLAS paths actually shipped
in this build. Run **after** `bare-make install`:

```bash
bash scripts/check_ggml_backends.sh
```

By default it inspects `prebuilds/<host>/qvac__ocr-ggml/` — override with the
`BACKENDS_DIR` environment variable to point at any other install prefix.

Sections it prints:

1. **Shipped backend libraries** — `libggml-cpu.so`, `libggml-vulkan.so`,
   `libggml-opencl.so`, … (whichever ones `qvac-fabric[gpu-backends]`
   produced for this triplet).
2. **Linked dependencies (`ldd`)** — confirms what each shared lib pulls in
   from the host (e.g. `libvulkan.so.1`, `libOpenCL.so.1`).
3. **Compile-time markers (`strings`)** — checks for canonical symbols:
   - `llamafile_sgemm` → tinyBLAS fast-path baked in
   - `cblas_sgemm` → external BLAS registered (often present but unused
     unless `OcrModel` is routed through the scheduler API)
   - `vkCreateInstance` / `clCreateContext` / `cudaMalloc` /
     `MTLCreateSystemDefaultDevice` → presence of each GPU backend
4. **vcpkg port summary** — declared `qvac-fabric` version + a hint at
   where to find the resolved version in the build tree.

This script does not invoke the addon at runtime — for runtime backend
selection, instantiate `OcrGgml` and watch the `[OCR MODEL]` log lines
when called with a `logger` object (see `examples/quickstart.js`).

## Model conversion

GGUF weight conversion from upstream EasyOCR PyTorch checkpoints is performed
by the converter that ships with
[`tetherto/easy-ocr-ggml`](https://github.com/tetherto/easy-ocr-ggml/blob/main/scripts/pth_to_gguf.py).
We deliberately don't carry our own copy: keeping a single source of truth
for the conversion logic upstream means quantization defaults, GGUF schema
tweaks, and architecture autodetection stay in lock-step across both
projects.

```bash
# Reuse the upstream EasyOCR venv (has torch + easyocr already pinned):
~/code/EasyOcr-ggml/scripts/pth_to_gguf.py \
    ~/.EasyOCR/model/english_g2.pth \
    packages/ocr-ggml/models/english_g2.gguf
```
