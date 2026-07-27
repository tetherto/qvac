# LAM Audio2Expression — graph and GGUF internals

How speech becomes facial animation, one operation at a time.

This document explains the ggml graph as implemented, and how the GGUF that
feeds it is produced. For the commands to actually run any of it, see
[`../scripts/README-lam-a2e.md`](../scripts/README-lam-a2e.md).

## Where the code lives

The pipeline spans two repositories.

| Layer | File | Role |
|---|---|---|
| JS API | `src/index.ts` (`LamAudio2Expression`) | validates input, manages the job |
| Addon | `addon/src/model-interface/LamAudio2ExpressionModel.cpp` | serialises frames to JSON |
| C API | `include/lam-a2e.h`, `src/lam-a2e.cpp` | `lam_a2e_*` entry points, timestamps |
| Graph | `src/lam_audio2expression.cpp` | the ggml graph — the subject of this doc |
| Converter | `scripts/convert-lam-a2e-to-gguf.py`, `scripts/_lam_a2e_arch.py` | checkpoint to GGUF |

The last three `src/` paths are in `qvac-ext-stable-diffusion.cpp`; the rest are
here in `packages/diffusion-cpp`.

## What goes in and what comes out

The model consumes exactly two things and produces one.

**In:** a mono 16 kHz float32 waveform, and an identity index in `0..11`
selecting one of twelve speaker styles baked into the checkpoint.

**Out:** for each 30 fps frame, 52 ARKit blendshape coefficients in `0..1`.
Each is "how much is this facial movement happening right now" — `jawOpen` at
0.39 means the jaw is 39% of the way open.

The rest of this document follows one concrete example: `jfk.wav`, 176,000
samples, 11.00 seconds, which yields 330 frames.

## The one thing to understand first: two layouts

ggml stores `ne[0]` as the fastest-varying dimension, the opposite of how
PyTorch shapes read. The graph deliberately switches between two layouts, and
almost every `ggml_cont(ggml_transpose(...))` in the source is a deliberate
move between them:

- **Time-major `[t, c]`** — time on `ne[0]`. Convolutions need this, because
  `ggml_im2col` slides along `ne[0]`.
- **Feature-major `[c, t]`** — channels on `ne[0]`. Matrix multiplies and
  LayerNorm need this, because both reduce over `ne[0]`.

Reading the graph is much easier once you track which layout is currently
active. The stage tables below name it explicitly.

Throughout, `ggml_mul_mat(A, B)` with `A = [k, m]` and `B = [k, n]` produces
`[m, n]` — it contracts over `ne[0]` of both arguments.

## Graph inputs

Three tensors are fed in per run, built in `LamAudio2Expression::run`:

| Tensor | Shape | Contents |
|---|---|---|
| `input_pcm` | `[176000, 1]` | the raw waveform |
| `input_id` | `[12, 1]` | one-hot identity vector |
| `input_interp` | `[549, 330]` | precomputed resampling matrix (see stage 2) |

The third is unusual and worth flagging: rather than calling an interpolation
op, the graph precomputes a resampling **matrix** on the CPU and multiplies by
it. More on why below.

## Stage 1 — feature extractor

Seven strided convolutions turn raw samples into 512-channel features. Layout
is time-major throughout.

Each layer shrinks time by `len = (len - kernel) / stride + 1`:

| Layer | Kernel | Stride | In | Out |
|---|---|---|---|---|
| `fe.conv0` | 10 | 5 | `[176000, 1]` | `[35199, 512]` |
| `fe.conv1` | 3 | 2 | `[35199, 512]` | `[17599, 512]` |
| `fe.conv2` | 3 | 2 | `[17599, 512]` | `[8799, 512]` |
| `fe.conv3` | 3 | 2 | `[8799, 512]` | `[4399, 512]` |
| `fe.conv4` | 3 | 2 | `[4399, 512]` | `[2199, 512]` |
| `fe.conv5` | 2 | 2 | `[2199, 512]` | `[1099, 512]` |
| `fe.conv6` | 2 | 2 | `[1099, 512]` | `[549, 512]` |

The cumulative stride is 320, so 16,000 samples per second becomes roughly 50
feature vectors per second. Here: 549 over 11.00 s, or 49.91 Hz.

`GELU-erf` follows every layer. After the **first** layer only, a GroupNorm is
applied with 512 groups over 512 channels — which is just "normalise each
channel independently across time". Since time is on `ne[0]` in this layout,
that is a plain `ggml_norm`, then a scale and shift broadcast over the time
axis.

Tapped as `fe_out` at `[549, 512]`.

### Why a hand-written conv1d

