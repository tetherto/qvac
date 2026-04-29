// Diagnostic test for ggml_flash_attn_ext correctness against the unfused
// path (ggml_mul_mat → soft_max_ext → ggml_mul_mat(transpose(V), …)).
//
// We instantiate one attention block with the same shapes used in the
// SmolLM2 prefill (head_dim=64, num_heads=15, num_kv_heads=5) at a small
// seq_len, drive both paths from the same deterministic Q/K/V/mask
// inputs, and compare element-wise. By trying several flavours of the
// flash-attn call we can pinpoint the layout mistake in one run.

#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <random>
#include <vector>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <ggml.h>

namespace {

constexpr int kHeadDim = 64;
constexpr int kNumHeads = 15;
constexpr int kNumKvHeads = 5;
constexpr int kSeqLen = 8; // small — keeps the test fast

// Pads kSeqLen up to GGML_KQ_MASK_PAD for ggml_flash_attn_ext.
constexpr int kSeqLenPad = ((kSeqLen + GGML_KQ_MASK_PAD - 1) /
                            GGML_KQ_MASK_PAD) *
                           GGML_KQ_MASK_PAD;

struct AttnInputs {
  std::vector<float> q; // (head_dim, num_heads, seq_len) ggml ne[]
  std::vector<float> k; // (head_dim, num_kv_heads, seq_len)
  std::vector<float> v; // (head_dim, num_kv_heads, seq_len)
  std::vector<float> mask_unfused; // (seq_len, seq_len)
  std::vector<float> mask_fa;      // (seq_len, GGML_PAD(seq_len, 64))
};

AttnInputs make_inputs() {
  AttnInputs in;
  in.q.resize(kHeadDim * kNumHeads * kSeqLen);
  in.k.resize(kHeadDim * kNumKvHeads * kSeqLen);
  in.v.resize(kHeadDim * kNumKvHeads * kSeqLen);
  in.mask_unfused.resize(kSeqLen * kSeqLen, 0.0f);
  in.mask_fa.resize(kSeqLen * kSeqLenPad, 0.0f);

  std::mt19937 rng(0x5eed);
  std::normal_distribution<float> nd(0.0f, 1.0f);
  for (auto& x : in.q) x = nd(rng);
  for (auto& x : in.k) x = nd(rng);
  for (auto& x : in.v) x = nd(rng);

  // Causal mask: position i can only attend to positions ≤ i.
  for (int qi = 0; qi < kSeqLen; qi++) {
    for (int ki = 0; ki < kSeqLen; ki++) {
      const float v = (ki <= qi) ? 0.0f : -1e9f;
      in.mask_unfused[qi * kSeqLen + ki] = v;
      in.mask_fa[qi * kSeqLen + ki] = v; // ne0 = kSeqLen, ne1 = padded
    }
  }
  return in;
}

// Pack a single inference graph + run on CPU, return the output as a flat
// host-side vector with logical shape (head_dim*num_heads, seq_len).
std::vector<float>
run_graph(struct ggml_cgraph* gf, ggml_backend_t backend,
          struct ggml_tensor* out_tensor) {
  ggml_gallocr_t allocr =
      ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend));
  ggml_gallocr_reserve(allocr, gf);
  ggml_gallocr_alloc_graph(allocr, gf);
  return std::vector<float>{}; // unused — caller does compute + read back
}

// ----------------------------------------------------------------------------
// Reference: unfused attention with explicit GQA repeat (matches what the
// production code does today inside build_transformer_layer).
// ----------------------------------------------------------------------------
struct ggml_tensor* build_unfused(
    struct ggml_context* ctx, struct ggml_tensor* q, struct ggml_tensor* k,
    struct ggml_tensor* v, struct ggml_tensor* mask) {
  const int kv_groups = kNumHeads / kNumKvHeads;

  // GQA repeat
  struct ggml_tensor* k_exp =
      ggml_reshape_4d(ctx, k, kHeadDim, 1, kNumKvHeads, kSeqLen);
  k_exp = ggml_repeat(
      ctx, k_exp,
      ggml_new_tensor_4d(
          ctx, k->type, kHeadDim, kv_groups, kNumKvHeads, kSeqLen));
  k_exp = ggml_reshape_3d(ctx, k_exp, kHeadDim, kNumHeads, kSeqLen);

  struct ggml_tensor* v_exp =
      ggml_reshape_4d(ctx, v, kHeadDim, 1, kNumKvHeads, kSeqLen);
  v_exp = ggml_repeat(
      ctx, v_exp,
      ggml_new_tensor_4d(
          ctx, v->type, kHeadDim, kv_groups, kNumKvHeads, kSeqLen));
  v_exp = ggml_reshape_3d(ctx, v_exp, kHeadDim, kNumHeads, kSeqLen);

  struct ggml_tensor* q_p = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  struct ggml_tensor* k_p =
      ggml_cont(ctx, ggml_permute(ctx, k_exp, 0, 2, 1, 3));
  struct ggml_tensor* v_p =
      ggml_cont(ctx, ggml_permute(ctx, v_exp, 0, 2, 1, 3));

  struct ggml_tensor* attn = ggml_mul_mat(ctx, k_p, q_p);
  attn = ggml_soft_max_ext(
      ctx, attn, mask, 1.0f / sqrtf((float)kHeadDim), 0.0f);

  struct ggml_tensor* attn_out = ggml_mul_mat(
      ctx, ggml_cont(ctx, ggml_transpose(ctx, v_p)), attn);
  attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
  attn_out = ggml_reshape_2d(ctx, attn_out, kNumHeads * kHeadDim, kSeqLen);
  return attn_out;
}

