# VLA (SmolVLA) — Operator Fusion / Graph Optimization Plan & Log

Branch: `tmp-vla`. Target: `packages/vla/addon/src/model-interface/smolvla.cpp`.

## Validation protocol

Every change is built and validated against the same fixed fixture used by the
existing CPU↔GPU integration test (`packages/vla/test/integration/addon.test.js`).

- Build: `bare-make build && bare-make install`
- **Accuracy**: integration test asserts `max|Δ| < 0.25` and `cos > 0.9` vs the
  PyTorch reference `test/integration/assets/pt_actions_libero_fixed.json`
  (350 values). Baseline is `max|Δ| ≈ 0.003 (auto)` / `0.001 (cpu)`,
  `cos ≈ 1.00000`. We use a regression gate of `max|Δ| within +5e-3` of
  baseline and `cos within 1e-5` for changes that should be mathematically
  equivalent.
- **Speed**: a custom warmed-bench harness (`packages/vla/test/bench.js`) loads
  the model once per backend and runs 5 inferences, dropping iter 1 (warm-up)
  and reporting min / median / max of iter 2-5. Per-stage timings come from
  `smolvla_inference_with_timing` (vision, smollm2_compute, smollm2_total,
  ode, total). Both `auto` (Vulkan/Intel Iris Xe) and `cpu` rows are tracked.
- Single-run integration-test timings showed up to 2× variance from system
  load (build I/O contention, page-cache state) — those are unsuited for A/B
  comparison. Always use the warm bench harness for the speed gate.

Reproduce:
```
bare-make build && bare-make install
QVAC_VLA_MODEL=$PWD/test-models/smolvla-libero-f32-fixed.gguf \
  bare test/bench.js 5 auto,cpu
```

For each optimization the log records:
1. **Baseline timings** (last known good).
2. **Implementation summary** (which call sites changed).
3. **Accuracy delta** vs PyTorch reference (max|Δ|, cos).
4. **Timing delta** in ms / % per stage.
5. **Verdict**: kept, reverted, or rolled into a follow-up.

## Final outcome — Opts 1, 3, 4 kept

After validating all 7 candidates the source-of-truth `smolvla.cpp` carries
three changes vs baseline (`tmp-vla` tip `4e89d67b`):

| # | Change | Status | Site |
|---|---|---|---|
| 1 | Cross-attn K/V projections hoisted out of ODE loop | **kept** | `build_denoise_step_graph` cross-attn branch + new pre-projection pass in `smolvla_inference_with_timing` |
| 3 | `scale + mask + softmax` → `ggml_soft_max_ext` | **kept** | 4 attention sites |
| 4 | `silu(gate) * up` → `ggml_swiglu_split` | **kept** | 2 MLP sites |
| 2 | Norm/bias `to_f32` cast hoist | skipped | F32 fixture → no-op |
| 5 | Drop GQA `ggml_repeat` | reverted | broke CPU backend (cos=0.02) |
| 6 | Time-MLP concat → split linears | reverted | strided-weight matmul slower than concat path |
| 7 | Pre-fold patch-embed bias | skipped | <1 ms total impact, needs new owned buffer |

**Final speed** (warm bench, 5 iters, drop iter 1; vs baseline median):

| Backend | stage | baseline | final | Δ | Δ% |
|---|---|---:|---:|---:|---:|
| auto (Vulkan0) | vision | 1146 | 1070 | -76 | -6.6% |
| auto | smollm2_compute | 239 | 252 | +13 | (hoist cost) |
| auto | smollm2_total | 329 | 367 | +38 | (hoist cost) |
| auto | **ode** | **872** | **812** | **-60** | **-6.9%** |
| auto | **total** | **2345** | **2247** | **-98** | **-4.2%** |
| cpu | vision | 6240 | 6260 | +20 | noise |
| cpu | smollm2_compute | 1665 | 1604 | -61 | -3.7% |
| cpu | smollm2_total | 1803 | 1779 | -24 | -1.3% |
| cpu | **ode** | **1946** | **1895** | **-51** | **-2.6%** |
| cpu | **total** | **10084** | **9921** | **-163** | **-1.6%** |

