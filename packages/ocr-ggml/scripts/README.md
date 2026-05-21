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
     unless `EasyOcrModel` is routed through the scheduler API)
   - `vkCreateInstance` / `clCreateContext` / `cudaMalloc` /
     `MTLCreateSystemDefaultDevice` → presence of each GPU backend
4. **vcpkg port summary** — declared `qvac-fabric` version + a hint at
   where to find the resolved version in the build tree.

This script does not invoke the addon at runtime — for runtime backend
selection, instantiate `OcrGgml` and watch the `[OCR MODEL]` log lines
when called with a `logger` object (see `examples/quickstart.js`).

## Model conversion

GGUF weight conversion from upstream EasyOCR PyTorch checkpoints is now
performed by the converter that ships inside this package. The previous
home of the script was `tetherto/easy-ocr-ggml`; we vendored it in so
`ocr-ggml` is self-sufficient and doesn't depend on a sibling repo
checkout. The script depends only on the upstream `easyocr` PyPI package
(for its filename → arch/vocab registry) plus `torch`, `numpy`, and
`gguf` — see `requirements.txt`.

### Files in this directory

| File | Purpose |
|---|---|
| `pth_to_gguf.py` | The converter itself. Takes an EasyOCR `.pth`, writes a `.gguf` with provenance + CTC vocab metadata, and optionally quantizes weight matrices to `Q8_0` / `Q4_K`. |
| `requirements.txt` | Pip deps for the converter (`gguf`, `numpy`, `torch`, `easyocr`). |
| `setup-venv.sh` | One-shot provisioning: creates `./venv` and installs `requirements.txt`. Idempotent. |
| `convert-model.sh` | Thin wrapper around `pth_to_gguf.py` that auto-discovers `./venv`, sanity-checks the modules, mkdir's the output dir, and forwards arguments. |

### Quickstart

```bash
cd packages/ocr-ggml

# One-time: provision the local venv (~/.cache/pip seeds torch + easyocr).
npm run setup:venv

# Detector (CRAFT) -- keep as F32; small and accuracy-sensitive.
npm run convert-model -- \
    ~/.EasyOCR/model/craft_mlt_25k.pth \
    models/craft_mlt_25k.gguf

# Recognizer (gen2) -- Q8_0 is essentially lossless.
npm run convert-model -- \
    ~/.EasyOCR/model/english_g2.pth \
    models/english_g2.q8_0.gguf \
    --quantize Q8_0

# Big multi-script recognizer -- Q4_K shrinks ~215 MB -> ~30-40 MB.
npm run convert-model -- \
    ~/.EasyOCR/model/latin.pth \
    models/latin.q4_k.gguf \
    --quantize Q4_K
```

Things worth checking in the printed output:

- `quantized=N` vs `fallback to F32 for M tensors` — small odd-shape
  tensors that don't satisfy a block-size constraint (Q8_0 inner dim
  divisible by 32; Q4_K inner dim divisible by 256) silently fall back
  to F32. Some `M` is normal.
- `crnn vocab: K chars (+1 blank = K+1 classes)` — confirms the right
  vocab was picked up from `easyocr.config`.
- A trailing `WARNING: vocab implies X classes but Prediction.bias has Y`
  means the GGUF is unusable — the filename matched the wrong language
  entry in `easyocr.config`. Pass `--arch <name>` to override.

### Direct invocation (no npm)

Both shell scripts are usable on their own:

```bash
bash scripts/setup-venv.sh
bash scripts/convert-model.sh ~/.EasyOCR/model/english_g2.pth models/english_g2.gguf --quantize Q8_0
```

You can also bypass the wrapper entirely and run the Python directly
against any interpreter that has the four required modules:

```bash
./venv/bin/python scripts/pth_to_gguf.py \
    ~/.EasyOCR/model/english_g2.pth models/english_g2.gguf --quantize Q8_0
```

### Notes

- Outputs go under `packages/ocr-ggml/models/` by convention. That path
  is already in `.gitignore`.
- `setup-venv.sh` is idempotent; pass `--force` to wipe and recreate.
- Adding support for a new EasyOCR language usually requires no change
  here: as long as it lands in upstream `easyocr.config.detection_models`
  / `recognition_models`, the converter will pick the right vocab from
  the installed `easyocr` package.
