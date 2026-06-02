// M3.5 parity test: one Gemma-1 VLM block.
//
// Strategy:
//   * Use `vlm.prefix_concat` from the dump as the block input (so the
//     test is independent of M3.1/M3.3/M3.4 — pure block-only parity).
//   * Slice to the 832 *valid* prefix positions (768 image + 64 text)
//     to skip mask construction. Padded queries' outputs are garbage
//     in PyTorch too; cutting them out keeps the comparison clean.
//   * Compare the block's output to `vlm.blk_0.ffn_out` over those
//     valid rows.

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include <gguf.h>
#include <ggml.h>
#include <ggml-cpu.h>

#include "model-interface/pi05.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

constexpr int PREFIX_LEN_FULL = 968;        // 3*256 + 200
constexpr int VLM_HIDDEN = 2048;
constexpr int VLM_N_HEADS = 8;
constexpr int VLM_N_KV_HEADS = 1;
constexpr int VLM_HEAD_DIM = 256;
constexpr float VLM_RMS_EPS = 1e-6f;
constexpr float VLM_ROPE_BASE = 10000.0f;

// 3 cameras × 256 patches all valid + 64 valid text tokens
// = 768 + 64 = 832. The remaining 136 positions are padded.
constexpr int VALID_PREFIX_LEN = 832;

const char* envOrNull(const char* name) {
  const char* v = std::getenv(name);
  return (v != nullptr && v[0] != '\0') ? v : nullptr;
}

float cosineSim(const float* a, const float* b, size_t n) {
  double dot = 0.0;
  double na = 0.0;
  double nb = 0.0;
  for (size_t i = 0; i < n; ++i) {
    dot += static_cast<double>(a[i]) * static_cast<double>(b[i]);
    na += static_cast<double>(a[i]) * static_cast<double>(a[i]);
    nb += static_cast<double>(b[i]) * static_cast<double>(b[i]);
  }
  const double denom = std::sqrt(na) * std::sqrt(nb);
  return denom > 0.0 ? static_cast<float>(dot / denom) : 0.0f;
}

float maxAbsDiff(const float* a, const float* b, size_t n) {
  float m = 0.0f;
  for (size_t i = 0; i < n; ++i) {
    const float d = std::fabs(a[i] - b[i]);
    if (d > m) {
      m = d;
    }
  }
  return m;
}

struct ggml_tensor* mustGet(struct ggml_context* ctx, const char* name) {
  struct ggml_tensor* t = ggml_get_tensor(ctx, name);
  if (t == nullptr) {
    ADD_FAILURE() << "tensor missing from GGUF: " << name;
  }
  return t;
}

} // namespace

