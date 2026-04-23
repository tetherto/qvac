# ONNX to GGUF Conversion (Public-safe)

This document describes a public-safe conversion workflow for preparing
MobileNetV3-Small weights for this addon.

## 1) Export PyTorch to ONNX

- Freeze model in eval mode.
- Fold BatchNorm where practical.
- Export with fixed input shape `1x3x224x224`.

## 2) Convert ONNX tensors into GGUF

- Write tensor weights into a GGUF container.
- Store model labels in metadata (`mobilenet.class_*` keys).
- Use FP16 for shipped runtime weights.

## 3) Verify numerics internally

- Compare ONNX and GGUF runtime logits on a private validation corpus.
- Ensure argmax agreement and tight per-logit tolerance.

## 4) Integrate with addon

- Replace `weights/mobilenetv3_3class_v3_fp16.gguf`.
- Keep API output unchanged (`[{ label, confidence }]`).

## Known pitfalls

- BatchNorm epsilon must match training/export settings.
- Depthwise conv paths require exact tensor shape/layout wiring.
- Aggressive quantization can degrade CNN quality.
# Converting a MobileNetV3-Small model to the GGUF format used by this addon

This guide describes how to convert a retrained (or freshly exported)
MobileNetV3-Small PyTorch model into the GGUF container consumed by
`@qvac/classification-ggml`. It is intentionally minimal — the graph
construction in `MobileNetGraph.cpp` is parameterised only by the block
table `kBlocks` and the label metadata inside the GGUF, so swapping in
new classes (or a different fine-tune) does not require any C++ changes
as long as the architecture stays MobileNetV3-Small.

> The bundled weights in `weights/mobilenetv3_3class_v3_fp16.gguf` were
> produced by this exact pipeline. FP16 is numerically identical to the
> ONNX FP32 reference on representative inputs.

## 1. Export from PyTorch to ONNX

```python
import torch
from torchvision.models import mobilenet_v3_small

model = mobilenet_v3_small(weights=None)
# Replace the 1000-class head with an N-class head that matches your target classes.
model.classifier[3] = torch.nn.Linear(1024, NUM_CLASSES)
model.load_state_dict(torch.load("your_finetuned_weights.pth"))
model.eval()

dummy = torch.randn(1, 3, 224, 224)
torch.onnx.export(
    model,
    dummy,
    "mobilenetv3_small.onnx",
    input_names=["input"],
    output_names=["logits"],
    opset_version=17,
)
```

Notes:

- Export the model in **inference mode**. `model.eval()` is mandatory:
  it puts BatchNorm into running-statistics mode.
- Do **not** fold BatchNorm into conv at ONNX export time. This addon
  folds BN at load time inside the C++ code using the GGUF-supplied
  `running_mean`, `running_var`, `weight`, `bias` — it needs the raw
  BN parameters to exist in the file.

## 2. Convert ONNX weights to GGUF

The conversion script used for the bundled model produces a GGUF with
the torchvision tensor naming preserved verbatim (`features.0.0.weight`,
`features.1.block.0.0.weight`, …, `classifier.3.bias`). Any converter
that emits the same tensor names and the required metadata keys works.

Required GGUF **tensor layout**:

- Conv kernels: `[KW, KH, IC, OC]` (ggml convention, matches
  `torch.Tensor` export when dims are reversed).
- Depthwise conv kernels: `[KW, KH, 1, C]`.
- SE `fc1` / `fc2`: `[1, 1, IC, OC]` (1×1 convs, not Linear).
- Classifier `classifier.0.weight`: `[576, 1024]`. 
- Classifier `classifier.3.weight`: `[1024, NUM_CLASSES]`.
- BN tensors (`weight`, `bias`, `running_mean`, `running_var`): `[C]`
  1-D. `num_batches_tracked` is accepted but ignored.

Required GGUF **metadata keys**:

| Key | Type | Example |
|-----|------|---------|
| `general.architecture` | string | `"mobilenetv3-small"` |
| `general.description` | string | `"MobileNetV3-Small 3-class FP16"` |
| `mobilenet.architecture` | string | `"mobilenetv3_small"` |
| `mobilenet.num_classes` | uint32 | `3` |
| `mobilenet.image_size` | uint32 | `224` |
| `mobilenet.class_0` | string | `"food"` |
| `mobilenet.class_1` | string | `"report"` |
| `mobilenet.class_2` | string | `"other"` |
| `mobilenet.mean_r/g/b` | float32 | `0.485 / 0.456 / 0.406` |
| `mobilenet.std_r/g/b` | float32 | `0.229 / 0.224 / 0.225` |
| `mobilenet.bn_eps` | float32 | **`0.001`** (required — see below) |
| `mobilenet.precision` | string | `"fp16"` or `"fp32"` |

Quantization choice:

- **FP16** is the target for shipping; FP16 produces numerically
  identical predictions to the FP32 reference on representative inputs.
- **FP32** is supported for debugging. Twice the file size, same output.
- **INT8 / Q4_0 are destructive** for MobileNetV3-Small because
  depthwise convolutions have only 9–25 weights per channel. Sub-8-bit
  quantization introduces unacceptable error on these layers. Do not
  ship quantized variants.

## 3. Verify numerical equivalence

Run the C++ addon against your internal set of reference images and
compare logits to the ONNX reference:

```
| logit_difference | < 1e-4 per class, FP32
| argmax agreement | must match the ONNX reference on every image
```

`test/integration/classify.test.js` and
`test/unit/classification_model_test.cpp` cover the shape contract and
the per-image argmax on the 6 public sample images shipped in
`test/images/`. The per-image logit-diff check against ONNX is done
with an external script during development (not bundled in this
package because it requires PyTorch / onnxruntime) and must not embed
any private validation data into the public package.

## 4. Update the bundled weights

1. Place the new `.gguf` in `packages/qvac-lib-infer-ggml-classification/weights/`.
2. Keep the filename identical (`mobilenetv3_3class_v3_fp16.gguf`) or
   update `DEFAULT_WEIGHTS_FILENAME` in `index.js`.
3. Bump the package version (`package.json` + `CHANGELOG.md`).
4. Re-run `npm run test:integration` and `npm run test:cpp`.

## 5. Supporting a new block table (advanced)

If you switch to a different MobileNet variant (V3-Large, V4, etc.),
update `kBlocks` in `MobileNetGraph.hpp` to reflect the new
expand/project channels, kernel sizes, strides, SE reducer sizes,
and HardSwish/ReLU flags. The graph construction loop iterates over
`kBlocks`; no other change is required as long as the GGUF tensor
naming follows `features.<N>.block.<idx>.*` conventions.

## Known pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| BN epsilon `= 1e-5` instead of `0.001` | Normalisation drift accumulated across 34 layers, observable class flips on representative images | Store `0.001` in `mobilenet.bn_eps` |
| DW kernel as `[K, K, C, 1]` | `ggml_conv_2d_dw` asserts | Re-pack to `[K, K, 1, C]` |
| Missing SE biases | First-class crashes | Always export `fc1.bias` / `fc2.bias` even if zero |
| Classifier weight as `[OC, IC]` instead of `[IC, OC]` | `ggml_mul_mat` mis-computes | Transpose before writing to GGUF |
| Mixed precision (some tensors FP32, some FP16) | Works, but bigger file | Standardise on FP16 for ship |
