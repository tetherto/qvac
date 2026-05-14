# `@qvac/ocr-ggml` — scripts

Helper scripts for development and packaging. None of these are shipped to npm
consumers — they are kept here for the repository workflow.

## `pth_to_gguf.py`

Converts EasyOCR PyTorch checkpoints (`.pth`) into GGUF weight files that this
addon can load. Lifted verbatim from
[`tetherto/easy-ocr-ggml`](https://github.com/tetherto/easy-ocr-ggml).

### Quick start

```bash
# 1. Create a venv with the required Python deps
python -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt

# 2. F32 conversion (default)
python scripts/pth_to_gguf.py \
    ~/.EasyOCR/model/craft_mlt_25k.pth \
    models/craft_mlt_25k.gguf

# 3. Q8_0 quantization
python scripts/pth_to_gguf.py \
    ~/.EasyOCR/model/english_g2.pth \
    models/english_g2_q8_0.gguf \
    --quantize Q8_0

# 4. Q4_K quantization
python scripts/pth_to_gguf.py \
    ~/.EasyOCR/model/english_g2.pth \
    models/english_g2_q4_k.gguf \
    --quantize Q4_K
```

The converter auto-detects model architecture from the filename
(`craft_mlt_25k.pth` → CRAFT detector; `*_g2.pth` → CRNN gen-2 recognizer).
For custom checkpoints not listed in `easyocr.config`, pass `--arch
{craft,crnn_gen2}` explicitly.

### Tip: reuse the upstream EasyOCR venv

If you already have the upstream EasyOCR Python package installed (e.g. to
generate the canonical reference outputs), just point at that interpreter
instead of creating a new venv:

```bash
~/code/EasyOCR/.venv/bin/python scripts/pth_to_gguf.py \
    ~/.EasyOCR/model/english_g2.pth models/english_g2.gguf
```

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
