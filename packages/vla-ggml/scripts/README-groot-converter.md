# GR00T N1.7-3B weight converter — pipeline + quantisation scheme

This document is the **source of truth** for how a GR00T N1.7-3B checkpoint
becomes the single `groot.gguf` (and its quantised `groot-q8_vf16.gguf`) that
`vla-ggml` loads, and for which tensors get quantised to what.

Unlike π₀.₅ (one converter script), GR00T is a **3-stage** pipeline. The split
is forced by the backbone reusing qvac-fabric's external `convert_hf_to_gguf.py`
— do **not** try to collapse it into one script.

## Pipeline

```
GR00T-N1.7-3B/                      (original HF checkpoint)
  │
  │ 1. _repackage_groot_backbone.py         strip backbone.model. prefix,
  │                                         num_hidden_layers -> 16
  ▼
repackaged-qwen3vl-backbone/        (standard Qwen3-VL HF dir)
  │
  │ 2a. fabric convert_hf_to_gguf.py --outtype f16   (text decoder)
  │ 2b. fabric convert_hf_to_gguf.py --mmproj        (vision tower)
  │ 2c. convert_groot_dit_to_gguf.py                 (action head)
  ▼
groot-backbone-text.gguf  +  groot-backbone-vision.gguf  +  groot-action-head.gguf
  │
  │ 3a. _merge_groot_gguf.py                byte-copy 3 parts -> 1 file
  ▼
groot.gguf                          (unified, F16 backbone + F32 head, ~8.9 GB)
  │
  │ 3b. quantize_groot_gguf.py --profile q8_vf16
  ▼
groot-q8_vf16.gguf                  (~3.76 GB — the shipped CI/runtime artefact)
```

### Stage 1 — repackage the backbone

`_repackage_groot_backbone.py` strips the `backbone.model.` attribute prefix
(GR00T wraps a full `Qwen3VLForConditionalGeneration` at that path) so the tensor
names match a standard Qwen3-VL checkpoint, and rewrites
`text_config.num_hidden_layers` to **16** (GR00T's `select_layer` truncation —
only layers 0-15 exist in the checkpoint). It pulls the vision/text hparams +
tokenizer from a real `nvidia/Cosmos-Reason2-2B` config dir (GR00T's own
`config.json` omits them).

```
python _repackage_groot_backbone.py \
    --groot-checkpoint   /path/to/checkpoints/GR00T-N1.7-3B \
    --cosmos-config-dir  /path/to/checkpoints/Cosmos-Reason2-2B-config \
    --out                /path/to/checkpoints/repackaged-qwen3vl-backbone \
    --num-layers 16
```

### Stage 2 — convert to GGUF parts

**Backbone (2a/2b)** reuses qvac-fabric-llm.cpp's own `convert_hf_to_gguf.py`
(`Qwen3VLVisionModel` / `Qwen3VLTextModel`) against the repackaged dir — its
patch-embed Conv3D→2×Conv2D split and deepstack mergers (layers 5/11/17) are
already tested there, so we write no new tensor map:
- `groot-backbone-text.gguf` — 179 tensors, `qwen3vl` arch, 16 layers.
- `groot-backbone-vision.gguf` — 316 tensors, mmproj (vision tower + `mm.*`).

**Action head (2c)** is genuinely new work — `convert_groot_dit_to_gguf.py`
converts `action_head.*` (VL fusion, DiT, timestep + embodiment MLPs). The
`CategorySpecificLinear` embodiment weights are **sliced to one embodiment at
conversion time** and stored dense, so the ggml loader needs no runtime
embodiment-ID input.

```
python convert_groot_dit_to_gguf.py \
    --checkpoint      /path/to/checkpoints/GR00T-N1.7-3B \
    --embodiment-tag  libero_sim \
    --out             /path/to/checkpoints/groot-action-head.gguf
```

Output carries `general.architecture="groot"` + all `groot.*` metadata (hidden
sizes, layer counts, `image_token_id`, `embodiment_cat_id`, …).

### Stage 3 — merge + quantise

`_merge_groot_gguf.py` byte-copies the 3 parts into one `groot.gguf`. The three
namespaces are disjoint (`blk.*`/`token_embd` text, `v.*`/`mm.*` vision,
`dit.*`/`vlfusion.*`/`embodiment.*` head), so names are copied **as-is, not
prefixed** — `groot.cpp` looks tensors up by literal name ported verbatim from
fabric's graph code. `general.architecture` + `groot.*` come from the action-head
part; the parts' own `general.`/`tokenizer.`/`clip.`/`vision.` keys are dropped
(the loader doesn't use llama.cpp's model-loading path).

```
python _merge_groot_gguf.py \
    --text        /path/to/checkpoints/groot-backbone-text.gguf \
    --vision      /path/to/checkpoints/groot-backbone-vision.gguf \
    --action-head /path/to/checkpoints/groot-action-head.gguf \
    --out         /path/to/checkpoints/groot.gguf

python quantize_groot_gguf.py \
    --in      /path/to/checkpoints/groot.gguf \
    --profile q8_vf16
```

## Quantisation scheme