`conv1d()` at the top of `lam_audio2expression.cpp` reimplements what
`ggml_conv_1d` already does, for one reason: the stock version always runs
im2col in F16. That quietly costs three decimal digits of precision. The local
version passes `kernel->type` as the im2col output type, so an F32 kernel stays
F32 end to end. This is what makes the measured 2.9e-6 parity possible; with
the stock op the error floor sits near 1e-3.

## Stage 2 — 50 Hz to 30 fps

Frame count is `ceil(samples × fps / sampleRate)` = `ceil(176000 × 30 / 16000)`
= 330. So 549 feature vectors must become 330.

This is linear interpolation with `align_corners=true`, but implemented as a
single matrix multiply:

```
ggml_mul_mat(input_interp[549, 330], fe_out[549, 512]) -> [330, 512]
```

The matrix is filled on the CPU before compute. For each output frame `j`, at
most two entries are non-zero — the two neighbouring source positions and their
blend weights. Doing it this way keeps the resampling exact and side-steps any
disagreement between ggml's interpolation op and PyTorch's `align_corners`
convention. The cost is an `[tConv, frames]` matrix, which is small relative to
everything else.

Tapped as `interp_out` at `[330, 512]`.

## Stage 3 — feature projection

Switch to feature-major and widen 512 to 768:

| Step | Op | Out |
|---|---|---|
| transpose | `[330, 512]` to feature-major | `[512, 330]` |
| `fp.ln` | LayerNorm over 512 features | `[512, 330]` |
| `fp.proj` | `mul_mat([512, 768], ·)` + bias | `[768, 330]` |

Tapped as `fp_out`. From here to the end of the encoder, everything stays
feature-major at `[768, 330]`.

## Stage 4 — positional convolution

wav2vec2 has no sinusoidal position encoding. Instead it adds the output of one
big grouped convolution — kernel 128, 16 groups — which lets each position see
±64 frames of context.

ggml has no grouped conv1d, so the graph runs **16 separate convolutions**, one
per group of 48 channels, slicing both the input and the kernel with views, and
concatenates the results:

| Step | Detail | Out |
|---|---|---|
| transpose | to time-major | `[330, 768]` |
| per group ×16 | input view `[330, 48]`, kernel view `[128, 48, 48]`, conv with pad 64 | `[331, 48]` each |
| concat | along the channel axis | `[331, 768]` |
| trim | drop the trailing sample | `[330, 768]` |
| bias, GELU-erf | | `[330, 768]` |
| transpose | back to feature-major | `[768, 330]` |

The trim deserves a note. An even kernel padded by `k/2` produces one *more*
output than input — 331 from 330. Upstream calls this `Wav2Vec2SamePadLayer`
and drops the last element. Omitting that step would misalign every subsequent
frame by one.

The result is added to the stream as a residual, then `enc.ln` LayerNorm runs.
Tapped as `pos_conv_out` and `enc_pre_ln`.

## Stage 5 — transformer encoder, 12 layers

Standard multi-head self-attention, 12 heads of 64 dimensions each. This is the
**post-norm** variant: LayerNorm comes *after* each residual add, not before.

Per layer, with `cur` at `[768, 330]`:

| Step | Op | Out |
|---|---|---|
| Q, K, V | three `mul_mat([768, 768], ·)` + bias | `[768, 330]` each |
| scale Q | `× 1/sqrt(64)` | `[768, 330]` |
| split heads, Q and K | reshape to `[64, 12, 330]`, permute | `[64, 330, 12]` |
| split heads, V | same reshape, different permute | `[330, 64, 12]` |
| scores | `soft_max(mul_mat(K, Q))` | `[330, 330, 12]` |
| weighted sum | `mul_mat(V, scores)` | `[64, 330, 12]` |
| merge heads | permute, reshape | `[768, 330]` |
| output proj | `mul_mat([768, 768], ·)` + bias | `[768, 330]` |
| residual + `ln1` | add input, then LayerNorm | `[768, 330]` |
| FFN up | `mul_mat([768, 3072], ·)` + bias, GELU-erf | `[3072, 330]` |
| FFN down | `mul_mat([3072, 768], ·)` + bias | `[768, 330]` |
| residual + `ln2` | add, then LayerNorm | `[768, 330]` |

V is permuted to `[t, headDim, heads]` rather than `[headDim, t, heads]`
because the second matmul contracts over time, not over the head dimension.
Getting this permutation wrong is the classic attention porting bug: shapes
still line up and the graph runs, but the values are silently transposed.

Q is scaled *before* the score matmul rather than scaling the scores after.
Mathematically identical, one fewer full-size tensor to touch.