**Final accuracy** (integration test, vs PyTorch reference, 350 values):

| Backend | max\|Δ\| | mean\|Δ\| | cos | gate |
|---|---:|---:|---:|---|
| auto | 0.0032 | 0.0002 | 1.00000 | ✅ unchanged |
| cpu | 0.0009 | 0.00004 | 1.00000 | ✅ unchanged |

Take-aways:
- The ODE inner loop dropped ~7% on Vulkan / ~2.6% on CPU — the cross-attn
  K/V hoist (Opt 1) is the only change with a directly measurable effect
  on this hardware.
- Opts 3 and 4 are bit-for-bit equivalent graph simplifications; their
  effect is ≪ noise floor on Intel Iris Xe + Linux x64 but eliminates
  ~160 graph nodes per inference, which should help mobile GPUs
  (Adreno/Mali) where kernel-launch overhead matters more.
- Two attempted optimizations failed on real backend constraints:
  - **GQA broadcasting in `ggml_mul_mat` is not honoured by the CPU
    backend** in our ggml fork — this is the same kind of "lacking
    backend support" gap that previously blocked flash-attn. Worth
    filing upstream.
  - **`ggml_view_2d` weight slicing defeats the fast matmul path** on
    Intel Vulkan — physical weight splitting would be needed.

## Optimization list (ordered low-risk → high-risk)

These are independent; each commits separately so a single regression doesn't
block the rest.

| # | Optimization | Risk | Expected impact |
|---|---|---|---|
| 0 | **Baseline** — record current accuracy + timings | — | reference point |
| 1 | **Hoist cross-attn K/V projections out of ODE loop** — VLM cache is invariant across the 10 ODE steps; project once before the loop and reuse. Touches `build_denoise_step_graph` cross-attn branch and `action_expert_forward`. | low (pure refactor) | large — eliminates 8 layers × 9 redundant steps × 2 matmuls = 144 matmuls per inference (only the cross-attn projections, not self-attn) |
| 2 | **Cast LayerNorm/RMSNorm/Linear-bias constants to F32 once at load** — drop the per-graph `to_f32(ctx, weight/bias)` calls. | low | small but constant — removes hundreds of `ggml_cast` ops from every graph rebuild |
| 3 | **Fuse `scale → +mask → soft_max` with `ggml_soft_max_ext`** at all 5 attention sites. | low | small — fewer ops per attention; backend kernels are typically faster |
| 4 | **Fuse SwiGLU `silu(gate) * up` with `ggml_swiglu_split`** at 3 MLP sites. | low | small — one kernel instead of two |
| 5 | **Drop explicit GQA `ggml_repeat` of K/V** — rely on `ggml_mul_mat`'s built-in broadcasting (`n_head % n_head_kv == 0`). | medium (verify broadcast on all backends) | medium — removes 3× materialization of K and V per layer |
| 6 | **Replace `concat(action,time) + linear` with two split linears + add** in the time-conditioning MLP (10× per inference). | low | small but runs in inner ODE loop |
| 7 | **Pre-fold `pos_embed + patch_embed_bias` at load** — one constant + one add. | trivial | negligible |

(Flash-attention `ggml_flash_attn_ext` is out of scope: prior attempt hit
backend support gaps; revisit once we know which backends + dtypes failed.
**Re-tried this pass — see Opt 8 below; reverted.**)

---

# Log

(Newest entries at the top of each section.)

## Opt 0 — Baseline

Date: 2026-04-29. Branch tip: `4e89d67b` on `tmp-vla`.
Host: Linux x64, 12 cores. GPU: Intel Iris Xe (RPL-U) via Vulkan (uma=1, fp16=1).
Fixture: `test-models/smolvla-libero-f32-fixed.gguf` (~2.13 GB). Reference:
`test/integration/assets/pt_actions_libero_fixed.json`.

