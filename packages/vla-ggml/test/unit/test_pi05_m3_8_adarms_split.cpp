// M3.8 parity test: adaRMSNorm split.
//
// Drive the expert's block-0 pre-attention ada-Dense with the
// dump's `expert.cond[t=1.0]` and assert the three resulting slices
// match `expert.blk_0.adarms_{scale,shift,gate}[t=1.0]`.

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "model-interface/pi05.hpp"
#include "pi05_compute.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

constexpr int EXPERT_HIDDEN = 1024;
constexpr int COND_DIM = 1024;

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

TEST(Pi05M3_8, AdaRmsSplitMatchesPytorch) {
  const char* gguf_path = envOrNull("PI05_TEST_GGUF");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (gguf_path == nullptr || activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_GGUF and PI05_TEST_ACTIVATIONS to "
                    "run the M3.8 parity test.";
  }

  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(activations.open(activations_path));
  const std::vector<float> cond_data =
      activations.readF32("expert.cond[t=1.0]");
  const std::vector<float> expected_scale =
      activations.readF32("expert.blk_0.adarms_scale[t=1.0]");
  const std::vector<float> expected_shift =
      activations.readF32("expert.blk_0.adarms_shift[t=1.0]");
  const std::vector<float> expected_gate =
      activations.readF32("expert.blk_0.adarms_gate[t=1.0]");
  ASSERT_EQ(cond_data.size(), static_cast<size_t>(COND_DIM));
  ASSERT_EQ(expected_scale.size(), static_cast<size_t>(EXPERT_HIDDEN));
  ASSERT_EQ(expected_shift.size(), static_cast<size_t>(EXPERT_HIDDEN));
  ASSERT_EQ(expected_gate.size(), static_cast<size_t>(EXPERT_HIDDEN));

  struct ggml_context* ctx_w = nullptr;
  struct gguf_init_params gguf_params{};
  gguf_params.no_alloc = false;
  gguf_params.ctx = &ctx_w;
  struct gguf_context* gguf = gguf_init_from_file(gguf_path, gguf_params);
  ASSERT_NE(gguf, nullptr);

  struct ggml_tensor* ada_w =
      mustGet(ctx_w, "expert.blk.0.pre_attn_norm.ada.weight");
  struct ggml_tensor* ada_b =
      mustGet(ctx_w, "expert.blk.0.pre_attn_norm.ada.bias");
  if (::testing::Test::HasFailure()) {
    gguf_free(gguf);
    ggml_free(ctx_w);
    FAIL() << "ada dense tensors missing";
  }

  const size_t graph_ctx_mem = 8u * 1024 * 1024;
  std::vector<uint8_t> graph_mem(graph_ctx_mem);
  struct ggml_init_params gp{
      /*.mem_size   =*/graph_ctx_mem,
      /*.mem_buffer =*/graph_mem.data(),
      /*.no_alloc   =*/false,
  };
  struct ggml_context* ctx_g = ggml_init(gp);
  ASSERT_NE(ctx_g, nullptr);

  struct ggml_tensor* cond = ggml_new_tensor_1d(ctx_g, GGML_TYPE_F32, COND_DIM);
  std::memcpy(cond->data, cond_data.data(), COND_DIM * sizeof(float));

  using qvac_lib_infer_vla_ggml::pi05BuildAdarmsSplitGraph;
  auto split =
      pi05BuildAdarmsSplitGraph(ctx_g, cond, ada_w, ada_b, EXPERT_HIDDEN);
  ASSERT_NE(split.scale, nullptr);
  ASSERT_NE(split.shift, nullptr);
  ASSERT_NE(split.gate, nullptr);

  struct ggml_cgraph* gf = ggml_new_graph(ctx_g);
  ggml_build_forward_expand(gf, split.scale);
  ggml_build_forward_expand(gf, split.shift);
  ggml_build_forward_expand(gf, split.gate);
  ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);

  // The three slices alias the modulation tensor, so they share its
  // buffer and `->data` points to the right offset. Read them out.
  const float* got_scale = static_cast<const float*>(split.scale->data);
  const float* got_shift = static_cast<const float*>(split.shift->data);
  const float* got_gate = static_cast<const float*>(split.gate->data);

  struct Probe {
    const char* name;
    const float* got;
    const std::vector<float>& expected;
  };
  const Probe probes[] = {
      {"scale", got_scale, expected_scale},
      {"shift", got_shift, expected_shift},
      {"gate", got_gate, expected_gate},
  };
  for (const Probe& p : probes) {
    const float cos = cosineSim(p.got, p.expected.data(), p.expected.size());
    const float diff = maxAbsDiff(p.got, p.expected.data(), p.expected.size());
    float max_abs = 0.0f;
    for (float v : p.expected) {
      const float a = std::fabs(v);
      if (a > max_abs) {
        max_abs = a;
      }
    }
    std::cerr << "[M3.8] " << p.name << ": cos=" << cos
              << " max_abs_diff=" << diff << " max_abs_expected=" << max_abs
              << " rel_max=" << (diff / std::max(max_abs, 1e-9f)) << "\n";
    EXPECT_GT(cos, 0.99999f) << p.name;
    EXPECT_LT(diff, 5e-3f) << p.name;
  }

  ggml_free(ctx_g);
  gguf_free(gguf);
  ggml_free(ctx_w);
}