Note the attention matrix is `[330, 330]` per head — quadratic in frame count.
For an 11-second clip that is trivial, but it is the term that grows for long
audio.

Each layer is tapped as `enc_layer_0` through `enc_layer_11`.

## Stage 6 — the LAM head

This is the part that is specific to LAM rather than inherited from wav2vec2.
It mixes in speaker identity and narrows 768 features down to 52 coefficients.

**Project and inject identity:**

| Step | Op | Out |
|---|---|---|
| `head.proj` | `mul_mat([768, 512], ·)` + bias | `[512, 330]` |
| `head.id_mlp` | `mul_mat([12, 64], one_hot[12, 1])` + bias | `[64, 1]` |
| broadcast | repeat the identity vector across time | `[64, 330]` |
| concat | join on the channel axis | `[576, 330]` |

The identity vector is constant across the whole clip — it conditions *style*,
not timing. `head.id_mlp.weight` is stored as a `[1, 12, 64]` kernel (a
width-1 convolution) and reshaped to a `[12, 64]` matrix for the multiply.

**Six ConvNormRelu blocks.** Each is: conv (kernel 3, stride 1, pad 1) with
bias, LayerNorm over channels, an optional residual, then ReLU. Because the
conv needs time-major and the LayerNorm needs feature-major, each block
transposes twice internally.

| Block | Residual | In | Out |
|---|---|---|---|
| `head.first0` | via `head.first0.res` conv | `[576, 330]` | `[512, 330]` |
| `head.first1` | identity | `[512, 330]` | `[512, 330]` |
| `head.first2` | identity | `[512, 330]` | `[512, 330]` |
| `head.dec0` | none | `[512, 330]` | `[512, 330]` |
| `head.dec1` | none | `[512, 330]` | `[512, 330]` |
| `head.dec2` | none | `[512, 330]` | `[512, 330]` |

`first0` needs a projection residual rather than an identity one because it is
the only block that changes width, 576 to 512.

**Output:**

| Step | Op | Out |
|---|---|---|
| `head.out` | `mul_mat([512, 52], ·)` + bias | `[52, 330]` |
| sigmoid | squash into `0..1` | `[52, 330]` |

The sigmoid is what makes every coefficient independently interpretable — this
is not a softmax, so several blendshapes are active at once, which is exactly
what a real face does.

## Reading the result

`expr` is `[52, 330]` with the 52 coefficients contiguous on `ne[0]`, so a flat
read is already frame-major: frame 0's 52 values, then frame 1's, and so on.
That is why `lam-a2e.cpp` can `memcpy` each frame directly with no shuffling.

Timestamps are assigned there as `i * 1000000 / fps` microseconds. Since 1/30 s
is not a whole number of microseconds, the integer division makes steps
alternate between 33,333 and 33,334 µs, which keeps cumulative drift at zero
rather than letting it accumulate.

## Stage taps

Every stage above is named and can be captured by passing a `taps` map to
`run()`. When taps are requested the tensors are flagged as graph outputs so
the allocator does not recycle their buffers mid-graph.

This exists for debugging: when the final numbers disagree with the reference,
the taps tell you *which stage* first diverged, instead of leaving you to
bisect a 100 M parameter model by hand.

## How the GGUF is written

### Why no transposes are needed

This is the single most useful fact about the converter, and the reason it is
only ~50 lines.

PyTorch stores a conv1d weight as `(C_out, C_in, K)` in row-major order. ggml
labels dimensions with `ne[0]` as the *fastest-varying* axis — which is the
*last* numpy axis. So the very same bytes, copied verbatim, read as
`ne = [K, C_in, C_out]`, which is precisely the layout `ggml_im2col` expects.

The same holds for `Linear`: PyTorch `(out_features, in_features)` becomes
`ne = [in, out]`, and `ggml_mul_mat` contracts over `ne[0]` — the input
dimension. Correct again.

So the converter performs **no transposes anywhere**. It is a byte-level 1:1
copy of the state dict. Every "shape" in the tables above is a ggml `ne`, which
is why they look reversed compared to the PyTorch source.

### Metadata

The GGUF is self-describing. `general.architecture = "lam-audio2exp"` is what
selects this loader, and every dimension is read back with `ggufGetU32Or` in
`load()`:

