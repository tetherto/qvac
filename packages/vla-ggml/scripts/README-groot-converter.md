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
converts `action_head.*` (VL fusion, DiT, timestep + embodiment MLPs). By
default it runs in **multi-embodiment** mode: the 7 `CategorySpecificLinear`
weights are stored as rank-3 tensors (one `[out,in]` row per distinct trained
`cat_id`) and the loader selects one row at load, switchable afterwards with
`model.setEmbodiment(tag)` — one GGUF, one load, serves every embodiment it
carries. See [Multi-embodiment](#multi-embodiment) below. The
legacy single-embodiment mode (`--embodiment-tag`, slice one row into a 2D
dense tensor at conversion time) is still available.

```
python convert_groot_dit_to_gguf.py \
    --checkpoint      /path/to/checkpoints/GR00T-N1.7-3B \
    --out             /path/to/checkpoints/groot-action-head.gguf
```

Output carries `general.architecture="groot"` + all `groot.*` metadata (hidden
sizes, layer counts, `image_token_id`, the `groot.embodiment.*` table, …).

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
| `embodiment.*` | F16 | Two reasons: consumed via `grootLinearXW` = `ggml_cont(ggml_transpose(W))` and ggml can't make a *transposed* quantised tensor contiguous (blocks span the reduction axis); and in multi-embodiment mode the loader byte-slices one `[out,in]` row out of the rank-3 tensor (`grootSliceEmbodiment`), which needs a uniform per-element size and block-aligned rows — F16 sidesteps the Q5_0/Q8_0 block-packing alignment entirely. ~300 MB for all 17 rows. |
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

## Multi-embodiment

GR00T's 7 `CategorySpecificLinear` layers (`state_encoder.layer1/2`,
`action_encoder.w1/2/3`, `action_decoder.layer1/2`) are the **only**
per-embodiment weights — each is a `[32, in, out]` bank indexed by `cat_id`.
Everything else (vision, backbone, VL-fusion, the 32-layer DiT, timestep
encoder) is shared, and `max_state_dim == max_action_dim == 132` is fixed for
every embodiment. So a single GGUF can carry many embodiments by storing those
7 tensors as **rank-3** (`[out, in, n_stored]`, one row per stored `cat_id`)
and picking one row at load time. The hot path is unchanged: the selected row
is sliced and pre-transposed once during load.

### Converting

Multi-embodiment is the **default** (omit `--embodiment-tag`):

```
# every distinct trained cat_id in the checkpoint's embodiment_id.json
python convert_groot_dit_to_gguf.py \
    --checkpoint /path/to/checkpoints/GR00T-N1.7-3B \
    --out        /path/to/checkpoints/groot-action-head.gguf

# narrow the ship set to specific tags (stored once per distinct cat_id)
python convert_groot_dit_to_gguf.py \
    --checkpoint         /path/to/checkpoints/GR00T-N1.7-3B \
    --embodiments        libero_sim,oxe_droid_relative_eef_relative_joint \
    --default-embodiment libero_sim \
    --out                /path/to/checkpoints/groot-action-head.gguf
```

| Flag | Mode | Meaning |
|---|---|---|
| *(none)* | multi (default) | Store every distinct trained `cat_id` from `embodiment_id.json` (17 for the base checkpoint). |
| `--embodiments a,24,…` | multi | Store only these rows, named by tag and/or numeric `cat_id`. Taken literally: it must include the default embodiment, rather than being silently widened to fit it. |
| `--embodiments all` | multi | Store all 32 physical rows of the category bank, including untagged ones that `embodiment_id.json` does not name. |
| `--default-embodiment tag` | multi | Embodiment used when the runtime asks for none (default `libero_sim`). Its `num_cameras` must be known, else conversion fails — see below. |
| `--embodiment-cameras TAG=N` | multi | Stamp `num_cameras` for a row the checkpoint says nothing about, or pin one rig when tags sharing a `cat_id` disagree. Repeatable / comma-separated. Highest precedence. |
| `--embodiment-tag tag` | v1 single | Slice this one row to a 2-D dense tensor at conversion. Mutually exclusive with `--embodiments`. |

