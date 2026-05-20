#include "crnn.hpp"

#include <cassert>
#include <string>
#include <vector>

#include "crnn_weights.hpp"
#include "ggml.h"
#include "ops.hpp"

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
      /*d1=*/1);
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
// State per direction: a hidden vector h and cell vector c, both of shape
// [hidden] (ggml ne [hidden]).  We materialize the `(W_ih @ x_t) + b_ih` part
// for the entire sequence in a single matmul (call it `Wx`, ggml ne
// [4*hidden, T]) before the time-step loop, and per-step we add the
// `(W_hh @ h_{t-1}) + b_hh` contribution.

// Apply one LSTM cell timestep.  All inputs are [hidden] (ggml ne [hidden]).
// Returns a struct { h_new, c_new }.
struct LstmStep {
  ggml_tensor* h;
  ggml_tensor* c;
};

LstmStep lstm_cell_step(
    ggml_context* ctx,
    ggml_tensor* gates_x_t, // [4*hidden]   = W_ih·x_t + b_ih
    ggml_tensor* W_hh,      // ggml ne [hidden, 4*hidden]
    ggml_tensor* b_hh,      // [4*hidden]
    ggml_tensor* h_prev,    // [hidden]
    ggml_tensor* c_prev) {  // [hidden]
  const int64_t hidden = h_prev->ne[0];

  // gates = gates_x_t + W_hh·h_prev + b_hh
  auto* gates = ggml_mul_mat(ctx, W_hh, h_prev); // ggml ne [4*hidden]
  gates = ggml_add(ctx, gates, gates_x_t);
  gates = ggml_add(ctx, gates, b_hh);

  // Split into 4 [hidden] gates.  PyTorch's gate ordering is i, f, g, o.
  auto slice = [&](int64_t k) {
    return ggml_view_1d(
        ctx, gates, hidden, static_cast<size_t>(k * hidden) * sizeof(float));
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
ggml_tensor* lstm_one_direction(
    ggml_context* ctx,
    ggml_tensor* seq,  // ggml ne [input, T]
    ggml_tensor* W_ih, // ggml ne [input, 4*hidden]
    ggml_tensor* W_hh, // ggml ne [hidden, 4*hidden]
    ggml_tensor* b_ih, // [4*hidden]
    ggml_tensor* b_hh, // [4*hidden]
    bool reverse) {
  const int64_t T = seq->ne[1];
  const int64_t hidden4 = W_ih->ne[1];
  const int64_t hidden = hidden4 / 4;

  // Full-sequence input projection: Wx[4h, T] = W_ih · seq[input, T] + b_ih
  // We add b_ih once via repeat-broadcast across T.
  auto* Wx = ggml_mul_mat(ctx, W_ih, seq); // ne [4h, T]
  {
    auto* b_ih_2d = ggml_reshape_2d(ctx, b_ih, hidden4, 1); // ne [4h, 1]
    Wx = ggml_add(ctx, Wx, ggml_repeat(ctx, b_ih_2d, Wx));
  }

  // Initial states: zeros.  Allocate a ones-like and zero-out via mul(0).
  // Cleaner: declare a fresh tensor in ctx and let the gallocr zero it
  // implicitly... but ggml does NOT auto-zero scratch.  We use a small
  // trick: Wx[:, 0] - Wx[:, 0] gives a zero vector of the right shape.
  auto* zero1d = ggml_view_1d(ctx, Wx, hidden, /*offset=*/0);
  zero1d = ggml_sub(ctx, zero1d, zero1d); // [hidden] zeros

  ggml_tensor* h_prev = zero1d;
  ggml_tensor* c_prev = zero1d;

  // h_t outputs collected via concat.
  ggml_tensor* out = nullptr;

  auto step_iter = [&](int64_t t) {
    // gates_x_t = view of Wx column t
    auto* gates_x_t =
        ggml_view_1d(ctx, Wx, hidden4, static_cast<size_t>(t * Wx->nb[1]));
    // ggml_view_1d's offset is in bytes; nb[1] is the stride between
    // columns (bytes per row * rows == bytes per column in 2D).

    auto step = lstm_cell_step(ctx, gates_x_t, W_hh, b_hh, h_prev, c_prev);
    h_prev = step.h;
    c_prev = step.c;

    // Reshape h_prev to [hidden, 1] so we can concat along T.
    auto* h_col = ggml_reshape_2d(ctx, h_prev, hidden, 1);

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
    for (int64_t t = T - 1; t >= 0; --t)
      step_iter(t);
  } else {
    for (int64_t t = 0; t < T; ++t)
      step_iter(t);
  }
  return out; // ggml ne [hidden, T]
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
    // h is now ne [W', 1, 256, 1].  Squeeze the size-1 dim by reshaping
    // to [256, W'] (== ggml ne for PyTorch [W', 256], i.e. [T, C]).
    const int64_t Wp = h->ne[0];
    const int64_t C = h->ne[2];
    // Permute (W', 1, C, 1) -> (C, W', 1, 1) so the per-timestep features
    // are on ne[0].  ggml_permute uses `result.ne[axis[i]] = a.ne[i]`.
    h = ggml_permute(
        ctx,
        h,
        /*axis0=*/1,                 // W' -> ne[1]
        /*axis1=*/3,                 // size-1 -> ne[3]
        /*axis2=*/0,                 // C -> ne[0]
        /*axis3=*/2);                // size-1 -> ne[2]
    h = ggml_cont_2d(ctx, h, C, Wp); // -> ne [C=256, T=W']
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
