// M3.9 parity test: one expert block with joint attention.
//
// Builds the inputs that the dump captured at the t=1.0 ODE step:
//   * x_exp = action_in_proj(noise)  — from the fixture noise (50, 32)
//             projected to (50, 1024) via proj.action_in.{w,b} from the
//             GGUF.
//   * cached layer-0 KV from `vlm.kv_cache_full.{keys,values}[0]`,
//     sliced to the first 832 valid positions so no attention mask is
//     needed (action queries see all valid prefix + all action, both
//     fully bidirectional within their groups).
//   * cond = `expert.cond[t=1.0]` from the dump.
//   * act_positions = [832, 833, …, 881] (continued from prefix).
//
// Runs `pi05BuildExpertBlockGraph` and asserts vs
// `expert.blk_0.out[t=1.0]`.

#include <algorithm>
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
constexpr int N_ACT = 50;
constexpr int ACTION_DIM = 32;
constexpr int EXPERT_HIDDEN = 1024;
constexpr int EXPERT_N_HEADS = 8;
constexpr int EXPERT_N_KV_HEADS = 1;
constexpr int EXPERT_HEAD_DIM = 256;
constexpr int VLM_KV_DIM = EXPERT_HEAD_DIM; // same head_dim
constexpr float EXPERT_RMS_EPS = 1e-6f;
constexpr float EXPERT_ROPE_BASE = 10000.0f;
constexpr int COND_DIM = 1024;

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

} // namespace