// ----------------------------------------------------------------------------
// Variants of the flash_attn call. Each builds Q/K/V in flash-attn layout
// (head_dim, seq, n_head*) then differs in how it handles the result.
// ----------------------------------------------------------------------------

// V0 — what production code attempted: cont + reshape_2d.
struct ggml_tensor* build_fa_v0_cont_reshape(
    struct ggml_context* ctx, struct ggml_tensor* q, struct ggml_tensor* k,
    struct ggml_tensor* v, struct ggml_tensor* mask) {
  struct ggml_tensor* q_fa = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  struct ggml_tensor* k_fa = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  struct ggml_tensor* v_fa = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));
  struct ggml_tensor* out = ggml_flash_attn_ext(
      ctx, q_fa, k_fa, v_fa, mask, 1.0f / sqrtf((float)kHeadDim), 0.0f, 0.0f);
  out = ggml_cont(ctx, out);
  out = ggml_reshape_2d(ctx, out, kNumHeads * kHeadDim, kSeqLen);
  return out;
}

// V1 — llama.cpp's pattern: reshape_2d directly (no preceding cont).
struct ggml_tensor* build_fa_v1_direct_reshape(
    struct ggml_context* ctx, struct ggml_tensor* q, struct ggml_tensor* k,
    struct ggml_tensor* v, struct ggml_tensor* mask) {
  struct ggml_tensor* q_fa = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  struct ggml_tensor* k_fa = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  struct ggml_tensor* v_fa = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));
  struct ggml_tensor* out = ggml_flash_attn_ext(
      ctx, q_fa, k_fa, v_fa, mask, 1.0f / sqrtf((float)kHeadDim), 0.0f, 0.0f);
  out = ggml_reshape_2d(ctx, out, kNumHeads * kHeadDim, kSeqLen);
  return out;
}

// V2 — permute(0, 2, 1, 3) the result before reshape (in case the
// "permuted" comment in ggml.h actually means the result has logical shape
// (head_dim, n_head, n_batch) but is physically (head_dim, n_batch, n_head)
// and we need to swap dims 1/2 explicitly for the reshape to be valid).
struct ggml_tensor* build_fa_v2_permute_213(
    struct ggml_context* ctx, struct ggml_tensor* q, struct ggml_tensor* k,
    struct ggml_tensor* v, struct ggml_tensor* mask) {
  struct ggml_tensor* q_fa = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  struct ggml_tensor* k_fa = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  struct ggml_tensor* v_fa = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));
  struct ggml_tensor* out = ggml_flash_attn_ext(
      ctx, q_fa, k_fa, v_fa, mask, 1.0f / sqrtf((float)kHeadDim), 0.0f, 0.0f);
  out = ggml_cont(ctx, ggml_permute(ctx, out, 0, 2, 1, 3));
  out = ggml_reshape_2d(ctx, out, kNumHeads * kHeadDim, kSeqLen);
  return out;
}

// V3 — set higher precision (matches llama.cpp), still cont+reshape.
struct ggml_tensor* build_fa_v3_prec_f32(
    struct ggml_context* ctx, struct ggml_tensor* q, struct ggml_tensor* k,
    struct ggml_tensor* v, struct ggml_tensor* mask) {
  struct ggml_tensor* q_fa = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  struct ggml_tensor* k_fa = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  struct ggml_tensor* v_fa = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));
  struct ggml_tensor* out = ggml_flash_attn_ext(
      ctx, q_fa, k_fa, v_fa, mask, 1.0f / sqrtf((float)kHeadDim), 0.0f, 0.0f);
  ggml_flash_attn_ext_set_prec(out, GGML_PREC_F32);
  out = ggml_cont(ctx, out);
  out = ggml_reshape_2d(ctx, out, kNumHeads * kHeadDim, kSeqLen);
  return out;
}

