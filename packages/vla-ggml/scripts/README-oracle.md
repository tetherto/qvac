# π₀.₅ PyTorch Parity Oracle (Phase 0)

This directory holds the Phase-0 deliverable from `plan.md §0`: a deterministic
PyTorch reference harness that the C++ ggml port of π₀.₅ tests against.

The script runs LeRobot's `Pi05Policy` in eager float32 on a fixed synthetic
fixture, then dumps every breakpoint named in `plan.md §5` to a single
`activations.safetensors`. The C++ unit tests (M3.1–M3.13) load this file and
compare their sub-graph outputs to PyTorch's at the same tensor names — that's
the parity contract.

## Files

| File | What it is | Tracked? |
|---|---|---|
| `dump_pi05_activations.py` | The oracle dump generator. | yes |
| `requirements-pi05-oracle.txt` | Pinned Python deps used when the canonical dump was produced. | yes |
| `README-oracle.md` (this file) | How to (re)run the oracle. | yes |
| `oracle_fixtures.json` | SHA-256 of the fixture + activations + the LeRobot/torch/transformers versions. | yes |
| `fetch_test_fixtures.sh` | Downloads the pinned `*.safetensors` so they don't have to live in git. | yes |
| `oracle_dump/fixture.safetensors` | Generated input bundle (3 images + state + tokens + noise + time grid). | **no** (gitignored) |
| `oracle_dump/activations.safetensors` | Generated breakpoint dump (~hundreds of named tensors). | **no** (gitignored) |

## How to (re)generate the dump

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r packages/vla-ggml/scripts/requirements-pi05-oracle.txt

python packages/vla-ggml/scripts/dump_pi05_activations.py \
  --checkpoint lerobot/pi05_base \
  --out-dir   packages/vla-ggml/scripts/oracle_dump/ \
  --seed      0
```

Runs end-to-end on CPU in float32. On a 32-core box this takes a few minutes
and ~12 GB of RAM (PaliGemma 2B + SigLIP-So400m at float32). The driver writes:

- `oracle_dump/fixture.safetensors`
- `oracle_dump/activations.safetensors`
- `oracle_fixtures.json` (next to the script)

It also runs a **contract check**: every breakpoint named in `plan.md §5`
must end up in the dump. Failure here exits non-zero — the missing-key list
points straight at a hook that silently stopped firing.

## Determinism contract

The dump is deterministic for a fixed:
- `--seed` (default 0),
- `--checkpoint` (default `lerobot/pi05_base`),
- pinned LeRobot + torch + transformers versions (see `requirements-pi05-oracle.txt`).

If any of those drift, the C++ comparisons against the old `activations.safetensors`
become meaningless. `oracle_fixtures.json` records the exact revision so we
can detect drift in CI.

## What gets dumped

See `_required_activation_keys()` in the script for the authoritative list.
The shape contract per `plan.md §5`:

```
fixture.images           (3, 3, 224, 224)
fixture.state            (32,)
fixture.tokens           (200,)            int32
fixture.mask             (200,)            bool
fixture.noise            (50, 32)
fixture.time_grid        (10,)             1.0, 0.9, …, 0.1

vision.patch_embed_out[cam_i]   (256, 1152)
vision.pos_embed_out[cam_i]     (256, 1152)
vision.blk_{0,13,26}.out[cam_i] (256, 1152)
vision.post_ln_out[cam_i]       (256, 1152)
vision.head_out[cam_i]          (256, 2048)  -- projector output; HF /sqrt(W)
                                                cancels LeRobot *sqrt(W), so
                                                this equals what flows downstream
vision.concat                   (768, 2048)

vlm.embed_out                   (200, 2048)  -- after *sqrt(W) on lang tokens
vlm.prefix_concat               (968, 2048)
vlm.blk_{0,8,17}.attn_out       (968, 2048)  -- o_proj output, pre-residual
vlm.blk_{0,8,17}.ffn_out        (968, 2048)  -- full block output, post-residual
vlm.blk_17.kv_keys              (968, 1, 256)
vlm.blk_17.kv_vals              (968, 1, 256)
vlm.final_out                   (968, 2048)
vlm.kv_cache_full.{keys,values} (18, 968, 1, 256)

expert.cond[t={1.0,0.5,0.1}]    (1024,)
expert.blk_0.adarms_{scale,shift,gate}[t=1.0]   (1024,)
expert.blk_0.attn_out[t=1.0]    (50, 1024)
expert.blk_{0,8,17}.out[t=1.0]  (50, 1024)
expert.final_out[t=1.0]         (50, 1024)
expert.v_t[t=1.0]               (50, 32)

ode.step_{0,3,7,9}.x_next       (50, 32)
ode.actions_final               (50, 32)
```

## Failure protocol

If a C++ unit test fails against this dump:

1. Don't move on. Per `plan.md §5`: the failure is almost always (a) a tensor-
   name mismatch in the converter, (b) wrong RoPE/RMSNorm formula, or (c) wrong
   mask construction.
2. Bisect by loading the single failing tensor from `activations.safetensors`
   and diffing against the C++ output at the same breakpoint.
3. If the dump itself looks wrong, regenerate it (above) and check
   `oracle_fixtures.json` for the revision that was used.

## Why a synthetic fixture instead of a real LIBERO frame?

For tensor-level parity, all the C++ port needs is *some* fixed input bundle
that exercises every code path. Synthetic uniform-noise images and seed-derived
tokens cover that, and they keep the fixture small (no LIBERO dataset
dependency, no PaliGemma SentencePiece access). The **closed-loop** validation
(Phase 5) is what runs against a real LIBERO episode.