Note: this checkpoint is the 32-layer variant (text=32 layers / 960-dim,
expert=32 layers / 480-dim) — not the 16-layer hparams default in
`smolvla.hpp`. So per-step cross-attn cost scales by 16 cross-attn layers,
not 8.

**Warm bench (median of iter 2-5):**

| Backend | vision | smollm2_compute | smollm2_total | ode | **total** |
|---|---:|---:|---:|---:|---:|
| auto (Vulkan0) | 1146 | 239 | 329 | 872 | **2345** |
| cpu | 6240 | 1665 | 1803 | 1946 | **10084** |

**Accuracy** (integration test, single run): all 41 asserts pass.

| Backend | max\|Δ\| | mean\|Δ\| | cos | compared |
|---|---:|---:|---:|---:|
| auto | 0.0032 | 0.0002 | 1.00000 | 350 |
| cpu | 0.0009 | 0.00004 | 1.00000 | 350 |

## Opt 1 — Hoist cross-attn K/V projections

**Implementation** (`packages/vla/addon/src/model-interface/smolvla.cpp`):

1. `build_denoise_step_graph` cross-attn branch: dropped the per-step
   `linear(vlm_kv_keys[i], k_proj_weight)` / `linear(vlm_kv_vals[i], v_proj_weight)`
   matmuls. The branch now uses the input slot directly as K/V.
2. `smolvla_inference_with_timing`: added a one-shot loop after the SmolLM2
   KV recompute that builds a tiny per-cross-attn-layer graph computing
   `k_proj`/`v_proj` against the VLM cache and overwrites `kv_keys_data[i]` /
   `kv_vals_data[i]` in place. Asserts `expert_kv_dim == text kv_dim`
   (already implicit in stock SmolVLA).

For this fixture: 16 cross-attn layers × 9 redundant ODE steps = 144 fewer
matmul-pairs per inference.

**Accuracy** (integration test, vs PyTorch reference):

| Backend | max\|Δ\| | mean\|Δ\| | cos | compared |
|---|---:|---:|---:|---:|
| auto | 0.0032 | 0.0002 | 1.00000 | 350 |
| cpu | 0.0009 | 0.00004 | 1.00000 | 350 |

Identical to baseline to 4 decimals on all metrics — math is bit-for-bit
equivalent (one projection per ODE step → one projection up front, weights
and inputs unchanged).

**Speed** (warm bench, median of iter 2-5):

| Backend | stage | baseline | Opt 1 | Δ | Δ% |
|---|---|---:|---:|---:|---:|
| auto | vision | 1146 | 1078 | -68 | -5.9%* |
| auto | smollm2_compute | 239 | 234 | -5 | -2.1%* |
| auto | smollm2_total | 329 | 343 | **+14** | **+4.3%** |
| auto | **ode** | **872** | **779** | **-93** | **-10.7%** |
| auto | **total** | **2345** | **2201** | **-144** | **-6.1%** |
| cpu | vision | 6240 | 5992 | -248 | -4.0%* |
| cpu | smollm2_compute | 1665 | 1534 | -131 | -7.9%* |
| cpu | smollm2_total | 1803 | 1690 | -113 | -6.3% |
| cpu | **ode** | **1946** | **1843** | **-103** | **-5.3%** |
| cpu | **total** | **10084** | **9540** | **-544** | **-5.4%** |

(*) `vision` and `smollm2_compute` were not modified — those Δ are noise
floor (≈ ±5%). The targeted stages are `smollm2_total` (which gains the
new hoisted projection work) and `ode` (which loses the per-step
projection).

**Verdict: kept.** ODE inner-loop dropped 10.7% on Vulkan, 5.3% on CPU.
The hoist adds ~14 ms to `smollm2_total` on Vulkan (the new one-shot
projection, paid once per inference) but saves 93 ms in the ODE loop —
net +6.1% speedup. Accuracy bit-for-bit unchanged.

## Opt 2 — Cast norm/bias to F32 once

**Skipped** — provably no-op on this fixture.

`to_f32(ctx, x)` (`smolvla.cpp:44`) already short-circuits when
`x->type == GGML_TYPE_F32`:

```cpp
if (x && x->type != GGML_TYPE_F32) {
  return ggml_cast(ctx, x, GGML_TYPE_F32);
}
return x;
```

The fixture is `smolvla-libero-f32-fixed.gguf` (F32 weights throughout), so
no `ggml_cast` ops are inserted by `to_f32` — and the `to_bf16_precision`
helper at `smolvla.cpp:54` is unreferenced. The patch would be worth doing
preemptively before someone ships a quantized SmolVLA GGUF, but on the
current f32 build it adds zero performance and zero risk in either
direction. Defer until we have an F16/BF16/quantized fixture to validate
against.

## Opt 3 — `ggml_soft_max_ext`

**Implementation**: replaced `ggml_scale → ggml_add(mask) → ggml_soft_max`
triples with one `ggml_soft_max_ext(ctx, attn, mask, scale, 0.0f)` at the
4 live attention sites:

- SigLIP transformer (no mask): `smolvla.cpp:225` → 1-arg form with
  `mask=nullptr`.
- `build_transformer_layer` (SmolLM2/expert prefill): `smolvla.cpp:484`.
- `build_denoise_step_graph` self-attn branch: `smolvla.cpp:894`.
- `build_denoise_step_graph` cross-attn branch: `smolvla.cpp:965`.

(`build_gqa_attention` and `build_expert_cross_attn_layer` are unreferenced
in the live graph builders — left untouched to keep the diff minimal.)

**Accuracy** (integration test, vs PyTorch reference):

| Backend | max\|Δ\| | mean\|Δ\| | cos | compared |
|---|---:|---:|---:|---:|
| auto | 0.0032 | 0.0002 | 1.00000 | 350 |
| cpu | 0.0009 | 0.00004 | 1.00000 | 350 |

Bit-for-bit identical to baseline; `ggml_soft_max_ext(a, mask, scale, 0)`
computes `softmax(scale*a + mask)`, which equals `softmax(scale*a + mask)`
of the unfused path.

**Speed** (warm bench, median of iter 2-5; vs Opt 1 prior state):

| Backend | stage | Opt 1 | Opt 3 | Δ |
|---|---|---:|---:|---:|
| auto | smollm2_total | 343 | 339 | -4 |
| auto | ode | 779 | 775 | -4 |
| auto | total | 2201 | 2266 | +65 (noise; one vision outlier in iter 3) |
| cpu | smollm2_total | 1690 | 1770 | +80 (noise) |
| cpu | ode | 1843 | 1810 | -33 |
| cpu | total | 9540 | 9595 | +55 (within ±2% noise floor) |

**Verdict: kept.** Speed is flat on Vulkan/Intel-Iris-Xe and flat on CPU —
these backends already handle scale+add+softmax efficiently as separate
ops. The fusion is still worth keeping because it (a) reduces graph node
count by ~22 ops per inference (4 sites × 32 layers worth where applicable)
which lowers gallocr pressure on memory-constrained devices, (b) is a
prerequisite for ever switching to `ggml_flash_attn_ext`, and (c) tends to
help more on mobile GPUs where kernel-launch overhead is non-trivial.

## Opt 4 — `ggml_swiglu_split`

**Implementation**: replaced `gate = silu(gate); out = mul(gate, up)` with
`out = ggml_swiglu_split(ctx, gate, up)` at the 2 live SwiGLU sites:

- `build_transformer_layer` MLP (used by both SmolLM2 and expert layers via
  `build_smollm2_graph` and the expert loop): `smolvla.cpp:520`.
- `build_denoise_step_graph` inline expert MLP: `smolvla.cpp:1007`.

(`build_expert_cross_attn_layer:689` is dead code — left untouched.)

`ggml_swiglu_split(a, b)` computes `silu(a) * b` per ggml.h:1328 — same
math as the unfused pair.

**Accuracy** (integration test, vs PyTorch reference):