The base `GR00T-N1.7-3B` checkpoint has **17** distinct trained `cat_id`s; the
LIBERO checkpoint only post-trained the `libero_sim` row (see
[LIBERO checkpoint](#libero-checkpoint) — parity per embodiment needs a
checkpoint that actually trained it). Cost is ~20 MB F16 per stored row
(~300 MB for all 17).

### Metadata written

Multi mode emits a `groot.embodiment.*` table plus the v1 back-compat keys, so
the metadata and the multi table agree on the default. Those keys do NOT make a
multi GGUF loadable by a pre-multi loader: the `embodiment.*` tensors are rank-3,
and a loader without slicing code loads the file and then aborts on `GGML_ASSERT`
at the first `run()`. Multi files are a separate model family, not a drop-in
replacement for a v1 GGUF.

| Key | Meaning |
|---|---|
| `groot.embodiment.tags` | Full tag → `cat_id` map (all 52 tags), so the runtime can select by any tag string. |
| `groot.embodiment.cat_ids` | The `cat_id` for each tag above (parallel array). |
| `groot.embodiment.stored_cat_ids` | The `cat_id`s actually stored, in row order — row = index into this array. |
| `groot.embodiment.stored_num_cameras` | `num_cameras` per stored row; `0` = unknown, see below. |
| `groot.embodiment.count` | Number of stored rows. |
| `groot.embodiment.default` | Default embodiment tag. |
| `groot.embodiment_tag` / `groot.embodiment_cat_id` | v1 back-compat: the default entry. |
| `groot.num_cameras` | Top-level; the default entry's camera count. Legacy/v1 key — a multi loader reads the per-row table instead, so conversion fails rather than emit a multi GGUF whose default row has no count. |

### Where `num_cameras` comes from

It means IMAGES PER INFER, cameras × video history, which is what the runtime
consumes and `hparams.numCameras` reports. It is a property of the DATA CONFIG a
row was trained or served with, not of the weight row, and the checkpoint states
it per tag:

```
len(modality_configs[tag].video.modality_keys) × len(modality_configs[tag].video.delta_indices)
```

The converter derives counts from the checkpoint rather than a hardcoded list,
consulting in precedence order: `--embodiment-cameras`, then
`processor_config.json` (how the checkpoint is served now), then
`experiment_cfg/final_processor_config.json` (training-time data configs), then a
two-entry built-in fallback for checkpoints predating those keys. A lower source
is consulted only for `cat_id`s the higher ones say nothing about, so a
historical training mix cannot contradict the live config.

Because one `cat_id` can be shared by several tags and rigs, disagreement inside
the winning source stores `0` (unknown) rather than an arbitrary pick — e.g.
`cat_id 26` is 3 cameras × 2 frames for `real_r1_pro_sharpa_relative_eef` and
`_human`, but 1 × 2 for `_mecka` and `_maxinsights`. On the base checkpoint this
yields 9 of 17 rows self-describing; on the LIBERO checkpoint, 4 of 17. The rest
are runnable by stating the count at selection time.

### Selecting at load time

The addon open path takes an optional embodiment selector (`config.embodiment`
in the `VlaModel` config; the SDK forwards it once its `@qvac/vla-ggml` range
covers this version): a tag string, the numeric `cat_id`, or
`{ tag | catId, numCameras }`. At load the loader resolves tag → `cat_id` (via
`groot.embodiment.tags`) or takes the `cat_id` directly, maps it to a row (index
in `stored_cat_ids`), slices that row, and drives `num_cameras` from the stored
entry unless overridden (surfaced as `hparams.numCameras`, with
`hparams.selectedEmbodimentTag` / `selectedEmbodimentCatId`). `setEmbodiment()`
takes the same selector on a loaded model. Behaviour:

- Omitted selects `groot.embodiment.default` — a no-op for single-embodiment or
  non-GR00T GGUFs, so the field is always safe to pass.
- An unknown tag or `cat_id`, or one that is mapped but not in the GGUF's ship
  set, is rejected.
- A tag and a `cat_id` in the same request is rejected: they are two spellings of
  one selection, and a precedence rule would silently return the other one.
- An embodiment whose stored `num_cameras` is `0` (unknown at conversion) needs an
  explicit `numCameras` — with one it is fully runnable, without one it is
  rejected. The runtime never substitutes another embodiment's count, which would
  build the wrong image-token layout. An explicit count also overrides a stored
  one (logged as a warning) for a rig whose view count differs, since counts are
  stored per `cat_id` and aliased tags share them.
- A single-embodiment (v1) GGUF rejects a non-default tag or `cat_id`, but still
  accepts a `numCameras` override.

## LIBERO checkpoint

The shipped model of record is the **LIBERO** post-trained checkpoint
(`nvidia/GR00T-N1.7-LIBERO`, subfolder `libero_10`), not the base N1.7-3B —
LIBERO has a closed-loop simulator (for the demo), DROID doesn't. It's the
**same architecture**, so the pipeline and graph are unchanged; only three
things differ:

- **Embodiment**: `libero_sim` (`cat_id 2`; base/DROID used
  `oxe_droid_relative_eef_relative_joint` = 24). Multi mode already defaults to
  `libero_sim`, so no flag is needed; only the `libero_sim` row is post-trained
  in this checkpoint (the other stored rows are base pretrain — see
  [Multi-embodiment](#multi-embodiment)). Pass `--embodiment-tag libero_sim`
  for a legacy single-embodiment GGUF.
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