TEST(Pi05M3_5, VlmBlock0MatchesPytorchOverValidPrefix) {
  const char* gguf_path = envOrNull("PI05_TEST_GGUF");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (gguf_path == nullptr || activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_GGUF and PI05_TEST_ACTIVATIONS to "
                    "run the M3.5 parity test.";
  }

  // ── 1. Input + expected output from the PyTorch reference. ─────────────────
  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(activations.open(activations_path));
  const std::vector<float> prefix =
      activations.readF32("vlm.prefix_concat");
  const std::vector<float> expected =
      activations.readF32("vlm.blk_0.ffn_out");
  ASSERT_EQ(prefix.size(),
            static_cast<size_t>(PREFIX_LEN_FULL * VLM_HIDDEN));
  ASSERT_EQ(expected.size(),
            static_cast<size_t>(PREFIX_LEN_FULL * VLM_HIDDEN));

  // ── 2. Load block-0 weights from the GGUF. ────────────────────────────
  struct ggml_context* ctx_w = nullptr;
  struct gguf_init_params gguf_params{};
  gguf_params.no_alloc = false;
  gguf_params.ctx = &ctx_w;
  struct gguf_context* gguf = gguf_init_from_file(gguf_path, gguf_params);
  ASSERT_NE(gguf, nullptr);
  ASSERT_NE(ctx_w, nullptr);

  qvac_lib_infer_vla_ggml::Pi05GemmaBlockWeights bw{};
  bw.pre_attn_norm_scale = mustGet(ctx_w, "vlm.blk.0.pre_attn_norm.scale");
  bw.attn_q_w = mustGet(ctx_w, "vlm.blk.0.attn.q.weight");
  bw.attn_k_w = mustGet(ctx_w, "vlm.blk.0.attn.k.weight");
  bw.attn_v_w = mustGet(ctx_w, "vlm.blk.0.attn.v.weight");
  bw.attn_o_w = mustGet(ctx_w, "vlm.blk.0.attn.o.weight");
  bw.pre_ffw_norm_scale = mustGet(ctx_w, "vlm.blk.0.pre_ffw_norm.scale");
  bw.mlp_gate_w = mustGet(ctx_w, "vlm.blk.0.mlp.gate.weight");
  bw.mlp_up_w = mustGet(ctx_w, "vlm.blk.0.mlp.up.weight");
  bw.mlp_down_w = mustGet(ctx_w, "vlm.blk.0.mlp.down.weight");
  if (::testing::Test::HasFailure()) {
    gguf_free(gguf);
    ggml_free(ctx_w);
    FAIL() << "one or more block-0 tensors missing from GGUF";
  }

  // ── 3. Build the M3.5 graph. ─────────────────────────────────────────
  const size_t graph_ctx_mem = 1u * 1024u * 1024u * 1024u; // 1 GiB
  std::vector<uint8_t> graph_mem(graph_ctx_mem);
  struct ggml_init_params gp{
      /*.mem_size   =*/graph_ctx_mem,
      /*.mem_buffer =*/graph_mem.data(),
      /*.no_alloc   =*/false,
  };
  struct ggml_context* ctx_g = ggml_init(gp);
  ASSERT_NE(ctx_g, nullptr);

  // Slice prefix to first VALID_PREFIX_LEN rows: ne=[hidden, 832].
  struct ggml_tensor* x = ggml_new_tensor_2d(
      ctx_g, GGML_TYPE_F32, VLM_HIDDEN, VALID_PREFIX_LEN);
  std::memcpy(x->data, prefix.data(),
              VALID_PREFIX_LEN * VLM_HIDDEN * sizeof(float));

  // Positions = [0, 1, ..., 831].
  struct ggml_tensor* pos = ggml_new_tensor_1d(
      ctx_g, GGML_TYPE_I32, VALID_PREFIX_LEN);
  std::vector<int32_t> pos_data(VALID_PREFIX_LEN);
  for (int i = 0; i < VALID_PREFIX_LEN; ++i) {
    pos_data[i] = i;
  }
  std::memcpy(pos->data, pos_data.data(),
              VALID_PREFIX_LEN * sizeof(int32_t));

  using qvac_lib_infer_vla_ggml::pi05BuildGemmaVlmBlockGraph;
  struct ggml_tensor* out = pi05BuildGemmaVlmBlockGraph(
      ctx_g, x, pos, /*attn_mask=*/nullptr, bw,
      VLM_HIDDEN, VLM_N_HEADS, VLM_N_KV_HEADS, VLM_HEAD_DIM,
      VALID_PREFIX_LEN, VLM_RMS_EPS, VLM_ROPE_BASE);
  ASSERT_NE(out, nullptr);

  struct ggml_cgraph* gf = ggml_new_graph_custom(
      ctx_g, /*size=*/4096, /*grads=*/false);
  ggml_build_forward_expand(gf, out);
  ASSERT_EQ(ggml_graph_compute_with_ctx(ctx_g, gf, /*n_threads=*/4),
            GGML_STATUS_SUCCESS);

  // ── 4. Compare against the first VALID_PREFIX_LEN rows of
  //       vlm.blk_0.ffn_out. ───────────────────────────────────────────
  ASSERT_EQ(ggml_nelements(out),
            static_cast<int64_t>(VALID_PREFIX_LEN * VLM_HIDDEN));
  const float* got = static_cast<const float*>(out->data);
  const size_t cmp_n = static_cast<size_t>(VALID_PREFIX_LEN * VLM_HIDDEN);

  const float cos = cosineSim(got, expected.data(), cmp_n);
  const float diff = maxAbsDiff(got, expected.data(), cmp_n);

  float max_abs_expected = 0.0f;
  double sum_sq_diff = 0.0;
  for (size_t i = 0; i < cmp_n; ++i) {
    const float a = std::fabs(expected[i]);
    if (a > max_abs_expected) {
      max_abs_expected = a;
    }
    const double d = static_cast<double>(got[i]) - expected[i];
    sum_sq_diff += d * d;
  }
  const float rms_diff =
      static_cast<float>(std::sqrt(sum_sq_diff / cmp_n));
  std::cerr << "[M3.5] vlm.blk_0.ffn_out (valid prefix=" << VALID_PREFIX_LEN
            << "): cos=" << cos
            << " max_abs_diff=" << diff
            << " rms_diff=" << rms_diff
            << " max_abs_expected=" << max_abs_expected
            << " rel_max=" << (diff / std::max(max_abs_expected, 1e-9f))
            << "\n";

  // Q8_0 VLM weights. Observed rel_max ~0.0071 across hardware; bar
  // gives ~2× headroom.
  EXPECT_GT(cos, 0.9999f);
  EXPECT_LT(diff / std::max(max_abs_expected, 1e-9f), 0.015f);

  ggml_free(ctx_g);
  gguf_free(gguf);
  ggml_free(ctx_w);
}