// V4 — F16 mask (matches llama.cpp's KQ mask dtype).
struct ggml_tensor* build_fa_v4_f16_mask(
    struct ggml_context* ctx, struct ggml_tensor* q, struct ggml_tensor* k,
    struct ggml_tensor* v, struct ggml_tensor* mask_f16) {
  struct ggml_tensor* q_fa = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  struct ggml_tensor* k_fa = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  struct ggml_tensor* v_fa = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));
  struct ggml_tensor* out = ggml_flash_attn_ext(
      ctx, q_fa, k_fa, v_fa, mask_f16,
      1.0f / sqrtf((float)kHeadDim), 0.0f, 0.0f);
  ggml_flash_attn_ext_set_prec(out, GGML_PREC_F32);
  out = ggml_cont(ctx, out);
  out = ggml_reshape_2d(ctx, out, kNumHeads * kHeadDim, kSeqLen);
  return out;
}

float max_abs_diff(
    const std::vector<float>& a, const std::vector<float>& b) {
  EXPECT_EQ(a.size(), b.size()) << "size mismatch";
  float m = 0.0f;
  for (size_t i = 0; i < a.size() && i < b.size(); i++) {
    const float d = std::fabs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

float cos_sim(const std::vector<float>& a, const std::vector<float>& b) {
  double dot = 0, na = 0, nb = 0;
  const size_t n = std::min(a.size(), b.size());
  for (size_t i = 0; i < n; i++) {
    dot += (double)a[i] * b[i];
    na += (double)a[i] * a[i];
    nb += (double)b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0.0f;
  return (float)(dot / (std::sqrt(na) * std::sqrt(nb)));
}

// Helper: build a fresh graph that produces the given builder's output and
// run it on the CPU backend. Returns the output as a flat host vector
// (size = num_heads * head_dim * seq_len).
std::vector<float> run_variant(
    AttnInputs& in,
    struct ggml_tensor* (*builder)(
        struct ggml_context*, struct ggml_tensor*, struct ggml_tensor*,
        struct ggml_tensor*, struct ggml_tensor*),
    bool use_padded_mask, ggml_backend_t backend) {
  // Big enough for the small synthetic attention graph
  const size_t buf_size = 32 * 1024 * 1024;
  std::vector<uint8_t> buf(buf_size);
  struct ggml_init_params params = {buf_size, buf.data(), true};
  struct ggml_context* ctx = ggml_init(params);
  struct ggml_cgraph* gf = ggml_new_graph_custom(ctx, 1024, false);

  struct ggml_tensor* q =
      ggml_new_tensor_3d(ctx, GGML_TYPE_F32, kHeadDim, kNumHeads, kSeqLen);
  struct ggml_tensor* k =
      ggml_new_tensor_3d(ctx, GGML_TYPE_F32, kHeadDim, kNumKvHeads, kSeqLen);
  struct ggml_tensor* v =
      ggml_new_tensor_3d(ctx, GGML_TYPE_F32, kHeadDim, kNumKvHeads, kSeqLen);
  struct ggml_tensor* mask;
  if (use_padded_mask) {
    mask = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, kSeqLen, kSeqLenPad);
  } else {
    mask = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, kSeqLen, kSeqLen);
  }
  ggml_set_input(q);
  ggml_set_input(k);
  ggml_set_input(v);
  ggml_set_input(mask);

  struct ggml_tensor* out = builder(ctx, q, k, v, mask);
  ggml_set_output(out);
  ggml_build_forward_expand(gf, out);

  ggml_gallocr_t allocr =
      ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend));
  ggml_gallocr_reserve(allocr, gf);
  ggml_gallocr_alloc_graph(allocr, gf);

  ggml_backend_tensor_set(q, in.q.data(), 0, in.q.size() * sizeof(float));
  ggml_backend_tensor_set(k, in.k.data(), 0, in.k.size() * sizeof(float));
  ggml_backend_tensor_set(v, in.v.data(), 0, in.v.size() * sizeof(float));
  if (use_padded_mask) {
    ggml_backend_tensor_set(
        mask, in.mask_fa.data(), 0, in.mask_fa.size() * sizeof(float));
  } else {
    ggml_backend_tensor_set(
        mask,
        in.mask_unfused.data(),
        0,
        in.mask_unfused.size() * sizeof(float));
  }

  ggml_backend_graph_compute(backend, gf);

  std::vector<float> result(kNumHeads * kHeadDim * kSeqLen);
  ggml_backend_tensor_get(
      out, result.data(), 0, result.size() * sizeof(float));

  ggml_gallocr_free(allocr);
  ggml_free(ctx);
  return result;
}

