# GR00T multi-embodiment support — design

Status: implemented in PR #3427, on top of #3206 (addon) and #3362 (SDK).

## Problem

The v1 converter bakes a single embodiment into the GGUF at conversion time
(`--embodiment-tag libero_sim`, cat_id 2). It slices one row out of each
`CategorySpecificLinear` weight and stores it as a plain dense tensor, so the
layer degrades to a plain Linear and there is no runtime embodiment selector.
Base/DROID uses `oxe_droid_relative_eef_relative_joint` (cat_id 24). Goal: one
GGUF that carries every embodiment, with the embodiment chosen at load time.

## What is actually per-embodiment

Only the seven `CategorySpecificLinear` layers in the action head differ by
embodiment:

- `state_encoder.layer1`, `state_encoder.layer2`
- `action_encoder.w1`, `action_encoder.w2`, `action_encoder.w3`
- `action_decoder.layer1`, `action_decoder.layer2`

Each stores `W[num_categories=32, in, out]` and `b[32, out]`; the forward is
`bmm(x, W[cat_id]) + b[cat_id]`. Everything else — vision tower, backbone,
VL fusion, the 32-layer DiT, the timestep encoder — is shared across all
embodiments.

Key invariant: `max_state_dim == max_action_dim == 132`, fixed and shared for
every embodiment (each robot's real dims are padded to 132 by the consumer).
`max_num_embodiments == 32`. So the seven tensors have identical shapes for
every cat_id — only the values differ. Multi-embodiment is therefore "store all
rows, select one at load", with no shape or dim change anywhere else.

Per-embodiment things that are NOT in those seven tensors:

- `num_cameras` (input contract): LIBERO 2, DROID 4. A data-config property, not
  a checkpoint tensor, so the converter can only stamp counts it knows (or is
  told via `--embodiment-cameras`); otherwise the caller states it at selection
  time. Carried in metadata.
- Normalization stats (state in / action out): stay consumer-side (see below).

## Decisions

1. Checkpoint / embodiments: base N1.7-3B. SHIP one weight row per distinct
   trained cat_id (17 of them; the raw tensor's other 15 of 32 slots are unused
   and dropped). `--embodiments a,b` narrows the ship set (e.g. libero+droid).
   Per-embodiment size is NOT negligible: ~20 MB F16 each (`action_encoder.w2`
   alone is 3072x1536). 2 rows = +20 MB, 17 = +~300 MB, full 32 = +~630 MB over
   v1. Shipping is decoupled from testing (parity tests all 17 by slicing the
   full checkpoint in CI, independent of the ship set).
2. Selector: per model instance, chosen at model open (sliced + pre-transposed
   once at load) and switchable in place afterwards via
   `setEmbodiment(tag | catId)` —
   the hot path is unchanged either way. A switch re-reads only the wanted row of
   the 14 embodiment tensors from the GGUF (~20 MB) into the slice buffer already
   allocated at load and rebuilds their pre-transposed copies; the shared ~3.7 GB
   (vision tower, backbone, VL fusion, DiT) is never touched, so one load serves
   any shipped embodiment without a reopen. Per-infer-call cat_id (a different
   embodiment per call, no switch) remains out of scope: it would mean keeping
   every row resident.
3. Identity: an embodiment is named by tag OR by its numeric `cat_id` — the same
   id the checkpoint uses and `stored_cat_ids` records. Both spellings go through
   one resolver; passing both at once is an error rather than a precedence rule.
   `hparams` reports both (`selectedEmbodimentTag`, `selectedEmbodimentCatId`), so
   a selection can be round-tripped either way.
4. Camera count: every stored row must be servable. Since `num_cameras` is a
   data-config property the checkpoint doesn't carry, selection takes an optional
   `numCameras`, which is required for a row the GGUF has no count for and wins
   (with a logged warning) over a stored count for a rig that differs. The runtime
   still never guesses: with no stored count and no override, the selection is
   rejected rather than inheriting another embodiment's view count, which would
   build the wrong image-token layout and infer silently wrong.
5. Normalization stats: keep consumer-side (status quo). The addon stays
   normalization-free; the checkpoint mixes mean/std, percentiles, and meanstd
   variants, so moving them in adds a messy new parity surface for no demo need.

## GGUF changes

Store the seven MLP tensors keeping the category dim, but only the ship-set rows:
`[n_stored, in, out]` (W) / `[n_stored, out]` (b), row order = `stored_cat_ids`.
Metadata:

All three integer arrays below are `int32[]`, which is what `gguf-py`'s
`add_array` emits for Python ints. The loader requires exactly that element type
and reports any other as a corrupt table rather than as an absent one, so a
producer that writes them as `u32[]` builds a GGUF this runtime refuses to load.

- `groot.embodiment.tags` (str[]) + `groot.embodiment.cat_ids` (int32[]) — the
  FULL tag -> cat_id map (all 52 tags), so the runtime can select by any tag.
- `groot.embodiment.stored_cat_ids` (int32[]) — which cat_ids are physically
  stored, in tensor row order. Runtime maps selected tag -> cat_id -> row index
  in this array. Works for any ship set (2, 17, or 32) — never assumes
  row == cat_id.
- `groot.embodiment.stored_num_cameras` (int32[]) — per stored row; 0 = unknown,
  in which case selecting that row requires an explicit `numCameras` from the
  caller (the converter's `--embodiment-cameras TAG=N` can stamp counts instead).
- `groot.embodiment.count` (u32) = n_stored; `groot.embodiment.default` (str).

Keep `groot.embodiment_tag` / `groot.embodiment_cat_id` + top-level
`groot.num_cameras` = the default entry, for back-compat with v1 GGUFs and the
single-slice converter mode.

These tensors stay unquantized F16 (grootLinearXW's transpose-cont cannot run on
a quantized transposed tensor — blocks span the reduction axis), so each stored
row costs ~20 MB in the shipped model.

## Converter (`convert_groot_dit_to_gguf.py`)

- `--embodiment-tag` becomes optional. Omitting it selects multi-embodiment mode
  (the new default): copy every shipped row's W/b for the seven layers and write
  the metadata table. `--embodiments a,b` narrows the ship set;
  `--default-embodiment <tag>` sets the GGUF default.
- Single-slice mode retained: `--embodiment-tag <tag>` still produces the v1
  GGUF (sliced dense tensor + `groot.embodiment_tag/_cat_id`).
- Resolve tags -> cat_ids via `embodiment_id.json`, dedup (many tags share a
  cat_id, e.g. all `oxe_droid_*` = 24). Store the full tag map plus a
  representative tag per cat_id.
- `--embodiment-cameras TAG=N` (repeatable / comma-separated) stamps
  `num_cameras` for embodiments this script has no canonical count for. Counts
  collapse per cat_id, so aliased tags disagreeing is a conversion error. The
  converter also prints which stored rows ship without a count, since those need
  a caller-supplied `numCameras` to be selected.

## Confirmed GGUF layout (converter step done)

Verified against real conversions of base N1.7-3B: default ships 17 rows
(`stored_cat_ids = [0,1,2,3,13,17,18,19,20,22,23,24,25,26,27,28,29]`,
`count = 17`); `--embodiments libero_sim,oxe_droid_relative_eef_relative_joint`
ships 2 (`stored_cat_ids = [2, 24]`, cams `[2, 4]`). The tag map carries all 52
tags so the runtime selects by any tag string.

The seven `embodiment.*` weight tensors are rank-3 with ggml
`ne = [out, in, n_stored]` (numpy `[n_stored, in, out]` reversed by gguf-py). The
row (category) dim is the OUTERMOST ggml axis (`ne[2]`), so each row's
`[out, in]` block is contiguous. Runtime slicing recipe:

1. tag -> cat_id via the `tags`/`cat_ids` map (default tag if none selected).
2. cat_id -> `row` = index of cat_id in `stored_cat_ids` (error if absent).
3. `ggml_view_2d` (or a byte-copy) at `offset = row * out * in * element_size`.

Biases are rank-2 `ne = [out, n_stored]`; same `row` offset. v1 single-slice
GGUFs stay rank-2 (weight) / rank-1 (bias); switch on `ggml_n_dims == 3`.

## Runtime (`groot.cpp`)

- Load: read the embodiment table. Pick the selected embodiment from a load
  param (default = `groot.embodiment.default`). Slice that cat_id's seven rows,
  pre-transpose once (existing `weightsPreTransposed` path). Rest of load
  unchanged.
- Drive `numCameras` from the selected entry (`maxStateDim` = 132 shared).
- Fixed-shape infer contract and validators unchanged.
- Switch (`GrootModel::setEmbodiment(request)`): resolve through the same resolver
  as load, re-read that row of the 14 embodiment tensors from the GGUF into the
  existing slice buffer, refill the pre-transposed copies, update `num_cameras` /
  `selected_embodiment_tag` / `selected_embodiment_cat_id`. Rejects an unknown
  tag/id, an unshipped cat_id, or an embodiment with no known camera count and no
  override, leaving the active embodiment untouched. Serialized against `infer()`
  by a mutex (the switch runs on the JS thread, `infer` on the framework's worker
  thread).
- Failure atomicity of a switch rests on doing every fallible thing before the
  first write: the transpose scratch is allocated up front (sized to the largest
  of the seven weights), then the row read fills one host buffer from all 14
  blocks before committing any, and the writes that follow are memcpy +
  `ggml_backend_tensor_set` only. So an allocation or I/O failure throws with the
  previous embodiment whole, matching the `selected_*` metadata that is updated
  last.
- The unselected rows are read from the file on demand rather than kept resident,
  so a switch costs ~20 MB of I/O and no steady-state memory: the GPU path's host
  staging is still released at load.
- All-rows-resident + per-call cat_id indexing is deferred.

## SDK / index.js

- Expose an embodiment selector in the model open/config path; validate against
  the GGUF's embodiment list; fail closed on an unknown tag or id.
- The selector is `string | number | { tag?, catId?, numCameras? }` in both
  `config.embodiment` and `setEmbodiment()`; index.js normalizes it once and the
  addon config map carries the two numbers as decimal strings ('' = unset), like
  every other entry in that map. `catId` is bounded to 0..31 on both sides of the
  binding: the id space is the architecture's 32-row category bank, and a JS
  number narrowed to int32 would turn 2^32 into a silent selection of row 0.
- SDK-side exposure (`modelConfig.embodiment` in the zod schema, the ggml-vla
  plugin forwarding it, the regenerated contract and Python bindings) ships with
  the follow-up that moves the SDK's `@qvac/vla-ggml` range to the version
  carrying this addon. Landing it earlier would advertise a field the pinned
  0.14.x addon ignores.
- Surface the selected embodiment's `num_cameras` to the existing index.js
  validators (they already read `hparams.numCameras`), plus
  `selectedEmbodimentCatId` for id round-tripping.
- `model.setEmbodiment(selector)` switches a loaded model and resolves to the
  refreshed hparams. The exclusive run queue is necessary but NOT sufficient:
  `run()` releases it once the job is dispatched, while the worker reaches
  `infer()` later, so a switch is additionally refused while a response is
  un-awaited. Otherwise inference would run on the new weights against input
  validated against the old `numCameras`, which the native mutex serializes but
  cannot reorder. Callers must follow the new `numCameras` on subsequent `run()`
  calls.

## Parity strategy

Embodiment only changes the seven action-head MLPs, so parity-per-embodiment
does not need real robot data or per-robot cameras.

- Action-head parity across all distinct cat_ids: feed the action head
  synthetic-but-fixed `backbone_features` + `state` + `noise`, iterate cat_id
  through both the PyTorch oracle and C++ with that embodiment selected, gate
  cos > 0.9995. One dump loop over cat_ids. `num_cameras` is irrelevant here (it
  only affects the shared vision tower, not re-run per embodiment).
- Full end-to-end parity: keep the existing LIBERO (cat 2) + DROID (cat 24)
  gates with real fixtures. Vision is embodiment-agnostic, so no per-embodiment
  end-to-end run is needed.
- End-to-end parity of a SELECTED non-default embodiment needs a GGUF whose
  shared weights match the oracle. The shipped multi GGUF comes from the LIBERO
  post-trained checkpoint, so the base-checkpoint DROID oracle cannot gate it
  (measured cos 0.881 — the shared-weight delta, not the embodiment path), and no
  DROID oracle exists for the LIBERO checkpoint (its metadata has no DROID data
  config). `scripts/make_multi_embodiment_fixture.py` builds the matching side by
  rewriting the base-derived v1 DROID GGUF into a 2-row multi GGUF
  (`stored_cat_ids [2, 24]`, default `libero_sim`). Measured with the existing
  `GrootInferParity` test and `GROOT_TEST_EMBODIMENT`: DROID by tag cos
  **0.999993** / rel 0.0054, by cat_id 24 identical, and the LIBERO default row on
  the same file cos **0.794** — so the parity is attributable to the selection.
  The fixture is local (a second ~3.8 GB model in CI is not worth it); CI keeps
  the 17-row sweep, LIBERO end-to-end, and switch equivalence.
- Chained (Euler) checks gate on cos only; per-embodiment max-abs-rel is
  run-to-run unstable on threaded x86 CI.
- In-place switching is validated by equivalence, not by a second oracle: a model
  loaded on the default embodiment and switched to row B must produce the same
  actions as a model loaded directly on row B, with a wrong-row negative control
  and a switch-back-restores check
  (`GrootEmbodimentSweep.SwitchEmbodimentMatchesFreshLoadOfThatEmbodiment`).

Extend `dump_groot_activations.py` to iterate cat_id with synthetic action-head
inputs.

## Out of scope

- Per-infer-call embodiment selection (a different embodiment per `infer()` with
  no switch call, which would require every row resident). Switching between
  calls on a loaded model IS supported — see `setEmbodiment` above.
- Normalization stats in the GGUF.
- New HF checkpoint revisions (architecture is identical; converter is
  architecture-driven).
