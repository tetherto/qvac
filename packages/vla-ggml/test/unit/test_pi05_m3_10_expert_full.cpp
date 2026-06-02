// M3.10 parity test: full expert pass for one ODE step.
//
// Chains all 18 expert blocks (joint attn vs per-layer cached VLM K/V)
// + final adaRMSNorm + action_out_proj. Asserts the final hidden state
// against `expert.final_out[t=1.0]` and the projection output against
// `expert.v_t[t=1.0]` from the PyTorch reference.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "model-interface/pi05.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

constexpr int PREFIX_LEN_FULL = 968;
constexpr int VALID_PREFIX_LEN = 832;
constexpr int N_ACT = 50;
constexpr int ACTION_DIM = 32;
constexpr int EXPERT_HIDDEN = 1024;
constexpr int EXPERT_N_HEADS = 8;
constexpr int EXPERT_N_KV_HEADS = 1;
constexpr int EXPERT_HEAD_DIM = 256;
constexpr int EXPERT_N_LAYERS = 18;
constexpr int COND_DIM = 1024;
constexpr float EXPERT_RMS_EPS = 1e-6f;
constexpr float EXPERT_ROPE_BASE = 10000.0f;

const char* envOrNull(const char* name) {
  const char* v = std::getenv(name);
  return (v != nullptr && v[0] != '\0') ? v : nullptr;
}

float cosineSim(const float* a, const float* b, size_t n) {
  double dot = 0.0, na = 0.0, nb = 0.0;
  for (size_t i = 0; i < n; ++i) {
    dot += static_cast<double>(a[i]) * static_cast<double>(b[i]);
    na += static_cast<double>(a[i]) * static_cast<double>(a[i]);
    nb += static_cast<double>(b[i]) * static_cast<double>(b[i]);
  }
  const double d = std::sqrt(na) * std::sqrt(nb);
  return d > 0.0 ? static_cast<float>(dot / d) : 0.0f;
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

qvac_lib_infer_vla_ggml::Pi05ExpertBlockWeights
loadExpertBlock(struct ggml_context* ctx, int i) {
  qvac_lib_infer_vla_ggml::Pi05ExpertBlockWeights bw{};
  const std::string base = "expert.blk." + std::to_string(i);
  bw.pre_attn_ada_w =
      mustGet(ctx, (base + ".pre_attn_norm.ada.weight").c_str());
  bw.pre_attn_ada_b = mustGet(ctx, (base + ".pre_attn_norm.ada.bias").c_str());
  bw.pre_ffw_ada_w = mustGet(ctx, (base + ".pre_ffw_norm.ada.weight").c_str());
  bw.pre_ffw_ada_b = mustGet(ctx, (base + ".pre_ffw_norm.ada.bias").c_str());
  bw.attn_q_w = mustGet(ctx, (base + ".attn.q.weight").c_str());
  bw.attn_k_w = mustGet(ctx, (base + ".attn.k.weight").c_str());
  bw.attn_v_w = mustGet(ctx, (base + ".attn.v.weight").c_str());
  bw.attn_o_w = mustGet(ctx, (base + ".attn.o.weight").c_str());
  bw.mlp_gate_w = mustGet(ctx, (base + ".mlp.gate.weight").c_str());
  bw.mlp_up_w = mustGet(ctx, (base + ".mlp.up.weight").c_str());
  bw.mlp_down_w = mustGet(ctx, (base + ".mlp.down.weight").c_str());
  return bw;
}

} // namespace