TEST(Pi05M3_9, ExpertBlock0JointAttnMatchesPytorch) {
  const char* gguf_path = envOrNull("PI05_TEST_GGUF");
  const char* fixture_path = envOrNull("PI05_TEST_FIXTURE");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (gguf_path == nullptr || fixture_path == nullptr ||
      activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_GGUF, PI05_TEST_FIXTURE and "
                    "PI05_TEST_ACTIVATIONS to run the M3.9 parity test.";
  }

  // ── 1. Inputs from the dump. ──────────────────────────────────────────
  qvac_vla_safetensors_lite::Reader fixture;
  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(fixture.open(fixture_path));
  ASSERT_NO_THROW(activations.open(activations_path));

  const std::vector<float> noise = fixture.readF32("fixture.noise");
  ASSERT_EQ(noise.size(), static_cast<size_t>(N_ACT * ACTION_DIM));
  const std::vector<float> cond_data =
      activations.readF32("expert.cond[t=1.0]");
  ASSERT_EQ(cond_data.size(), static_cast<size_t>(COND_DIM));
  const std::vector<float> expected =
      activations.readF32("expert.blk_0.out[t=1.0]");
  ASSERT_EQ(expected.size(), static_cast<size_t>(N_ACT * EXPERT_HIDDEN));

  // The full KV cache is (18, prefix_len=968, n_kv_heads=1, head_dim=256).
  // Layer 0 slice is (968, 1, 256) — VALID_PREFIX_LEN × 1 × 256 of which
  // are non-padding. We slice on the second axis (prefix_len) below.
  const std::vector<float> kv_keys_all =
      activations.readF32("vlm.kv_cache_full.keys");
  const std::vector<float> kv_vals_all =
      activations.readF32("vlm.kv_cache_full.values");
  const size_t per_layer_kv =
      static_cast<size_t>(PREFIX_LEN_FULL * EXPERT_N_KV_HEADS * VLM_KV_DIM);
  ASSERT_GE(kv_keys_all.size(), per_layer_kv);
  ASSERT_GE(kv_vals_all.size(), per_layer_kv);

  // Layer-0 slice, sliced to valid prefix length on the seq axis.
  // The numpy layout is (prefix_len, kv_heads, head_dim) row-major, so
  // we want kv_keys_layer0[0:VALID_PREFIX_LEN, :, :]. Each row is
  // (kv_heads * head_dim) floats; a contiguous prefix of
  // VALID_PREFIX_LEN rows is exactly the byte range we need.
  std::vector<float> k_cache_valid(
      VALID_PREFIX_LEN * EXPERT_N_KV_HEADS * VLM_KV_DIM);
  std::vector<float> v_cache_valid(k_cache_valid.size());
  std::memcpy(k_cache_valid.data(), kv_keys_all.data(),
              k_cache_valid.size() * sizeof(float));
  std::memcpy(v_cache_valid.data(), kv_vals_all.data(),
              v_cache_valid.size() * sizeof(float));

  // ── 2. GGUF weights. ──────────────────────────────────────────────────
  struct ggml_context* ctx_w = nullptr;
  struct gguf_init_params gguf_params{};
  gguf_params.no_alloc = false;
  gguf_params.ctx = &ctx_w;
  struct gguf_context* gguf = gguf_init_from_file(gguf_path, gguf_params);
  ASSERT_NE(gguf, nullptr);

  struct ggml_tensor* action_in_w = mustGet(ctx_w, "proj.action_in.weight");
  struct ggml_tensor* action_in_b = mustGet(ctx_w, "proj.action_in.bias");

  qvac_lib_infer_vla_ggml::Pi05ExpertBlockWeights bw{};
  bw.pre_attn_ada_w = mustGet(ctx_w, "expert.blk.0.pre_attn_norm.ada.weight");
  bw.pre_attn_ada_b = mustGet(ctx_w, "expert.blk.0.pre_attn_norm.ada.bias");
  bw.pre_ffw_ada_w = mustGet(ctx_w, "expert.blk.0.pre_ffw_norm.ada.weight");
  bw.pre_ffw_ada_b = mustGet(ctx_w, "expert.blk.0.pre_ffw_norm.ada.bias");
  bw.attn_q_w = mustGet(ctx_w, "expert.blk.0.attn.q.weight");
  bw.attn_k_w = mustGet(ctx_w, "expert.blk.0.attn.k.weight");
  bw.attn_v_w = mustGet(ctx_w, "expert.blk.0.attn.v.weight");
  bw.attn_o_w = mustGet(ctx_w, "expert.blk.0.attn.o.weight");
  bw.mlp_gate_w = mustGet(ctx_w, "expert.blk.0.mlp.gate.weight");
  bw.mlp_up_w = mustGet(ctx_w, "expert.blk.0.mlp.up.weight");
  bw.mlp_down_w = mustGet(ctx_w, "expert.blk.0.mlp.down.weight");
  if (::testing::Test::HasFailure()) {
    gguf_free(gguf);
    ggml_free(ctx_w);
    FAIL() << "one or more expert tensors missing from GGUF";
  }

  // ── 3. Build & run the graph. ────────────────────────────────────────
  // pi05's `action_in_proj` (Linear 32 → 1024) is included as the first
  // op so the F16-stored weights are promoted inside the graph (the
  // `toF32` call in pi05Linear handles it). M3.10 will reuse the
  // same op when chaining 18 expert blocks.
  ggml_backend_t cpu_backend =
      ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
  ASSERT_NE(cpu_backend, nullptr);

  // ── 4. Build & run the M3.9 graph (gallocr-backed). ──────────────────
  const size_t graph_ctx_mem = size_t{32} * 1024 * 1024; // 32 MiB
  std::vector<uint8_t> graph_mem(graph_ctx_mem);
  struct ggml_init_params gp{
      /*.mem_size   =*/graph_ctx_mem,
      /*.mem_buffer =*/graph_mem.data(),
      /*.no_alloc   =*/true,
  };
  struct ggml_context* ctx_g = ggml_init(gp);
  ASSERT_NE(ctx_g, nullptr);

  // Inputs (no_alloc=true → no backing memory yet).
  // Feed noise as input (50, 32) and do action_in_proj inside the graph,
  // so the F16-stored weights are F32-promoted by ggml automatically.
  struct ggml_tensor* noise_t =
      ggml_new_tensor_2d(ctx_g, GGML_TYPE_F32, ACTION_DIM, N_ACT);
  ggml_set_name(noise_t, "in.noise");
  struct ggml_tensor* act_pos_t =
      ggml_new_tensor_1d(ctx_g, GGML_TYPE_I32, N_ACT);
  ggml_set_name(act_pos_t, "in.act_pos");
  struct ggml_tensor* cached_k_t = ggml_new_tensor_3d(
      ctx_g, GGML_TYPE_F32, EXPERT_HEAD_DIM, VALID_PREFIX_LEN,
      EXPERT_N_KV_HEADS);
  ggml_set_name(cached_k_t, "in.cached_k");
  struct ggml_tensor* cached_v_t = ggml_new_tensor_3d(
      ctx_g, GGML_TYPE_F32, EXPERT_HEAD_DIM, VALID_PREFIX_LEN,
      EXPERT_N_KV_HEADS);
  ggml_set_name(cached_v_t, "in.cached_v");
  struct ggml_tensor* cond_t =
      ggml_new_tensor_1d(ctx_g, GGML_TYPE_F32, COND_DIM);
  ggml_set_name(cond_t, "in.cond");

  // x_exp = action_in_proj(noise) = noise @ W^T + b
  // action_in_w is (ne=[ACTION_DIM, EXPERT_HIDDEN]) F16-stored; ggml_mul_mat
  // promotes it implicitly.
  struct ggml_tensor* x_exp_t = ggml_mul_mat(ctx_g, action_in_w, noise_t);
  // The bias is F16; promote then add. We can't call the static
  // pi05Linear helper here, so inline the cast.
  struct ggml_tensor* action_in_b_f32 =
      ggml_cast(ctx_g, action_in_b, GGML_TYPE_F32);
  x_exp_t = ggml_add(ctx_g, x_exp_t, action_in_b_f32);
  ggml_set_name(x_exp_t, "x_exp");

  using qvac_lib_infer_vla_ggml::pi05BuildExpertBlockGraph;
  struct ggml_tensor* out = pi05BuildExpertBlockGraph(
      ctx_g, x_exp_t, act_pos_t, cached_k_t, cached_v_t, cond_t, bw,
      EXPERT_HIDDEN, EXPERT_N_HEADS, EXPERT_N_KV_HEADS, EXPERT_HEAD_DIM,
      VALID_PREFIX_LEN, N_ACT, EXPERT_RMS_EPS, EXPERT_ROPE_BASE);
  ASSERT_NE(out, nullptr);

  struct ggml_cgraph* gf = ggml_new_graph_custom(ctx_g, 8192, false);
  ggml_build_forward_expand(gf, out);

  ggml_gallocr_t allocr = ggml_gallocr_new(
      ggml_backend_get_default_buffer_type(cpu_backend));
  ASSERT_NE(allocr, nullptr);
  ASSERT_TRUE(ggml_gallocr_alloc_graph(allocr, gf));

  // Upload inputs after allocation.
  std::vector<int32_t> act_pos_data(N_ACT);
  for (int i = 0; i < N_ACT; ++i) {
    act_pos_data[i] = VALID_PREFIX_LEN + i; // 832..881
  }
  ggml_backend_tensor_set(noise_t, noise.data(), 0,
                          noise.size() * sizeof(float));
  ggml_backend_tensor_set(act_pos_t, act_pos_data.data(), 0,
                          act_pos_data.size() * sizeof(int32_t));
  ggml_backend_tensor_set(cached_k_t, k_cache_valid.data(), 0,
                          k_cache_valid.size() * sizeof(float));
  ggml_backend_tensor_set(cached_v_t, v_cache_valid.data(), 0,
                          v_cache_valid.size() * sizeof(float));
  ggml_backend_tensor_set(cond_t, cond_data.data(), 0,
                          cond_data.size() * sizeof(float));

  ASSERT_EQ(ggml_backend_graph_compute(cpu_backend, gf),
            GGML_STATUS_SUCCESS);

  // ── 5. Compare against expert.blk_0.out[t=1.0]. ──────────────────────
  ASSERT_EQ(ggml_nelements(out),
            static_cast<int64_t>(N_ACT * EXPERT_HIDDEN));
  std::vector<float> got_vec(N_ACT * EXPERT_HIDDEN);
  ggml_backend_tensor_get(out, got_vec.data(), 0,
                          got_vec.size() * sizeof(float));
  const float* got = got_vec.data();
  const size_t cmp_n = static_cast<size_t>(N_ACT * EXPERT_HIDDEN);

  const float cos = cosineSim(got, expected.data(), cmp_n);
  const float diff = maxAbsDiff(got, expected.data(), cmp_n);
  float max_abs_expected = 0.0f;
  double sum_sq = 0.0;
  for (size_t i = 0; i < cmp_n; ++i) {
    const float a = std::fabs(expected[i]);
    if (a > max_abs_expected) {
      max_abs_expected = a;
    }
    const double d = static_cast<double>(got[i]) - expected[i];
    sum_sq += d * d;
  }
  const float rms = static_cast<float>(std::sqrt(sum_sq / cmp_n));
  std::cerr << "[M3.9] expert.blk_0.out[t=1.0]: cos=" << cos
            << " max_abs_diff=" << diff
            << " rms_diff=" << rms
            << " max_abs_expected=" << max_abs_expected
            << " rel_max=" << (diff / std::max(max_abs_expected, 1e-9f))
            << "\n";

  EXPECT_GT(cos, 0.9999f);
  EXPECT_LT(diff / std::max(max_abs_expected, 1e-9f), 5e-2f);

  ggml_gallocr_free(allocr);
  ggml_backend_free(cpu_backend);
  ggml_free(ctx_g);
  gguf_free(gguf);
  ggml_free(ctx_w);
}
