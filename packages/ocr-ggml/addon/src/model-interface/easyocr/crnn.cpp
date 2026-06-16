#include "crnn.hpp"

#include <cassert>
#include <string>
#include <vector>

#include "crnn_weights.hpp"
#include "ggml.h"
#include "ops.hpp"

// NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,readability-identifier-naming,readability-identifier-length)
// CRNN graph builder uses snake_case identifiers (W_hh, b_ih, i_gate)
// matching upstream PyTorch and single-letter math identifiers (x, t, h, c).

namespace easyocr::ggml {

namespace {

using ::ggml_context;
using ::ggml_tensor;

inline ggml_tensor* relu(ggml_context* ctx, ggml_tensor* x) {
  return ggml_relu(ctx, x);
}

inline ggml_tensor*
maxpool(ggml_context* ctx, ggml_tensor* x, int k0, int k1, int s0, int s1) {
  return ggml_pool_2d(
      ctx, x, GGML_OP_POOL_MAX, k0, k1, s0, s1, /*p0=*/0.0F, /*p1=*/0.0F);
}

void tap(
    std::unordered_map<std::string, ggml_tensor*>* taps, const char* name,
    ggml_tensor* t) {
  if (taps != nullptr) {
    ggml_set_name(t, name);
    (*taps)[name] = t;
  }
}

// Conv with the (folded) bias added back via channel-wise broadcast.
template <class W>
ggml_tensor* conv_bias_t(
    ggml_context* ctx, const W& weights, ggml_tensor* x, const char* path,
    int p, int s = 1) {
  return ops::conv_2d_bias(
      ctx,
      x,
      weights.w(path),
      weights.b(path),
      /*s0=*/s,
      /*s1=*/s,
      /*p0=*/p,
      /*p1=*/p,
      /*d0=*/1,
      /*d1=*/1,
      /*conv1x1_mulmat=*/weights.conv1x1_mulmat());
}

template <class W>
ggml_tensor* conv_bias_relu_t(
    ggml_context* ctx, const W& weights, ggml_tensor* x, const char* path,
    int p, int s = 1) {
  return relu(ctx, conv_bias_t(ctx, weights, x, path, p, s));
}

// Backwards-compatible wrappers used by build_crnn_gen2 below.
ggml_tensor* conv_bias(
    ggml_context* ctx, const CrnnGen2Weights& W, ggml_tensor* x,
    const char* path, int p) {
  return conv_bias_t(ctx, W, x, path, p);
}
ggml_tensor* conv_bias_relu(
    ggml_context* ctx, const CrnnGen2Weights& W, ggml_tensor* x,
    const char* path, int p) {
  return conv_bias_relu_t(ctx, W, x, path, p);
}

// ---------- BiLSTM helpers ---------------------------------------------------
//
// Batched over N sequences (QVAC-19796): state per direction is a hidden
// matrix h and cell matrix c, both of shape [hidden, N] (ggml ne
// [hidden, N]).  We materialize the `(W_ih @ x_t) + b_ih` part for the entire
// sequence/batch in a single matmul (`Wx`, ggml ne [4*hidden, T, N]) before
// the time-step loop, and per-step we add the `(W_hh @ h_{t-1}) + b_hh`
// contribution.  N==1 reduces to the original single-sequence behaviour.

// Apply one LSTM cell timestep for a whole batch.  `gates_x_t` is [4*hidden,
// N]; `h_prev`/`c_prev` are [hidden, N].  Returns a struct { h_new, c_new }
// shaped [hidden, N].
struct LstmStep {
  ggml_tensor* h;
  ggml_tensor* c;
};

// NOLINTBEGIN(bugprone-easily-swappable-parameters)
LstmStep lstm_cell_step(
    ggml_context* ctx,
    ggml_tensor* gates_x_t, // [4*hidden, N] = W_ih·x_t + b_ih
    ggml_tensor* W_hh,      // ggml ne [hidden, 4*hidden]
    ggml_tensor* b_hh,      // [4*hidden]
    ggml_tensor* h_prev,    // [hidden, N]
    ggml_tensor* c_prev) {  // [hidden, N]
  // NOLINTEND(bugprone-easily-swappable-parameters)
  const int64_t hidden = h_prev->ne[0];
  const int64_t batchN = h_prev->ne[1];

  // gates[4h, N] = (W_hh·h_prev) + gates_x_t + b_hh.  b_hh ([4h]) broadcasts
  // over the N columns; gates_x_t already carries b_ih.
  auto* gates = ggml_mul_mat(ctx, W_hh, h_prev); // ggml ne [4*hidden, N]
  gates = ggml_add(ctx, gates, gates_x_t);
  gates = ggml_add(ctx, gates, b_hh);

  // Split into 4 [hidden, N] gates: rows [k*hidden, (k+1)*hidden) of every
  // column.  A 2D view + cont gives the nonlinearities a contiguous input.
  // PyTorch's gate ordering is i, f, g, o.
  auto slice = [&](int64_t k) {
    auto* v = ggml_view_2d(
        ctx,
        gates,
        hidden,
        batchN,
        gates->nb[1],
        static_cast<size_t>(k * hidden) * sizeof(float));
    return ggml_cont(ctx, v); // [hidden, N]
  };
  auto* i_gate = ggml_sigmoid(ctx, slice(0));
  auto* f_gate = ggml_sigmoid(ctx, slice(1));
  auto* g_gate = ggml_tanh(ctx, slice(2));
  auto* o_gate = ggml_sigmoid(ctx, slice(3));

  // c = f * c_prev + i * g
  auto* c = ggml_add(
      ctx, ggml_mul(ctx, f_gate, c_prev), ggml_mul(ctx, i_gate, g_gate));
  // h = o * tanh(c)
  auto* h = ggml_mul(ctx, o_gate, ggml_tanh(ctx, c));
  return {.h = h, .c = c};
}

// Run one direction (forward or reverse) of LSTM over the whole [hidden, T]
// sequence.  `seq` is the [hidden_in, T] input with x_t at column t.
// Returns a [hidden_out, T] tensor with h_t at column t.
//
// We pre-compute the full [4*hidden, T] = (W_ih · seq) + b_ih in a single
// matmul + broadcast-add to avoid a per-step input projection.
// NOLINTBEGIN(bugprone-easily-swappable-parameters)
ggml_tensor* lstm_one_direction(
    ggml_context* ctx,
    ggml_tensor* seq,  // ggml ne [input, T, N]
    ggml_tensor* W_ih, // ggml ne [input, 4*hidden]
    ggml_tensor* W_hh, // ggml ne [hidden, 4*hidden]
    ggml_tensor* b_ih, // [4*hidden]
    ggml_tensor* b_hh, // [4*hidden]
    bool reverse) {
  // NOLINTEND(bugprone-easily-swappable-parameters)
  const int64_t T = seq->ne[1];
  const int64_t batchN = seq->ne[2];
  const int64_t hidden4 = W_ih->ne[1];
  const int64_t hidden = hidden4 / 4;

  // Full-sequence/full-batch input projection:
  //   Wx[4h, T, N] = (W_ih · seq[input, T, N]) + b_ih
  // b_ih ([4h]) broadcasts across both the T and N axes.
  auto* Wx = ggml_mul_mat(ctx, W_ih, seq); // ne [4h, T, N]
  Wx = ggml_add(ctx, Wx, b_ih);

  // Initial states: zeros of shape [hidden, N].  Derive from a 2D slice of Wx
  // (rows [0, hidden) of timestep 0, every N column) scaled by 0, so no
  // scratch tensor is needed in the no_alloc graph context.
  auto* zeroHN = ggml_scale(
      ctx,
      ggml_cont(
          ctx, ggml_view_2d(ctx, Wx, hidden, batchN, Wx->nb[2], /*offset=*/0)),
      0.0F); // [hidden, N] zeros

  ggml_tensor* h_prev = zeroHN;
  ggml_tensor* c_prev = zeroHN;

  // h_t outputs collected via concat into [hidden, T, N].
  ggml_tensor* out = nullptr;

  auto step_iter = [&](int64_t t) {
    // gates_x_t[4h, N] = column t of Wx across all N, made contiguous.
    // Wx is [4h, T, N]: nb[1] strides over T, nb[2] strides over N.
    auto* gates_x_t = ggml_cont(
        ctx,
        ggml_view_2d(
            ctx,
            Wx,
            hidden4,
            batchN,
            Wx->nb[2],
            static_cast<size_t>(t) * Wx->nb[1]));

    auto step = lstm_cell_step(ctx, gates_x_t, W_hh, b_hh, h_prev, c_prev);
    h_prev = step.h;
    c_prev = step.c;

    // Reshape h_prev [hidden, N] to [hidden, 1, N] so we can concat along T.
    auto* h_col = ggml_reshape_3d(ctx, h_prev, hidden, 1, batchN);

    if (out == nullptr) {
      out = ggml_cont(ctx, h_col);
    } else if (reverse) {
      // Prepend in time so output is in original time-order at the end.
      out = ggml_concat(ctx, h_col, out, /*dim=*/1);
    } else {
      out = ggml_concat(ctx, out, h_col, /*dim=*/1);
    }
  };

  if (reverse) {
    for (int64_t t = T - 1; t >= 0; --t) {
      step_iter(t);
    }
  } else {
    for (int64_t t = 0; t < T; ++t) {
      step_iter(t);
    }
  }
  return out; // ggml ne [hidden, T, N]
}

// One BidirectionalLSTM block (templated so it works for either weights
// class — both expose .w()/.b()/.t()).
template <class W>
ggml_tensor* bilstm_block_t(
    ggml_context* ctx, const W& weights, ggml_tensor* seq,
    const char* prefix /* e.g. "SequenceModeling.0" */) {

  const std::string r = std::string(prefix) + ".rnn";

  auto* fwd = lstm_one_direction(
      ctx,
      seq,
      weights.t(r + ".weight_ih_l0"),
      weights.t(r + ".weight_hh_l0"),
      weights.t(r + ".bias_ih_l0"),
      weights.t(r + ".bias_hh_l0"),
      /*reverse=*/false);
  auto* rev = lstm_one_direction(
      ctx,
      seq,
      weights.t(r + ".weight_ih_l0_reverse"),
      weights.t(r + ".weight_hh_l0_reverse"),
      weights.t(r + ".bias_ih_l0_reverse"),
      weights.t(r + ".bias_hh_l0_reverse"),
      /*reverse=*/true);

  // Concat along the feature axis (ggml dim 0).
  auto* both = ggml_concat(ctx, fwd, rev, /*dim=*/0); // ne [2*hidden, T]

  // Linear(2*hidden, hidden_out): apply per-timestep.  In ggml the matmul
  // is exactly Wx + b on the feature dim, vectorized across T.
  const std::string l = std::string(prefix) + ".linear";
  auto* W_lin = weights.w(l);               // ggml ne [2*hidden, hidden_out]
  auto* b_lin = weights.b(l);               // [hidden_out]
  auto* y = ggml_mul_mat(ctx, W_lin, both); // ne [hidden_out, T]
  {
    auto* b_2d = ggml_reshape_2d(ctx, b_lin, b_lin->ne[0], 1);
    y = ggml_add(ctx, y, ggml_repeat(ctx, b_2d, y));
  }
  return y;
}

// Backwards-compatible wrapper for gen-2 callers.
ggml_tensor* bilstm_block(
    ggml_context* ctx, const CrnnGen2Weights& W, ggml_tensor* seq,
    const char* prefix) {
  return bilstm_block_t(ctx, W, seq, prefix);
}

} // namespace

ggml_tensor* build_crnn_gen2(
    ggml_context* ctx, const CrnnGen2Weights& W, ggml_tensor* x,
    std::unordered_map<std::string, ggml_tensor*>* taps) {

  // ============== VGG_FeatureExtractor ===================================
  // Indices match the modules.py ConvNet Sequential.

  // ConvNet.0  Conv 1->32, k=3, p=1
  auto* h = conv_bias_relu(ctx, W, x, "FeatureExtraction.ConvNet.0", 1);
  // ConvNet.2  MaxPool(2, 2)
  h = maxpool(ctx, h, 2, 2, 2, 2);
  // ConvNet.3  Conv 32->64, k=3, p=1
  h = conv_bias_relu(ctx, W, h, "FeatureExtraction.ConvNet.3", 1);
  // ConvNet.5  MaxPool(2, 2)
  h = maxpool(ctx, h, 2, 2, 2, 2);
  // ConvNet.6  Conv 64->128, k=3, p=1
  h = conv_bias_relu(ctx, W, h, "FeatureExtraction.ConvNet.6", 1);
  // ConvNet.8  Conv 128->128, k=3, p=1
  h = conv_bias_relu(ctx, W, h, "FeatureExtraction.ConvNet.8", 1);
  // ConvNet.10 MaxPool((2,1), (2,1)) — height /2, width unchanged
  h = maxpool(ctx, h, /*k0=*/1, /*k1=*/2, /*s0=*/1, /*s1=*/2);
  // ConvNet.11 Conv 128->256 (BN-folded) + ReLU
  h = conv_bias_relu(ctx, W, h, "FeatureExtraction.ConvNet.11", 1);
  // ConvNet.14 Conv 256->256 (BN-folded) + ReLU
  h = conv_bias_relu(ctx, W, h, "FeatureExtraction.ConvNet.14", 1);
  // ConvNet.17 MaxPool((2,1), (2,1)) — height /2, width unchanged
  h = maxpool(ctx, h, /*k0=*/1, /*k1=*/2, /*s0=*/1, /*s1=*/2);
  // ConvNet.18 Conv 256->256, k=2, s=1, p=0  (shrinks H and W by 1 each)
  h = conv_bias_relu(ctx, W, h, "FeatureExtraction.ConvNet.18", 0);
  tap(taps, crnn_taps::kVisual, h); // ggml ne [W'=W/4-1, H'=3, 256, 1]

  // ============== AdaptiveAvgPool((None,1)) + permute + squeeze =========
  // PyTorch:
  //   v = visual.permute(0, 3, 1, 2)         # [B, W, C, H]
  //   v = AdaptiveAvgPool2d((None,1))(v)     # pool last dim to 1: [B, W, C, 1]
  //   v = v.squeeze(3)                       # [B, W, C]
  // Equivalent: take the mean across the original H axis:
  //   v = visual.mean(dim=2)                 # [B, C, W]
  //   v = v.permute(0, 2, 1)                 # [B, W, C]
  //
  // In ggml ne, `visual` is [W', H', C, 1].  Pooling avg over H' to size 1
  // is exactly what ggml_pool_2d AVG with k=H' does on the (W', H') axes.
  {
    const int64_t Hp = h->ne[1]; // H' (== 3 for the canonical input)
    // ggml_pool_2d kernel acts on the (ne0, ne1) axes — width then height.
    // We want to keep ne0 (== W') intact (k0=1, s0=1) and pool ne1 to 1
    // (k1=H', s1=H').
    h = ggml_pool_2d(
        ctx,
        h,
        GGML_OP_POOL_AVG,
        /*k0=*/1,
        /*k1=*/static_cast<int>(Hp),
        /*s0=*/1,
        /*s1=*/static_cast<int>(Hp),
        /*p0=*/0.0F,
        /*p1=*/0.0F);
    // h is now ne [W', 1, 256, N].  Reshape to the sequence layout
    // [256, W', N] (== ggml ne for PyTorch [N, W', 256], i.e. [N, T, C]),
    // preserving the batch axis N so the LSTM runs over all sequences at once
    // (QVAC-19796). N==1 yields the original [256, W'] sequence.
    const int64_t Wp = h->ne[0]; // W' (== T)
    const int64_t C = h->ne[2];  // 256
    const int64_t Nb = h->ne[3]; // batch N
    // Permute (W', 1, C, N) -> (C, W', N, 1) so the per-timestep features are
    // on ne[0].  ggml_permute uses `result.ne[axis[i]] = a.ne[i]`.
    h = ggml_permute(
        ctx,
        h,
        /*axis0=*/1,                     // W' -> ne[1]
        /*axis1=*/3,                     // size-1 -> ne[3]
        /*axis2=*/0,                     // C -> ne[0]
        /*axis3=*/2);                    // N -> ne[2]
    h = ggml_cont_3d(ctx, h, C, Wp, Nb); // -> ne [C=256, T=W', N]
  }
  tap(taps, crnn_taps::kSequence, h);

  // ============== SequenceModeling: 2x BidirectionalLSTM =================
  h = bilstm_block(ctx, W, h, "SequenceModeling.0");
  tap(taps, crnn_taps::kBilstm0, h);
  h = bilstm_block(ctx, W, h, "SequenceModeling.1");
  tap(taps, crnn_taps::kBilstm1, h);

  // ============== Prediction: Linear(256, 97) ===========================
  auto* W_pred = W.w("Prediction");            // ggml ne [256, 97]
  auto* b_pred = W.b("Prediction");            // [97]
  auto* logits = ggml_mul_mat(ctx, W_pred, h); // ggml ne [97, T]
  {
    auto* b_2d = ggml_reshape_2d(ctx, b_pred, b_pred->ne[0], 1);
    logits = ggml_add(ctx, logits, ggml_repeat(ctx, b_2d, logits));
  }
  tap(taps, crnn_taps::kLogits, logits);
  return logits;
}

} // namespace easyocr::ggml

// NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,readability-identifier-naming,readability-identifier-length)
