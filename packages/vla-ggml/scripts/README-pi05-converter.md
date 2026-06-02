# π₀.₅ weight converter — quantisation scheme

This document is the **source of truth** for which π₀.₅ tensors get
quantised to what under each named profile, and why. The converter
itself is `convert_pi05_to_gguf.py`; the sweep driver that validates
profiles end-to-end is `sweep_quant_profiles.py`.

The default profile is **`q_aggressive`** (set in
`convert_pi05_to_gguf.py::main()`); this is the one that ships unless a
caller explicitly picks another with `--profile`.

## What the converter writes

GGUF tensor namespace from `plan.md §4` (recap — see the plan for the
authoritative shape table). For every input checkpoint the converter
emits the same 848 tensors regardless of profile; only the *dtype* of
each tensor changes. The profile name is stamped into the GGUF metadata
under `pi05.quant_profile` so downstream tools can read it back.

```
general.architecture     = "pi05"
pi05.quant_profile       = <one of the names below>

vision.patch_embed.{weight,bias}             # Conv2d 14×14, 3 → 1152
vision.pos_embed                              # (256, 1152)
vision.blk.{0..26}.{ln1,attn_{q,k,v,out},ln2,fc1,fc2}.{weight,bias}
vision.post_ln.{weight,bias}
vision.head.{weight,bias}                     # connector Linear(1152 → 2048)

vlm.embed_tokens                              # (257152, 2048)
vlm.blk.{0..17}.{pre_attn_norm.scale,attn.{q,k,v,o}.weight,
                  pre_ffw_norm.scale,mlp.{gate,up,down}.weight}
vlm.final_norm.scale

expert.blk.{0..17}.{pre_attn_norm.scale,pre_attn_norm.ada.{weight,bias},
                     attn.{q,k,v,o}.weight,
                     pre_ffw_norm.scale,pre_ffw_norm.ada.{weight,bias},
                     mlp.{gate,up,down}.weight}
expert.final_norm.{scale,ada.{weight,bias}}

proj.{action_in,action_out,time_mlp_in,time_mlp_out}.{weight,bias}
```

## Universal guardrails (apply to **every** profile)

These tensors **cannot be quantised below F16/F32 without breaking the
cos > 0.999 end-to-end bar**. The guardrail logic in
`_guardrail_dtype()` enforces this before any profile rule runs:

| Pattern | Forced dtype | Reason |
|---|---|---|
| `*.scale` (all RMSNorm scales) | F32 | Broadcast per-row inside fused kernels; precision loss is amplified across 18 layers. |
| `*.ada.*` (adaRMSNorm modulator) | F32 | Projects time-embedding into (scale, shift, gate); sits on the residual path. |
| `expert.*.weight` (linears) | F16 | 300M action expert; precision-sensitive; **the q8b_q8_expert diagnostic showed this can be relaxed to Q8_0 safely** — see `PROFILES_BYPASS_EXPERT_GUARDRAIL`. |
| `proj.*.weight` (action/time MLPs) | F16 | Tiny; residual path. |
| `vision.patch_embed.weight` | F16 | 4-D conv, not block-quantizable. |
| `vision.pos_embed` | F16 | Small lookup table. |
| `*.bias` | F16 | Not on a precision-critical path; F32 not worth the cost. |

Only `gguf-py`'s **Python-native legacy quants** are supported:
`Q4_0`, `Q4_1`, `Q5_0`, `Q5_1`, `Q8_0`, plus `F16`/`F32`. K-quants
(`Q*_K`) raise `NotImplementedError` in `gguf-py` and `llama-quantize`
bails with `unknown model architecture: 'pi05'`, so K-quants are a
**future-PR** item — see `## K-quant follow-up` below.

## Profiles

| Name | Vision | VLM attn | VLM MLP | Embedder | Expert linears | Use when |
|---|---|---|---|---|---|---|
| `f16` | F16 | F16 | F16 | F16 | F16 | numerical ceiling / regression baseline |
| `current` | mixed Q8_0/F16 | F16 | F16 | F16 | F16 | reproduces the original `pi05_base.gguf` bit-for-bit (modulo the new `pi05.quant_profile` metadata key) |
| `q8_broad` | full Q8_0-eligible | Q8_0 | Q8_0 | Q8_0 | F16 | strict Pareto-better than `current` (same cos, −35 % size) |
| **`q_aggressive`** ⬅ default | **Q5_0** | Q8_0 | Q8_0 | Q8_0 | **Q8_0** | **default** — −41 % vs `current`, both bars clear |
| `q5_mlp` | full Q8_0 | Q8_0 | **Q5_0** | Q8_0 | F16 | rejected (cos 0.9952 < 0.999) — kept for the record |
| `q4_mlp_emb` | full Q8_0 | Q8_0 | **Q4_0** | **Q4_0** | F16 | rejected (cos 0.944) — kept for the record |

Diagnostic profiles (one knob off `q8_broad` each — used to localise
which component breaks cos-sim; not for shipping):

`q8b_q5_embed`, `q8b_q4_embed`, `q8b_q5_vision`, `q8b_q8_expert`,
`q8b_q5_vlm_attn`, `q8b_q5_mlp_mid`. Their job is done; they exist so
the diagnostic sweep is reproducible.

## End-to-end cos-sim results (2026-05-21 sweep)