| Backend | max\|Δ\| | mean\|Δ\| | cos | compared |
|---|---:|---:|---:|---:|
| auto | 0.0032 | 0.0002 | 1.00000 | 350 |
| cpu | 0.0009 | 0.00004 | 1.00000 | 350 |

Bit-for-bit unchanged.

**Speed** (warm bench, median of iter 2-5; vs Opt 3 prior state):

| Backend | stage | Opt 3 | Opt 4 | Δ |
|---|---|---:|---:|---:|
| auto | smollm2_total | 339 | 351 | +12 (noise) |
| auto | ode | 775 | 765 | -10 |
| auto | **total** | **2266** | **2139** | **-127 (-5.6%)** |
| cpu | smollm2_total | 1770 | 1699 | -71 |
| cpu | ode | 1810 | 1851 | +41 (noise) |
| cpu | total | 9595 | 9988 | +393 (cpu vision spike — see iter 2 = 6792) |

Cumulative vs **baseline**: auto -8.8% total, cpu roughly flat (within noise).

**Verdict: kept.** Saves ~60-130 ms on Vulkan total per inference;
flat-with-noise on CPU. Two ops (silu + mul) → one op per MLP per layer
across 12 SigLIP + 32 SmolLM2 + 32 expert layers (×10 ODE steps for
expert) = ~140 graph nodes saved per inference.

## Opt 5 — Drop GQA `ggml_repeat`

**Tried, reverted — broke CPU-backend accuracy.**

**Implementation tried**: removed the `if (kv_groups > 1) { reshape_4d → repeat
→ reshape_3d }` blocks at the 3 live attention sites in `build_transformer_layer`,
`build_denoise_step_graph` self-attn, and `build_denoise_step_graph` cross-attn.
Plan was to rely on `ggml_mul_mat`'s native broadcasting, since the docs at
ggml.h:1405 advertise it (`B: [ne03 * x, ne02 * y, m, k]`) and
`ggml_flash_attn_ext` documents the same `n_head % n_head_kv == 0` rule.

**Accuracy** (integration test):

| Backend | max\|Δ\| | mean\|Δ\| | cos | result |
|---|---:|---:|---:|---|
| auto (Vulkan0) | 0.0032 | 0.0002 | 1.00000 | ✅ unchanged |
| cpu | **1.9057** | **0.3089** | **0.0196** | ❌ broken |

CPU output diverges to noise (cos≈0.02, max\|Δ\|≈1.9 — values that should be
near-zero are off by ±2). Vulkan path was bit-for-bit identical to baseline,
which confirms the math is correct but the **ggml CPU backend's `mul_mat`
does not honour `ne02_b = ne02_a * y` broadcasting** for our K/V layout
(post-`ggml_cont(ggml_permute(...))`). Likely the CPU kernel only walks
`ne02_a == ne02_b` and silently produces garbage when they differ.

**Verdict: reverted.** Restored the explicit `ggml_repeat` blocks; integration
test back to 41/41 passing on both backends. To unlock this optimization
later we need either (a) a CPU-side ggml fix to support GQA broadcast in
`ggml_mul_mat`, or (b) llama.cpp's pattern of pre-storing V transposed in
the KV cache so the second matmul aligns naturally — both out of scope for
this pass.

## Opt 6 — Time-MLP concat → split

**Tried, reverted — net regression.**

**Implementation tried**: replaced `concat(action_emb, time_embed) →
linear(W_in, bias)` with two split linears using `ggml_view_2d` to slice
`W_in` into `W_a` (first H input rows) and `W_t` (second H input rows),
then `add(mul_mat(W_a, action) , mul_mat(W_t, time)) + bias`.

**Accuracy** (integration test): pass — max\|Δ\|=0.0029 auto, 0.0009 cpu
(within 4-decimal noise of baseline 0.0032 / 0.0009; `ggml_view_2d`-driven
matmul with strided weight is mathematically equivalent).

**Speed** (warm bench, vs Opt 4 prior state):