| Key | Value | Used for |
|---|---|---|
| `sample_rate` | 16000 | frame-count arithmetic |
| `fps` | 30 | frame count, timestamps |
| `n_coeffs` | 52 | output width |
| `n_identity` | 12 | one-hot size, index validation |
| `identity_feat_dim` | 64 | identity branch width |
| `hidden_dim` | 512 | head width |
| `window_frames` | 64 | streaming window (unused by the batch path) |
| `layer_norm_eps` | 1e-5 | every LayerNorm |
| `enc.n_layers` | 12 | encoder loop bound |
| `enc.n_heads` | 12 | head split |
| `enc.hidden` | 768 | encoder width |
| `enc.ffn` | 3072 | FFN width |
| `enc.pos_conv_kernel` | 128 | positional conv padding |
| `enc.pos_conv_groups` | 16 | positional conv group count |
| `fe.kernels` | `[10,3,3,3,3,2,2]` | feature extractor geometry |
| `fe.strides` | `[5,2,2,2,2,2,2]` | feature extractor geometry |
| `coeff_names` | 52 ARKit names | labelling the output |

Because the loader reads dimensions rather than assuming them, a *smaller*
model with the same structure loads and runs fine. That is what
`make-tiny-lam-a2e-gguf.py` exploits to produce a 515 KB test model that
exercises the same code path as the 402 MB one.

### Tensor names

241 tensors, renamed from PyTorch paths to short stable keys:

| PyTorch | GGUF |
|---|---|
| `audio_encoder.feature_extractor.conv_layers.N.conv.weight` | `fe.convN.weight` |
| `audio_encoder.feature_projection.projection.weight` | `fp.proj.weight` |
| `audio_encoder.encoder.layers.N.attention.q_proj.weight` | `enc.blkN.attn_q.weight` |
| `audio_encoder.encoder.layers.N.feed_forward.intermediate_dense.weight` | `enc.blkN.ffn_up.weight` |
| `feature_projection.weight` | `head.proj.weight` |
| `identity_encoder.first_net.conv_layers.N.conv.weight` | `head.firstN.conv.weight` |
| `decoder.0.N.conv.weight` | `head.decN.conv.weight` |
| `output_proj.weight` | `head.out.weight` |

Watch the collision hazard: the checkpoint has **two** different things called
`feature_projection`. `audio_encoder.feature_projection` is wav2vec2's 512 to
768 widening; a bare `feature_projection` is the LAM head's 768 to 512
narrowing. They map to `fp.proj` and `head.proj` respectively. Getting these
backwards would load cleanly and produce garbage.

## How the converter works

`convert-lam-a2e-to-gguf.py` is deliberately thin; the layout knowledge lives
in `_lam_a2e_arch.py` so that the three producers — the real converter, the
no-torch remapper, and the tiny-model generator — cannot drift apart.

**1. Load.** `torch.load(..., weights_only=True)`, then take `["state_dict"]`.

**2. Strip prefixes.** Keys carry `module.` from `DataParallel` and `backbone.`
from the training wrapper. Both are removed.

**3. Drop what inference never touches.** Three groups go: `lm_head` (the
self-supervised pretraining objective), `identity_encoder.grus` (a recurrent
path the streaming variant does not use), and `masked_spec_embed` (a
training-time augmentation). Keeping them would bloat the file and trip the
strict check in step 6.

**4. Fold the weight norm.** The positional conv is stored with PyTorch weight
normalisation as two tensors, `weight_g` `(1,1,128)` and `weight_v`
`(768,48,128)`. The runtime wants one plain kernel, so the converter collapses
them:

```
weight = g * v / ||v||        norm over dims (0,1), per kernel position
```

This is the only arithmetic the converter performs. Everything else is a copy.

**5. Convert to float32 numpy.** Uniform dtype before any narrowing.

**6. Validate strictly, in both directions.** A checkpoint tensor with no
mapping is an error, and a mapped name absent from the checkpoint is also an
error. A new upstream revision that renames anything therefore fails loudly
instead of silently emitting a GGUF with missing weights — which would surface
much later as a null dereference or, worse, plausible-looking wrong output.

**7. Write.** Metadata first, then tensors sorted by GGUF name for a
deterministic layout.

### F32 versus F16

`--dtype f16` narrows only tensors flagged as matmul or conv weights. Norm
weights and all biases stay F32, because they are tiny and sit on the numerically
sensitive paths.

| Build | Size | Max abs diff vs reference |
|---|---|---|
| F32 | 402 MB | 2.9e-6 |
| F16 | 201 MB | 1.4e-3 |

Half the bytes for roughly three orders of magnitude more error. F16 is fine
for driving a face; F32 is the build to use whenever parity is the thing being
asserted.

## Parameter budget

| Component | Params | Share |
|---|---|---|
| wav2vec2 encoder | 94.37 M | 93.9% |
| LAM head | 6.13 M | 6.1% |
| total | 100.50 M | |

Almost the entire model is the speech encoder. The part that actually produces
facial coefficients is a thin layer on top of a large, general-purpose audio
representation.
