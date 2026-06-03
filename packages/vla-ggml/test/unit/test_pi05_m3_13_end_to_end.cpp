// M3.13 parity test: end-to-end (prefill → ODE loop).
//
// Runs the production composition end-to-end at the C++ level:
//   1. VLM prefill (M3.6) on the dump's `vlm.prefix_concat` (sliced
//      to 832 valid positions) — produces `final_out` *and* taps the
//      18 per-layer post-RoPE K/V tensors via the new optional out
//      params on `pi05BuildVlmPrefillGraph`.
//   2. Read those K/V out into CPU buffers (one round of
//      `ggml_backend_tensor_get` per layer).
//   3. ODE loop (M3.12) consuming the live cached K/V — same 10
//      Euler steps as M3.12, but the cache comes from our prefill
//      graph rather than from `vlm.kv_cache_full` in the dump.
//
// The upstream pixels-to-features path (3× SigLIP tower + embedder
// + concat) is already validated by M3.1–M3.4 individually and skipped
// here to keep the test under a minute. Feeding the dump's
// `vlm.prefix_concat` directly is equivalent at the byte level.
//
// Parity bar: cos sim > 0.999, rel max < 5 % on `ode.actions_final`
// (plan §5 end-to-end CPU bar, expressed as relative).

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
constexpr int VLM_HIDDEN = 2048;
constexpr int VLM_N_HEADS = 8;
constexpr int VLM_N_KV_HEADS = 1;
constexpr int VLM_HEAD_DIM = 256;
constexpr int VLM_N_LAYERS = 18;
constexpr int EXPERT_HIDDEN = 1024;
constexpr int EXPERT_N_HEADS = 8;
constexpr int EXPERT_N_KV_HEADS = 1;
constexpr int EXPERT_HEAD_DIM = 256;
constexpr int EXPERT_N_LAYERS = 18;
constexpr int COND_DIM = 1024;
constexpr int N_STEPS = 10;
constexpr float STEP_DT = -1.0f / N_STEPS;
constexpr float RMS_EPS = 1e-6f;
constexpr float ROPE_BASE = 10000.0f;
constexpr float MIN_PERIOD = 4e-3f;
constexpr float MAX_PERIOD = 4.0f;

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

