// M3.6 parity test: full VLM prefill (18 blocks + final RMSNorm).
//
// Same slicing trick as M3.5 — feed `vlm.prefix_concat` truncated to
// the 832 valid positions so the test sidesteps attention masking.
// Compare the post-final-norm output to `vlm.final_out` over the
// same 832 rows.

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include <gguf.h>
#include <ggml.h>
#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>

#include "model-interface/pi05.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

constexpr int PREFIX_LEN_FULL = 968;
constexpr int VALID_PREFIX_LEN = 832;
constexpr int VLM_HIDDEN = 2048;
constexpr int VLM_N_HEADS = 8;
constexpr int VLM_N_KV_HEADS = 1;
constexpr int VLM_HEAD_DIM = 256;
constexpr int VLM_N_LAYERS = 18;
constexpr float VLM_RMS_EPS = 1e-6f;
constexpr float VLM_ROPE_BASE = 10000.0f;

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

qvac_lib_infer_vla_ggml::Pi05GemmaBlockWeights
loadVlmBlock(struct ggml_context* ctx, int i) {
  qvac_lib_infer_vla_ggml::Pi05GemmaBlockWeights bw{};
  const std::string base = "vlm.blk." + std::to_string(i);
  bw.pre_attn_norm_scale = mustGet(ctx, (base + ".pre_attn_norm.scale").c_str());
  bw.attn_q_w = mustGet(ctx, (base + ".attn.q.weight").c_str());
  bw.attn_k_w = mustGet(ctx, (base + ".attn.k.weight").c_str());
  bw.attn_v_w = mustGet(ctx, (base + ".attn.v.weight").c_str());
  bw.attn_o_w = mustGet(ctx, (base + ".attn.o.weight").c_str());
  bw.pre_ffw_norm_scale = mustGet(ctx, (base + ".pre_ffw_norm.scale").c_str());
  bw.mlp_gate_w = mustGet(ctx, (base + ".mlp.gate.weight").c_str());
  bw.mlp_up_w = mustGet(ctx, (base + ".mlp.up.weight").c_str());
  bw.mlp_down_w = mustGet(ctx, (base + ".mlp.down.weight").c_str());
  return bw;
}

} // namespace