// V4 needs an F16 mask, which the generic helper above can't emit — handle
// it with a dedicated runner.
std::vector<float> run_variant_v4(AttnInputs& in, ggml_backend_t backend) {
  const size_t buf_size = 32 * 1024 * 1024;
  std::vector<uint8_t> buf(buf_size);
  struct ggml_init_params params = {buf_size, buf.data(), true};
  struct ggml_context* ctx = ggml_init(params);
  struct ggml_cgraph* gf = ggml_new_graph_custom(ctx, 1024, false);

  struct ggml_tensor* q =
      ggml_new_tensor_3d(ctx, GGML_TYPE_F32, kHeadDim, kNumHeads, kSeqLen);
  struct ggml_tensor* k =
      ggml_new_tensor_3d(ctx, GGML_TYPE_F32, kHeadDim, kNumKvHeads, kSeqLen);
  struct ggml_tensor* v =
      ggml_new_tensor_3d(ctx, GGML_TYPE_F32, kHeadDim, kNumKvHeads, kSeqLen);
  struct ggml_tensor* mask_f32 =
      ggml_new_tensor_2d(ctx, GGML_TYPE_F32, kSeqLen, kSeqLenPad);
  ggml_set_input(q);
  ggml_set_input(k);
  ggml_set_input(v);
  ggml_set_input(mask_f32);
  // F16 cast happens inside the graph
  struct ggml_tensor* mask_f16 = ggml_cast(ctx, mask_f32, GGML_TYPE_F16);
  struct ggml_tensor* out = build_fa_v4_f16_mask(ctx, q, k, v, mask_f16);
  ggml_set_output(out);
  ggml_build_forward_expand(gf, out);

  ggml_gallocr_t allocr =
      ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend));
  ggml_gallocr_reserve(allocr, gf);
  ggml_gallocr_alloc_graph(allocr, gf);

  ggml_backend_tensor_set(q, in.q.data(), 0, in.q.size() * sizeof(float));
  ggml_backend_tensor_set(k, in.k.data(), 0, in.k.size() * sizeof(float));
  ggml_backend_tensor_set(v, in.v.data(), 0, in.v.size() * sizeof(float));
  ggml_backend_tensor_set(
      mask_f32, in.mask_fa.data(), 0, in.mask_fa.size() * sizeof(float));

  ggml_backend_graph_compute(backend, gf);

  std::vector<float> result(kNumHeads * kHeadDim * kSeqLen);
  ggml_backend_tensor_get(
      out, result.data(), 0, result.size() * sizeof(float));

  ggml_gallocr_free(allocr);
  ggml_free(ctx);
  return result;
}

} // namespace

TEST(SmolvlaFlashAttn, MatchesUnfusedReference) {
  ggml_backend_t backend = ggml_backend_cpu_init();
  ASSERT_NE(backend, nullptr);

  auto in = make_inputs();
  const auto ref = run_variant(in, build_unfused, /*pad=*/false, backend);

  struct V {
    const char* name;
    std::vector<float> out;
    bool padded_mask;
  };
  std::vector<V> variants;

  variants.push_back({
      "v0_cont_reshape",
      run_variant(in, build_fa_v0_cont_reshape, /*pad=*/true, backend),
      true,
  });
  variants.push_back({
      "v1_direct_reshape",
      run_variant(in, build_fa_v1_direct_reshape, /*pad=*/true, backend),
      true,
  });
  variants.push_back({
      "v2_permute_213",
      run_variant(in, build_fa_v2_permute_213, /*pad=*/true, backend),
      true,
  });
  variants.push_back({
      "v3_prec_f32",
      run_variant(in, build_fa_v3_prec_f32, /*pad=*/true, backend),
      true,
  });
  variants.push_back({
      "v4_f16_mask",
      run_variant_v4(in, backend),
      true,
  });

  std::printf("\n[flash-attn diag] reference (unfused) — first 6 values: ");
  for (int i = 0; i < 6; i++) std::printf("%.4f ", ref[i]);
  std::printf("\n");

  bool any_match = false;
  for (const auto& v : variants) {
    const float md = max_abs_diff(ref, v.out);
    const float cs = cos_sim(ref, v.out);
    std::printf("[flash-attn diag] %-22s  max|Δ|=%.6f  cos=%.6f\n",
                v.name, md, cs);
    if (md < 1e-3f) any_match = true;
  }

  ggml_backend_free(backend);

  EXPECT_TRUE(any_match)
      << "No flash_attn_ext variant matched the unfused reference. "
         "Layout for the result tensor needs further investigation.";
}