TEST(Pi05M3_10, ExpertFullPassMatchesPytorch) {
  const char* gguf_path = envOrNull("PI05_TEST_GGUF");
  const char* fixture_path = envOrNull("PI05_TEST_FIXTURE");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (gguf_path == nullptr || fixture_path == nullptr ||
      activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_GGUF, PI05_TEST_FIXTURE and "
                    "PI05_TEST_ACTIVATIONS to run the M3.10 parity test.";
  }

  // ── 1. Inputs from the dump. ──────────────────────────────────────────
  qvac_vla_safetensors_lite::Reader fixture;
  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(fixture.open(fixture_path));
  ASSERT_NO_THROW(activations.open(activations_path));

  const std::vector<float> noise = fixture.readF32("fixture.noise");
  const std::vector<float> cond_data =
      activations.readF32("expert.cond[t=1.0]");
  const std::vector<float> expected_final =
      activations.readF32("expert.final_out[t=1.0]");
  const std::vector<float> expected_vt =
      activations.readF32("expert.v_t[t=1.0]");

  // Per-layer cached KV. The dump's vlm.kv_cache_full.keys is shape
  // (18, prefix_len=968, n_kv_heads=1, head_dim=256), numpy row-major
  // — same as 18 contiguous blocks of (968*1*256) floats.
  const std::vector<float> kv_keys_all =
      activations.readF32("vlm.kv_cache_full.keys");
  const std::vector<float> kv_vals_all =
      activations.readF32("vlm.kv_cache_full.values");
  const size_t per_layer = static_cast<size_t>(PREFIX_LEN_FULL) *
                           EXPERT_N_KV_HEADS * EXPERT_HEAD_DIM;
  ASSERT_EQ(
      kv_keys_all.size(), static_cast<size_t>(EXPERT_N_LAYERS) * per_layer);
  ASSERT_EQ(
      kv_vals_all.size(), static_cast<size_t>(EXPERT_N_LAYERS) * per_layer);

  // Slice each layer's KV to VALID_PREFIX_LEN rows.
  const size_t per_layer_valid = static_cast<size_t>(VALID_PREFIX_LEN) *
                                 EXPERT_N_KV_HEADS * EXPERT_HEAD_DIM;
  std::vector<std::vector<float>> k_slices(EXPERT_N_LAYERS);
  std::vector<std::vector<float>> v_slices(EXPERT_N_LAYERS);
  for (int L = 0; L < EXPERT_N_LAYERS; ++L) {
    k_slices[L].resize(per_layer_valid);
    v_slices[L].resize(per_layer_valid);
    const float* k_src = kv_keys_all.data() + L * per_layer;
    const float* v_src = kv_vals_all.data() + L * per_layer;
    std::memcpy(k_slices[L].data(), k_src, per_layer_valid * sizeof(float));
    std::memcpy(v_slices[L].data(), v_src, per_layer_valid * sizeof(float));
  }

  // ── 2. GGUF weights. ──────────────────────────────────────────────────
  struct ggml_context* ctx_w = nullptr;
  struct gguf_init_params gguf_params{};
  gguf_params.no_alloc = false;
  gguf_params.ctx = &ctx_w;
  struct gguf_context* gguf = gguf_init_from_file(gguf_path, gguf_params);
  ASSERT_NE(gguf, nullptr);

  struct ggml_tensor* action_in_w = mustGet(ctx_w, "proj.action_in.weight");
  struct ggml_tensor* action_in_b = mustGet(ctx_w, "proj.action_in.bias");
  struct ggml_tensor* action_out_w = mustGet(ctx_w, "proj.action_out.weight");
  struct ggml_tensor* action_out_b = mustGet(ctx_w, "proj.action_out.bias");
  struct ggml_tensor* final_norm_ada_w =
      mustGet(ctx_w, "expert.final_norm.ada.weight");
  struct ggml_tensor* final_norm_ada_b =
      mustGet(ctx_w, "expert.final_norm.ada.bias");

  std::vector<qvac_lib_infer_vla_ggml::Pi05ExpertBlockWeights> blocks;
  blocks.reserve(EXPERT_N_LAYERS);
  for (int i = 0; i < EXPERT_N_LAYERS; ++i) {
    blocks.push_back(loadExpertBlock(ctx_w, i));
  }
  if (::testing::Test::HasFailure()) {
    gguf_free(gguf);
    ggml_free(ctx_w);
    FAIL() << "one or more expert tensors missing from GGUF";
  }

  ggml_backend_t cpu_backend =
      ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
  ASSERT_NE(cpu_backend, nullptr);

  // ── 3. Build the M3.10 graph (gallocr-backed). ──────────────────────
  const size_t graph_ctx_mem = size_t{64} * 1024 * 1024;
  std::vector<uint8_t> graph_mem(graph_ctx_mem);
  struct ggml_init_params gp{
      /*.mem_size   =*/graph_ctx_mem,
      /*.mem_buffer =*/graph_mem.data(),
      /*.no_alloc   =*/true,
  };
  struct ggml_context* ctx_g = ggml_init(gp);
  ASSERT_NE(ctx_g, nullptr);

  // Inputs.
  struct ggml_tensor* noise_t =
      ggml_new_tensor_2d(ctx_g, GGML_TYPE_F32, ACTION_DIM, N_ACT);
  ggml_set_name(noise_t, "in.noise");
  struct ggml_tensor* act_pos_t =
      ggml_new_tensor_1d(ctx_g, GGML_TYPE_I32, N_ACT);
  ggml_set_name(act_pos_t, "in.act_pos");
  struct ggml_tensor* cond_t =
      ggml_new_tensor_1d(ctx_g, GGML_TYPE_F32, COND_DIM);
  ggml_set_name(cond_t, "in.cond");

  std::vector<struct ggml_tensor*> cached_k_t(EXPERT_N_LAYERS);
  std::vector<struct ggml_tensor*> cached_v_t(EXPERT_N_LAYERS);
  for (int L = 0; L < EXPERT_N_LAYERS; ++L) {
    cached_k_t[L] = ggml_new_tensor_3d(
        ctx_g,
        GGML_TYPE_F32,
        EXPERT_HEAD_DIM,
        VALID_PREFIX_LEN,
        EXPERT_N_KV_HEADS);
    cached_v_t[L] = ggml_new_tensor_3d(
        ctx_g,
        GGML_TYPE_F32,
        EXPERT_HEAD_DIM,
        VALID_PREFIX_LEN,
        EXPERT_N_KV_HEADS);
    ggml_set_name(cached_k_t[L], ("in.cached_k_" + std::to_string(L)).c_str());
    ggml_set_name(cached_v_t[L], ("in.cached_v_" + std::to_string(L)).c_str());
  }

  // action_in_proj inside the graph.
  struct ggml_tensor* x_exp_t = ggml_mul_mat(ctx_g, action_in_w, noise_t);
  struct ggml_tensor* action_in_b_f32 =
      ggml_cast(ctx_g, action_in_b, GGML_TYPE_F32);
  x_exp_t = ggml_add(ctx_g, x_exp_t, action_in_b_f32);

  using qvac_lib_infer_vla_ggml::pi05BuildExpertOdeStepGraph;
  auto outs = pi05BuildExpertOdeStepGraph(
      ctx_g,
      x_exp_t,
      act_pos_t,
      cached_k_t,
      cached_v_t,
      cond_t,
      blocks,
      final_norm_ada_w,
      final_norm_ada_b,
      action_out_w,
      action_out_b,
      EXPERT_HIDDEN,
      EXPERT_N_HEADS,
      EXPERT_N_KV_HEADS,
      EXPERT_HEAD_DIM,
      VALID_PREFIX_LEN,
      N_ACT,
      EXPERT_RMS_EPS,
      EXPERT_ROPE_BASE);
  ASSERT_NE(outs.final_out, nullptr);
  ASSERT_NE(outs.v_t, nullptr);

  struct ggml_cgraph* gf = ggml_new_graph_custom(ctx_g, 32768, false);
  ggml_build_forward_expand(gf, outs.final_out);
  ggml_build_forward_expand(gf, outs.v_t);

  ggml_gallocr_t allocr =
      ggml_gallocr_new(ggml_backend_get_default_buffer_type(cpu_backend));
  ASSERT_NE(allocr, nullptr);
  ASSERT_TRUE(ggml_gallocr_alloc_graph(allocr, gf));

  // Upload inputs after allocation.
  std::vector<int32_t> act_pos_data(N_ACT);
  for (int i = 0; i < N_ACT; ++i) {
    act_pos_data[i] = VALID_PREFIX_LEN + i;
  }
  ggml_backend_tensor_set(
      noise_t, noise.data(), 0, noise.size() * sizeof(float));
  ggml_backend_tensor_set(
      act_pos_t, act_pos_data.data(), 0, act_pos_data.size() * sizeof(int32_t));
  ggml_backend_tensor_set(
      cond_t, cond_data.data(), 0, cond_data.size() * sizeof(float));
  for (int L = 0; L < EXPERT_N_LAYERS; ++L) {
    ggml_backend_tensor_set(
        cached_k_t[L],
        k_slices[L].data(),
        0,
        k_slices[L].size() * sizeof(float));
    ggml_backend_tensor_set(
        cached_v_t[L],
        v_slices[L].data(),
        0,
        v_slices[L].size() * sizeof(float));
  }

  ASSERT_EQ(ggml_backend_graph_compute(cpu_backend, gf), GGML_STATUS_SUCCESS);

  // ── 4. Compare both outputs. ─────────────────────────────────────────
  auto compare = [&](const char* name,
                     struct ggml_tensor* out,
                     const std::vector<float>& expected,
                     int rows,
                     int cols,
                     float cos_bar,
                     float rel_bar) {
    const size_t n = static_cast<size_t>(rows) * cols;
    ASSERT_EQ(ggml_nelements(out), static_cast<int64_t>(n));
    ASSERT_EQ(expected.size(), n);
    std::vector<float> got_vec(n);
    ggml_backend_tensor_get(out, got_vec.data(), 0, n * sizeof(float));
    const float cos = cosineSim(got_vec.data(), expected.data(), n);
    const float diff = maxAbsDiff(got_vec.data(), expected.data(), n);
    float max_abs = 0.0f;
    double sum_sq = 0.0;
    for (size_t i = 0; i < n; ++i) {
      const float a = std::fabs(expected[i]);
      if (a > max_abs) {
        max_abs = a;
      }
      const double d = static_cast<double>(got_vec[i]) - expected[i];
      sum_sq += d * d;
    }
    const float rms = static_cast<float>(std::sqrt(sum_sq / n));
    std::cerr << "[M3.10] " << name << ": cos=" << cos
              << " max_abs_diff=" << diff << " rms_diff=" << rms
              << " max_abs_expected=" << max_abs
              << " rel_max=" << (diff / std::max(max_abs, 1e-9f)) << "\n";
    EXPECT_GT(cos, cos_bar);
    EXPECT_LT(diff / std::max(max_abs, 1e-9f), rel_bar);
  };

  compare(
      "final_out",
      outs.final_out,
      expected_final,
      N_ACT,
      EXPERT_HIDDEN,
      /*cos=*/0.9999f,
      /*rel=*/0.05f);
  compare(
      "v_t",
      outs.v_t,
      expected_vt,
      N_ACT,
      ACTION_DIM,
      /*cos=*/0.9999f,
      /*rel=*/0.05f);

  ggml_gallocr_free(allocr);
  ggml_backend_free(cpu_backend);
  ggml_free(ctx_g);
  gguf_free(gguf);
  ggml_free(ctx_w);
}