TEST(Pi05M3_6, VlmFullPrefillMatchesPytorchOverValidPrefix) {
  const char* gguf_path = envOrNull("PI05_TEST_GGUF");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (gguf_path == nullptr || activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_GGUF and PI05_TEST_ACTIVATIONS to "
                    "run the M3.6 parity test.";
  }

  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(activations.open(activations_path));
  const std::vector<float> prefix =
      activations.readF32("vlm.prefix_concat");
  const std::vector<float> expected =
      activations.readF32("vlm.final_out");
  ASSERT_EQ(prefix.size(),
            static_cast<size_t>(PREFIX_LEN_FULL * VLM_HIDDEN));
  ASSERT_EQ(expected.size(),
            static_cast<size_t>(PREFIX_LEN_FULL * VLM_HIDDEN));

  struct ggml_context* ctx_w = nullptr;
  struct gguf_init_params gguf_params{};
  gguf_params.no_alloc = false;
  gguf_params.ctx = &ctx_w;
  struct gguf_context* gguf = gguf_init_from_file(gguf_path, gguf_params);
  ASSERT_NE(gguf, nullptr);
  ASSERT_NE(ctx_w, nullptr);

  std::vector<qvac_lib_infer_vla_ggml::Pi05GemmaBlockWeights> blocks;
  blocks.reserve(VLM_N_LAYERS);
  for (int i = 0; i < VLM_N_LAYERS; ++i) {
    blocks.push_back(loadVlmBlock(ctx_w, i));
  }
  struct ggml_tensor* final_norm = mustGet(ctx_w, "vlm.final_norm.scale");
  if (::testing::Test::HasFailure()) {
    gguf_free(gguf);
    ggml_free(ctx_w);
    FAIL() << "one or more VLM tensors missing from GGUF";
  }

  // 18 Gemma blocks would blow past 6 GiB if we used ggml's bump
  // allocator (each block's intermediates stay alive until ctx_g is
  // freed). Use the production pattern instead: a no_alloc context
  // for the graph + `ggml_gallocr` which reuses memory across
  // non-simultaneously-live nodes. Same dance as
  // smolvla.cpp::build_staged/alloc_staged_simple/compute_staged.
  const size_t graph_ctx_mem = size_t{32} * 1024 * 1024; // 32 MiB
                                                            // (struct space only)
  std::vector<uint8_t> graph_mem(graph_ctx_mem);
  struct ggml_init_params gp{
      /*.mem_size   =*/graph_ctx_mem,
      /*.mem_buffer =*/graph_mem.data(),
      /*.no_alloc   =*/true,
  };
  struct ggml_context* ctx_g = ggml_init(gp);
  ASSERT_NE(ctx_g, nullptr);

  // Input placeholders — no backing memory yet (no_alloc=true). The
  // gallocr below will assign them buffer space, and we'll memcpy
  // values in after that.
  struct ggml_tensor* x = ggml_new_tensor_2d(
      ctx_g, GGML_TYPE_F32, VLM_HIDDEN, VALID_PREFIX_LEN);
  ggml_set_name(x, "input.prefix");
  struct ggml_tensor* pos = ggml_new_tensor_1d(
      ctx_g, GGML_TYPE_I32, VALID_PREFIX_LEN);
  ggml_set_name(pos, "input.pos");

  using qvac_lib_infer_vla_ggml::pi05BuildVlmPrefillGraph;
  struct ggml_tensor* out = pi05BuildVlmPrefillGraph(
      ctx_g, x, pos, /*attn_mask=*/nullptr, blocks, final_norm,
      VLM_HIDDEN, VLM_N_HEADS, VLM_N_KV_HEADS, VLM_HEAD_DIM,
      VALID_PREFIX_LEN, VLM_RMS_EPS, VLM_ROPE_BASE);
  ASSERT_NE(out, nullptr);

  struct ggml_cgraph* gf = ggml_new_graph_custom(
      ctx_g, /*size=*/32768, /*grads=*/false);
  ggml_build_forward_expand(gf, out);

  // Allocate the graph (inputs + intermediates) onto a CPU backend
  // buffer, with gallocr's memory reuse.
  ggml_backend_t backend = ggml_backend_init_by_type(
      GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
  ASSERT_NE(backend, nullptr);
  ggml_gallocr_t allocr =
      ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend));
  ASSERT_NE(allocr, nullptr);
  ASSERT_TRUE(ggml_gallocr_alloc_graph(allocr, gf));

  // Now that input tensors have backing memory, upload the data.
  std::vector<int32_t> pos_data(VALID_PREFIX_LEN);
  for (int i = 0; i < VALID_PREFIX_LEN; ++i) {
    pos_data[i] = i;
  }
  ggml_backend_tensor_set(x, prefix.data(), 0,
                          VALID_PREFIX_LEN * VLM_HIDDEN * sizeof(float));
  ggml_backend_tensor_set(pos, pos_data.data(), 0,
                          VALID_PREFIX_LEN * sizeof(int32_t));

  ASSERT_EQ(ggml_backend_graph_compute(backend, gf), GGML_STATUS_SUCCESS);

  ASSERT_EQ(ggml_nelements(out),
            static_cast<int64_t>(VALID_PREFIX_LEN * VLM_HIDDEN));
  // out's data lives in the gallocr-backed buffer — read it out via
  // ggml_backend_tensor_get rather than `out->data` directly.
  std::vector<float> got_vec(VALID_PREFIX_LEN * VLM_HIDDEN);
  ggml_backend_tensor_get(out, got_vec.data(), 0,
                          got_vec.size() * sizeof(float));
  const float* got = got_vec.data();
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
  std::cerr << "[M3.6] vlm.final_out (valid prefix=" << VALID_PREFIX_LEN
            << "): cos=" << cos
            << " max_abs_diff=" << diff
            << " rms_diff=" << rms_diff
            << " max_abs_expected=" << max_abs_expected
            << " rel_max=" << (diff / std::max(max_abs_expected, 1e-9f))
            << "\n";

  // 18 blocks of Q8_0 VLM accumulation. Observed cos ~0.9979 and
  // rel_max ~0.755 across hardware; bars give ~2× headroom.
  EXPECT_GT(cos, 0.995f);
  EXPECT_LT(diff / std::max(max_abs_expected, 1e-9f), 1.5f);

  ggml_gallocr_free(allocr);
  ggml_backend_free(backend);
  ggml_free(ctx_g);
  gguf_free(gguf);
  ggml_free(ctx_w);
}