qvac_lib_infer_vla_ggml::Pi05GemmaBlockWeights
loadVlmBlock(struct ggml_context* ctx, int i) {
  qvac_lib_infer_vla_ggml::Pi05GemmaBlockWeights bw{};
  const std::string base = "vlm.blk." + std::to_string(i);
  bw.pre_attn_norm_scale =
      mustGet(ctx, (base + ".pre_attn_norm.scale").c_str());
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

TEST(Pi05M3_13, EndToEndPrefillThenOdeMatchesPytorch) {
  const char* gguf_path = envOrNull("PI05_TEST_GGUF");
  const char* fixture_path = envOrNull("PI05_TEST_FIXTURE");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (gguf_path == nullptr || fixture_path == nullptr ||
      activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_GGUF, PI05_TEST_FIXTURE and "
                    "PI05_TEST_ACTIVATIONS to run the M3.13 parity test.";
  }

  qvac_vla_safetensors_lite::Reader fixture;
  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(fixture.open(fixture_path));
  ASSERT_NO_THROW(activations.open(activations_path));

  const std::vector<float> noise = fixture.readF32("fixture.noise");
  const std::vector<float> prefix = activations.readF32("vlm.prefix_concat");
  const std::vector<float> expected_actions =
      activations.readF32("ode.actions_final");
  ASSERT_EQ(prefix.size(), static_cast<size_t>(PREFIX_LEN_FULL * VLM_HIDDEN));

  // ── GGUF weights. ────────────────────────────────────────────────────
  struct ggml_context* ctx_w = nullptr;
  struct gguf_init_params gguf_params{};
  gguf_params.no_alloc = false;
  gguf_params.ctx = &ctx_w;
  struct gguf_context* gguf = gguf_init_from_file(gguf_path, gguf_params);
  ASSERT_NE(gguf, nullptr);

  std::vector<qvac_lib_infer_vla_ggml::Pi05GemmaBlockWeights> vlm_blocks;
  for (int i = 0; i < VLM_N_LAYERS; ++i) {
    vlm_blocks.push_back(loadVlmBlock(ctx_w, i));
  }
  struct ggml_tensor* vlm_final_norm = mustGet(ctx_w, "vlm.final_norm.scale");

  std::vector<qvac_lib_infer_vla_ggml::Pi05ExpertBlockWeights> expert_blocks;
  for (int i = 0; i < EXPERT_N_LAYERS; ++i) {
    expert_blocks.push_back(loadExpertBlock(ctx_w, i));
  }
  struct ggml_tensor* action_in_w = mustGet(ctx_w, "proj.action_in.weight");
  struct ggml_tensor* action_in_b = mustGet(ctx_w, "proj.action_in.bias");
  struct ggml_tensor* action_out_w = mustGet(ctx_w, "proj.action_out.weight");
  struct ggml_tensor* action_out_b = mustGet(ctx_w, "proj.action_out.bias");
  struct ggml_tensor* time_in_w = mustGet(ctx_w, "proj.time_mlp_in.weight");
  struct ggml_tensor* time_in_b = mustGet(ctx_w, "proj.time_mlp_in.bias");
  struct ggml_tensor* time_out_w = mustGet(ctx_w, "proj.time_mlp_out.weight");
  struct ggml_tensor* time_out_b = mustGet(ctx_w, "proj.time_mlp_out.bias");
  struct ggml_tensor* final_norm_ada_w =
      mustGet(ctx_w, "expert.final_norm.ada.weight");
  struct ggml_tensor* final_norm_ada_b =
      mustGet(ctx_w, "expert.final_norm.ada.bias");
  if (::testing::Test::HasFailure()) {
    gguf_free(gguf);
    ggml_free(ctx_w);
    FAIL() << "tensor(s) missing";
  }

  ggml_backend_t cpu_backend =
      ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
  ASSERT_NE(cpu_backend, nullptr);

  // ── 1. VLM prefill with K/V taps. ────────────────────────────────────
  // Captures 18 per-layer post-RoPE K/V tensors into CPU buffers, then
  // tears down the prefill graph.
  const size_t per_layer_kv_bytes = static_cast<size_t>(VLM_HEAD_DIM) *
                                    VALID_PREFIX_LEN * VLM_N_KV_HEADS *
                                    sizeof(float);
  std::vector<std::vector<float>> k_cache(VLM_N_LAYERS);
  std::vector<std::vector<float>> v_cache(VLM_N_LAYERS);
  for (int L = 0; L < VLM_N_LAYERS; ++L) {
    k_cache[L].resize(per_layer_kv_bytes / sizeof(float));
    v_cache[L].resize(per_layer_kv_bytes / sizeof(float));
  }

  {
    const size_t ctx_mem = size_t{32} * 1024 * 1024;
    std::vector<uint8_t> mem(ctx_mem);
    struct ggml_init_params gp{
        /*.mem_size   =*/ctx_mem,
        /*.mem_buffer =*/mem.data(),
        /*.no_alloc   =*/true,
    };
    struct ggml_context* ctx_g = ggml_init(gp);
    ASSERT_NE(ctx_g, nullptr);

    struct ggml_tensor* x =
        ggml_new_tensor_2d(ctx_g, GGML_TYPE_F32, VLM_HIDDEN, VALID_PREFIX_LEN);
    struct ggml_tensor* pos =
        ggml_new_tensor_1d(ctx_g, GGML_TYPE_I32, VALID_PREFIX_LEN);

    std::vector<struct ggml_tensor*> out_keys;
    std::vector<struct ggml_tensor*> out_values;

    using qvac_lib_infer_vla_ggml::pi05BuildVlmPrefillGraph;
    struct ggml_tensor* final_out = pi05BuildVlmPrefillGraph(
        ctx_g,
        x,
        pos,
        /*attn_mask=*/nullptr,
        vlm_blocks,
        vlm_final_norm,
        VLM_HIDDEN,
        VLM_N_HEADS,
        VLM_N_KV_HEADS,
        VLM_HEAD_DIM,
        VALID_PREFIX_LEN,
        RMS_EPS,
        ROPE_BASE,
        &out_keys,
        &out_values);
    ASSERT_NE(final_out, nullptr);
    ASSERT_EQ(out_keys.size(), static_cast<size_t>(VLM_N_LAYERS));
    ASSERT_EQ(out_values.size(), static_cast<size_t>(VLM_N_LAYERS));

    struct ggml_cgraph* gf = ggml_new_graph_custom(ctx_g, 65536, false);
    ggml_build_forward_expand(gf, final_out);
    for (auto* k_t : out_keys) {
      ggml_build_forward_expand(gf, k_t);
    }
    for (auto* v_t : out_values) {
      ggml_build_forward_expand(gf, v_t);
    }

    ggml_gallocr_t allocr =
        ggml_gallocr_new(ggml_backend_get_default_buffer_type(cpu_backend));
    ASSERT_NE(allocr, nullptr);
    ASSERT_TRUE(ggml_gallocr_alloc_graph(allocr, gf));

    std::vector<int32_t> pos_data(VALID_PREFIX_LEN);
    for (int i = 0; i < VALID_PREFIX_LEN; ++i) {
      pos_data[i] = i;
    }
    ggml_backend_tensor_set(
        x,
        prefix.data(),
        0,
        static_cast<size_t>(VALID_PREFIX_LEN) * VLM_HIDDEN * sizeof(float));
    ggml_backend_tensor_set(
        pos, pos_data.data(), 0, pos_data.size() * sizeof(int32_t));

    ASSERT_EQ(ggml_backend_graph_compute(cpu_backend, gf), GGML_STATUS_SUCCESS);

    // Pull K/V out into the CPU caches.
    for (int L = 0; L < VLM_N_LAYERS; ++L) {
      ggml_backend_tensor_get(
          out_keys[L], k_cache[L].data(), 0, per_layer_kv_bytes);
      ggml_backend_tensor_get(
          out_values[L], v_cache[L].data(), 0, per_layer_kv_bytes);
    }

    ggml_gallocr_free(allocr);
    ggml_free(ctx_g);
  }

  // ── 2. ODE loop using the live K/V cache. ────────────────────────────
  std::vector<float> x_t = noise;
  std::vector<float> sincos_buf(COND_DIM);
  std::vector<int32_t> act_pos_data(N_ACT);
  for (int i = 0; i < N_ACT; ++i) {
    act_pos_data[i] = VALID_PREFIX_LEN + i;
  }
  std::vector<float> x_next_buf(x_t.size());

  for (int step = 0; step < N_STEPS; ++step) {
    const float t = 1.0f + step * STEP_DT;
    qvac_lib_infer_vla_ggml::pi05ComputeTimeSincos(
        t, COND_DIM, MIN_PERIOD, MAX_PERIOD, sincos_buf.data());

    const size_t ctx_mem = size_t{96} * 1024 * 1024;
    std::vector<uint8_t> mem(ctx_mem);
    struct ggml_init_params gp{
        /*.mem_size   =*/ctx_mem,
        /*.mem_buffer =*/mem.data(),
        /*.no_alloc   =*/true,
    };
    struct ggml_context* ctx_g = ggml_init(gp);
    ASSERT_NE(ctx_g, nullptr);

    struct ggml_tensor* x_t_t =
        ggml_new_tensor_2d(ctx_g, GGML_TYPE_F32, ACTION_DIM, N_ACT);
    struct ggml_tensor* sincos_t =
        ggml_new_tensor_1d(ctx_g, GGML_TYPE_F32, COND_DIM);
    struct ggml_tensor* act_pos_t =
        ggml_new_tensor_1d(ctx_g, GGML_TYPE_I32, N_ACT);
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
    }

    using qvac_lib_infer_vla_ggml::pi05BuildTimeMlpGraph;
    struct ggml_tensor* cond = pi05BuildTimeMlpGraph(
        ctx_g, sincos_t, time_in_w, time_in_b, time_out_w, time_out_b);

    struct ggml_tensor* x_exp_t = ggml_mul_mat(ctx_g, action_in_w, x_t_t);
    x_exp_t =
        ggml_add(ctx_g, x_exp_t, ggml_cast(ctx_g, action_in_b, GGML_TYPE_F32));

    using qvac_lib_infer_vla_ggml::pi05BuildExpertOdeStepGraph;
    auto outs = pi05BuildExpertOdeStepGraph(
        ctx_g,
        x_exp_t,
        act_pos_t,
        cached_k_t,
        cached_v_t,
        cond,
        expert_blocks,
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
        RMS_EPS,
        ROPE_BASE);
    ASSERT_NE(outs.v_t, nullptr);

    using qvac_lib_infer_vla_ggml::pi05BuildEulerStepGraph;
    struct ggml_tensor* x_next =
        pi05BuildEulerStepGraph(ctx_g, x_t_t, outs.v_t, STEP_DT);

    struct ggml_cgraph* gf = ggml_new_graph_custom(ctx_g, 32768, false);
    ggml_build_forward_expand(gf, x_next);

    ggml_gallocr_t allocr =
        ggml_gallocr_new(ggml_backend_get_default_buffer_type(cpu_backend));
    ASSERT_TRUE(ggml_gallocr_alloc_graph(allocr, gf));

    ggml_backend_tensor_set(x_t_t, x_t.data(), 0, x_t.size() * sizeof(float));
    ggml_backend_tensor_set(
        sincos_t, sincos_buf.data(), 0, sincos_buf.size() * sizeof(float));
    ggml_backend_tensor_set(
        act_pos_t,
        act_pos_data.data(),
        0,
        act_pos_data.size() * sizeof(int32_t));
    for (int L = 0; L < EXPERT_N_LAYERS; ++L) {
      ggml_backend_tensor_set(
          cached_k_t[L],
          k_cache[L].data(),
          0,
          k_cache[L].size() * sizeof(float));
      ggml_backend_tensor_set(
          cached_v_t[L],
          v_cache[L].data(),
          0,
          v_cache[L].size() * sizeof(float));
    }

    ASSERT_EQ(ggml_backend_graph_compute(cpu_backend, gf), GGML_STATUS_SUCCESS);
    ggml_backend_tensor_get(
        x_next, x_next_buf.data(), 0, x_next_buf.size() * sizeof(float));
    std::swap(x_t, x_next_buf);

    ggml_gallocr_free(allocr);
    ggml_free(ctx_g);
  }

  // ── 3. Compare actions_final. ────────────────────────────────────────
  const float cos =
      cosineSim(x_t.data(), expected_actions.data(), expected_actions.size());
  const float diff =
      maxAbsDiff(x_t.data(), expected_actions.data(), expected_actions.size());
  float max_abs = 0.0f;
  double sum_sq = 0.0;
  for (size_t i = 0; i < expected_actions.size(); ++i) {
    const float a = std::fabs(expected_actions[i]);
    if (a > max_abs) {
      max_abs = a;
    }
    const double d = static_cast<double>(x_t[i]) - expected_actions[i];
    sum_sq += d * d;
  }
  const float rms =
      static_cast<float>(std::sqrt(sum_sq / expected_actions.size()));
  std::cerr << "[M3.13] ode.actions_final: cos=" << cos
            << " max_abs_diff=" << diff << " rms_diff=" << rms
            << " max_abs_expected=" << max_abs
            << " rel_max=" << (diff / std::max(max_abs, 1e-9f)) << "\n";

  EXPECT_GT(cos, 0.999f);
  EXPECT_LT(diff / std::max(max_abs, 1e-9f), 0.05f);

  ggml_backend_free(cpu_backend);
  gguf_free(gguf);
  ggml_free(ctx_w);
}