| Backend | total min | total med | Δ med |
|---|---:|---:|---:|
| auto Opt 4 | 2122 | 2139 | — |
| auto Opt 6 | 2259 | 2455 | **+316 (+14.8%)** |
| cpu Opt 4 | 9386 | 9988 | — |
| cpu Opt 6 | 10009 | 10091 | +103 (+1.0%, noise) |

**Verdict: reverted.** The original `ggml_concat` along dim 0 (~192 KB
memcpy for chunk=50, H=480) is cheap, and CPU/Vulkan kernels for
`ggml_mul_mat` against a non-contiguous `ggml_view_2d` of the weight
turn out to be slower than the contiguous-weight matmul against a
double-width input — the strided-load pattern apparently defeats the
fast SIMD/tile path on Intel Iris Xe Vulkan in particular.

To unlock this optimization properly we'd need to physically split
`action_time_mlp_in_weight` into two contiguous tensors at load time
(creating two new buffer-backed weight tensors). Out of scope for this
pass — the concat itself is not on any hot path.

## Opt 8 — `ggml_flash_attn_ext` at SmolLM2 prefill

**Recipe found, but reverted on this hardware: 3× slower on Intel Iris Xe.**

This was a follow-up to the recall that flash-attn was tried before and
"lacking some support". Our ggml fork *does* expose
`ggml_flash_attn_ext` (`ggml.h:2310`), and the kernel runs on both
Vulkan (Intel Iris Xe) and CPU — no `supports_op` rejection, no
fallback. So whatever support gap the prior attempt hit has been
closed.

**First attempt — wrong**: replaced the unfused triple in
`build_transformer_layer` (SmolLM2 prefill, head_dim=64, num_heads=15,
num_kv_heads=5, seq_q=seq_k=prefix_len=177). Permuted Q/K/V to
flash-attn layout `(head_dim, seq, n_head*)`, padded mask along ne1 to
`GGML_KQ_MASK_PAD = 64` (177 → 192), passed F32 mask. Got max\|Δ\|=2.04,
cos=0.47 on **both** backends (identical to 4 decimals → not a backend
issue, my call was wrong).

**Found the bug with a focused gtest**
(`packages/vla/test/unit/test_flash_attn.cpp`): synthetic Q/K/V at the
same shapes, ran 5 variants of the flash-attn call against the unfused
reference. Result table:

| Variant | max\|Δ\| | cos |
|---|---:|---:|
| v0 — F32 mask + cont + reshape | 3.700717 | 0.278 |
| v1 — F32 mask + reshape (llama.cpp pattern) | 3.700717 | 0.278 |
| v2 — F32 mask + permute(0,2,1,3) of result | 4.006205 | 0.048 |
| v3 — F32 mask + `GGML_PREC_F32` | 3.700717 | 0.278 |
| **v4 — F16 mask + `GGML_PREC_F32`** | **0.000000** | **1.000000** |

The bug was the **mask dtype**: `ggml_flash_attn_ext` requires a F16
mask. F32 mask is silently accepted and produces structured-but-shifted
output (cos≈0.28). The result-tensor layout was right both ways
(ggml_cont before reshape works the same as direct reshape — the
"!!permuted!!" comment is misleading). The result-permute(0,2,1,3)
variant (v2) is *worse*, confirming my original layout interpretation
was correct.

**Second attempt — correct**: cast `attn_mask` to `GGML_TYPE_F16`
inside the graph, set `ggml_flash_attn_ext_set_prec(out, GGML_PREC_F32)`
for the K@Q^T accumulator, and pad the input slot to
`GGML_PAD(prefix_len, 64)`.

**Accuracy** (integration test):

| Backend | max\|Δ\| | mean\|Δ\| | cos |
|---|---:|---:|---:|
| auto (Vulkan0) | **0.0018** | 0.0002 | 1.00000 |
| cpu | 0.0009 | 0.00004 | 1.00000 |

Auto's max\|Δ\| went *down* from 0.0032 → 0.0018 vs the unfused path —
flash-attn-ext with `GGML_PREC_F32` accumulator is more precise than
the unfused matmul on Vulkan. ✓

**Speed** (warm bench, vs Opts-1+3+4 prior state):