`quantize_groot_gguf.py` is a standalone, re-runnable pass (merge stays a pure
byte-copy) so profiles can be swept and gated against the M4.x parity tests.

### Must stay unquantised (guardrail — quantising these produces silent garbage)

| Pattern | Kept | Reason |
|---|---|---|
| `v.patch_embd.*`, `v.position_emb*` | F16 | Read via **raw host memory** in `grootBuildPatchEmbedLinear` / `grootBuildVisionPosEmbed` (only understands F16/F32; a Q8_0 block read as F16 = garbage). |
| `embodiment.*` | F16 | Consumed via `grootLinearXW` = `ggml_cont(ggml_transpose(W))`; ggml can't make a *transposed* quantised tensor contiguous (blocks span the reduction axis). Single-embodiment, tiny anyway. |
| any 1-D tensor (norms, biases) | as-is | Per-element math; negligible size; Q8_0 needs the blocked axis to be a multiple of 32. |

Everything else flows through `grootLinear` = `ggml_mul_mat(W, x)`, which
dequantises `W` natively — safe to quantise.

### Profiles

| Name | text / DiT / vlfusion / head | vision tower (`v.*`, `mm.*`) | Size | Use when |
|---|---|---|---|---|
| `q8_0` | Q8_0 | Q8_0 | 3.38 GB | rejected — see below |
| **`q8_vf16`** (desktop) | Q8_0 | **F16** | **3.76 GB** | **default** — all parity gates hold (infer-parity cos 0.999992 DROID / 0.999995 LIBERO) |
| **`q5_vf16`** (mobile) | Q5_0 | **F16** | **2.74 GB** | LIBERO mobile — cos 0.999964, fits the on-device budget the `ggml_gallocr` infer() refactor freed up |
| `q4_vf16` | Q4_0 | **F16** | **2.40 GB** | backup only — too coarse for LIBERO's DiT action head (a low-magnitude channel hits ~20 % rel error); fine for DROID (rel 1.7 %) |

**Why vision stays F16.** The vision tower is the one quant-sensitive subgraph:
24 LayerNorm blocks accumulate error with no massive-activation outlier to anchor
cosine (unlike the text decoder). Plain `q8_0`-everything pushes the merged-vision
parity gate from cos 0.999 / rel 4.6 % (F16 floor) down to **0.9958 / 9.6 %**,
which cascades to the VL-fusion gate (0.973). The final *actions* stay cos 0.99999
either way (the DiT washes vision drift out), but the intermediate M4.5/M4.6 gates
fail — so we keep vision at F16 (~+0.4 GB) and Q8_0 everything else. `q8_vf16`
passes all 6 M4.x parity gates; final infer-parity **cos 0.999992 / rel 0.0059**.

## LIBERO checkpoint

The shipped model of record is the **LIBERO** post-trained checkpoint
(`nvidia/GR00T-N1.7-LIBERO`, subfolder `libero_10`), not the base N1.7-3B —
LIBERO has a closed-loop simulator (for the demo), DROID doesn't. It's the
**same architecture**, so the pipeline and graph are unchanged; only three
things differ:

- **Embodiment**: pass `--embodiment-tag libero_sim` to
  `convert_groot_dit_to_gguf.py` (resolves to `cat_id 2`; base/DROID used
  `oxe_droid_relative_eef_relative_joint` = 24).
- **Vision convert must force F16**: run stage 2b as
  `convert_hf_to_gguf.py … --mmproj --outtype f16`. Without `--outtype f16` the
  vision weights stay **BF16** and `_merge_groot_gguf.py` aborts ("Only
  F16/F32/… supported").
- **Fixture dims** (for the oracle dump): LIBERO = **2 images** (2 cameras × 1
  frame; 512 patches) and **148 tokens**, vs DROID's 4 / 280. The action/state
  space is unchanged (the DiT still runs 40 tokens × 132; LIBERO's 16 steps × 7
  is a consumer-side slice). `dump_groot_activations.py --embodiment libero`
  carries the right keys/dims. The LIBERO config sets
  `use_flash_attention: true` — flip it to `false` (sdpa) on a Turing GPU.

Parity (vs the LIBERO PyTorch oracle): `q8_vf16` cos **0.999995** / rel 0.0053,
`q5_vf16` cos **0.999964**.

## Mobile

Mobile ships **`q5_vf16` (2.74 GB)** — the `ggml_gallocr` refactor of `infer()`
cut the runtime footprint (12.9 GB → 4.68 GB peak) so the model-file size is now
the binding constraint, and 2.74 GB fits the on-device budget that killed π₀.₅
at 3.76 GB. Q5_0 (not Q4_0) is required: legacy Q4_0 is too coarse for LIBERO's
DiT action head. **K-quants (Q4_K/Q5_K/Q6_K) are not usable** — qvac-fabric's
`gguf-py` packer only implements the legacy Q4_0/Q4_1/Q5_0/Q8_0 layouts. Mobile
is gated end-to-end on cosine (the strict `rel < 0.05` gate stays the desktop
`q8_vf16` gate; the JS mobile test is plumbing-only).