Driver: `sweep_quant_profiles.py` → `bare test/integration/pi05.test.js`
with the parity-oracle dump from `s3://tether-ai-dev/qvac_models_compiled/vla/pi05-base/2026-05-21/`.
Plan §5 bars: **cos > 0.999** AND **rel_max < 0.05**.

| Profile | Size | cos | rel_max | Bar | Notes |
|---|---|---|---|---|---|
| `f16` | 6.5 GB | 1.000000 | 0.0010 | ✅ | ceiling |
| `current` | 6.3 GB | 0.999905 | 0.0419 | ✅ | reference |
| `q8_broad` | 4.1 GB | 0.999894 | 0.0313 | ✅ | strict win over `current` |
| **`q_aggressive`** | **3.7 GB** | **0.999647** | **0.0375** | ✅ | **default** |
| `q5_mlp` | 3.4 GB | 0.995206 | 0.2096 | ❌ | VLM MLP can't go below Q8_0 with legacy quants |
| `q4_mlp_emb` | 3.0 GB | 0.943775 | 0.6090 | ❌ | aggressive failure |

Diagnostic detail (one knob off `q8_broad`; baseline is cos=0.999894):

| Knob | Δ size | cos | Verdict | Stacked into `q_aggressive`? |
|---|---:|---|---|---|
| Expert linears → Q8_0 | −291 MB | 0.999892 | ✅ free lunch | **yes** |
| Vision → Q5_0 | −104 MB | 0.999680 | ✅ | **yes** |
| MLP layers 6–11 → Q5_0 | −226 MB | 0.999273 | ❌ rel_max 0.083 | no — fails rel bar |
| Embedder → Q5_0 | −197 MB | 0.997262 | ❌ cos | no — surprisingly precision-sensitive |
| VLM attn → Q5_0 | −63 MB | 0.994101 | ❌ cos | no |
| Embedder → Q4_0 | −263 MB | 0.943979 | ❌ catastrophic | no |

**Surprising findings to remember:**

1. **The F16-expert guardrail was overly conservative.** Despite the
   adaRMSNorm gates and residual-path sensitivity, the expert linears
   tolerate Q8_0 essentially perfectly (cos delta ≈ 2×10⁻⁶). This is
   the single biggest size win, and it's why `q_aggressive` adds an
   expert-bypass via `PROFILES_BYPASS_EXPERT_GUARDRAIL`.
2. **The token embedder is precision-sensitive.** Even though it's a
   lookup table that gets re-normalised by `√W` and processed through
   18 transformer layers, Q5_0 already drops cos to 0.9973. Keep at
   Q8_0 minimum.
3. **VLM attn linears are sensitive too.** Q5_0 drops cos to 0.9941
   despite being a small section (~170 MB). Q8_0 is the floor.
4. **VLM MLP edges, not middles, are the constraint.** Quantising only
   the middle 6 layers (6–11) gets cos to 0.9993 — close. The edges
   (layers 0–5 and 12–17, plus all attn) are what cluster at higher
   sensitivity. K-quants' per-block scales should handle this better
   than uniform-precision Q5_0 — see K-quant follow-up.

## How to add a new profile

1. Add a function `_profile_<name>(name: str, arr: np.ndarray) -> GGMLQuantizationType`
   in `convert_pi05_to_gguf.py`. It receives the **GGUF** tensor name
   (not the PyTorch name) and the float32 numpy array; it returns the
   target dtype. Only return dtypes in `PYTHON_NATIVE_QUANTS`.
2. Register it in the `PROFILES` dict.
3. If the profile needs to bypass the F16-expert guardrail, also add
   it to `PROFILES_BYPASS_EXPERT_GUARDRAIL` and use `_is_expert_linear()`
   to scope the bypass.
4. Add the name to `ALL_PROFILES` in `sweep_quant_profiles.py`.
5. Self-test: `python3 scripts/convert_pi05_to_gguf.py --self-test
   --out /tmp/x.gguf --profile <name> --verify-vs-pt`. Self-test only
   validates structure (names + shapes + dtypes); the numeric
   validation is the sweep.
6. End-to-end validate via the sweep with `--profiles <name>`.

## K-quant follow-up (out of scope for this PR)

`Q4_K_M` / `Q5_K_M` / `Q6_K` would likely close the gap on the VLM
MLP and possibly the embedder, since their per-block (super-block)
scales handle within-tensor outliers better than legacy quants. Two
blockers prevent us shipping K-quants today:

1. `gguf-py.quants.quantize()` returns `NotImplementedError` for
   `Q*_K`. The packers live only in llama.cpp's C code.
2. `llama-quantize` (which has the C packers) refuses to load a GGUF
   with `general.architecture = "pi05"`: `unknown model architecture:
   'pi05'`. Workarounds:
   - Add a minimal pi05 architecture stub to `llama-quantize` (or to
     qvac-fabric's fork), OR
   - Add a `--skip-arch-validation` / `--pure-tensor-mode` flag to
     `llama-quantize`.

When unblocked, the diagnostic profiles tell us exactly where to
target K-quants: VLM MLP gate/up/down (where Q5_0 broke
non-catastrophically — Q5_K_M with per-block scales should clear the
bar), and possibly the embedder (Q4_K_M, since its sensitivity
pattern looks per-row rather than uniform).