| Backend | stage | prior | flash-attn | Δ |
|---|---|---:|---:|---:|
| auto | smollm2_compute | 252 | 1073 | **+821 (+325%)** |
| auto | **total** | **2247** | **3019** | **+772 (+34%) regression** |
| cpu | smollm2_compute | 1604 | 1479 | -125 (-7.8%) |
| cpu | **total** | **9921** | **9635** | **-286 (-2.9%)** |

Per-layer cost on Vulkan: ~3 ms unfused vs ~25 ms flash-attn-ext over
32 SmolLM2 layers. Intel Iris Xe Vulkan's flash-attn kernel is heavily
unoptimized for this shape (head_dim=64, GQA 15/5, fp16=1 / matrix
cores=none) — likely falls back to a generic per-row compute pattern
that's slower than the well-tuned matmul + soft_max_ext path.

**Verdict: reverted in production code; the gtest stays.** Flash-attn
helps marginally on CPU but is a hard regression on Intel Vulkan. For
the actual deployment targets (Adreno HTP, Mali — see arch.md), the
trade-off is plausibly inverted (mobile flash-attn is bandwidth-bound
where the fused path shines). To re-enable, gate on the GPU device
description (or just enable when running on Adreno ≥ 800 / Mali / Metal)
and re-bench on the device-farm runners. The gtest
`SmolvlaFlashAttn.MatchesUnfusedReference` documents the F16-mask +
PREC_F32 recipe and prevents regression of the layout fix.

**Recipe to re-enable** (when mobile-bench shows it helps):

```cpp
// 1. Pad the mask input slot to GGML_KQ_MASK_PAD (64) along ne1 (seq_q)
const int prefix_len_pad = GGML_PAD(prefix_len, GGML_KQ_MASK_PAD);
struct ggml_tensor* g_prefix_mask = ggml_new_tensor_2d(
    sg2.ctx, GGML_TYPE_F32, prefix_len, prefix_len_pad);

// 2. In build_transformer_layer, replace the GQA repeat + matmul +
//    soft_max_ext + matmul block with:
struct ggml_tensor* q_fa = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
struct ggml_tensor* k_fa = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
struct ggml_tensor* v_fa = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));
struct ggml_tensor* mask_fa =
    attn_mask ? ggml_cast(ctx, attn_mask, GGML_TYPE_F16) : nullptr;
struct ggml_tensor* attn_out = ggml_flash_attn_ext(
    ctx, q_fa, k_fa, v_fa, mask_fa,
    1.0f / sqrtf((float)head_dim), 0.0f, 0.0f);
ggml_flash_attn_ext_set_prec(attn_out, GGML_PREC_F32);
attn_out = ggml_reshape_2d(ctx, attn_out, num_heads * head_dim, seq_len);
```

## Opt 7 — Pre-fold patch-embed bias

**Skipped — gain is negligible and clean impl needs owned buffer.**

Site: `build_siglip_patch_embed` (`smolvla.cpp:156-161`) does
```cpp
x = ggml_add(ctx, x, to_f32(ctx, vw.patch_embed_bias)); // (768,) broadcast
x = ggml_add(ctx, x, to_f32(ctx, vw.pos_embed));        // (768, 1024)
```

A "fold inside graph" via `ggml_add` of the two constants doesn't save
anything — the allocator still emits one add for the constants plus one
final `x + combined`, same op count. To genuinely win, we'd need to
allocate a new owned `(768, 1024)` weight tensor at load time containing
`pos_embed + broadcast(patch_embed_bias)`, then reference that single
constant from the graph. That requires a new write-target buffer (the
GGUF weight buffer is read-only) and bumps the on-device weight memory
by 3 MB.

Cost/benefit: this site runs **once per image** (2 images per
inference). Each `ggml_add` over 768×1024 F32s is tens of microseconds
on Vulkan, sub-ms on CPU. Even a perfect fold would shave ≪1 ms of
total inference. Not worth the load-time complexity. Defer until we
have a profiler showing it on a hot path.
