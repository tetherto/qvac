// M3.11 parity test: one explicit-Euler ODE step.
//
// Trivial:  x_next = x + dt · v_t  where dt = -1/10 (pi05's
// `NUM_INFERENCE_STEPS = 10`).
//
// Inputs from the dump:
//   x_t     = fixture.noise          (the initial sample at t=1.0)
//   v_t     = expert.v_t[t=1.0]      (the M3.10 output)
// Expected:
//   x_next  = ode.step_0.x_next      (post-first-step latent)

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <ggml-cpu.h>
#include <ggml.h>
#include <gtest/gtest.h>

#include "model-interface/pi05.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

constexpr int N_ACT = 50;
constexpr int ACTION_DIM = 32;
constexpr int N_INFERENCE_STEPS = 10;
constexpr float STEP_DT = -1.0f / N_INFERENCE_STEPS;

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

} // namespace

TEST(Pi05M3_11, EulerStepMatchesPytorch) {
  const char* fixture_path = envOrNull("PI05_TEST_FIXTURE");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (fixture_path == nullptr || activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_FIXTURE and PI05_TEST_ACTIVATIONS to "
                    "run the M3.11 parity test.";
  }

  qvac_vla_safetensors_lite::Reader fixture;
  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(fixture.open(fixture_path));
  ASSERT_NO_THROW(activations.open(activations_path));

  const std::vector<float> noise = fixture.readF32("fixture.noise");
  const std::vector<float> v_t = activations.readF32("expert.v_t[t=1.0]");
  const std::vector<float> expected = activations.readF32("ode.step_0.x_next");
  ASSERT_EQ(noise.size(), static_cast<size_t>(N_ACT * ACTION_DIM));
  ASSERT_EQ(v_t.size(), static_cast<size_t>(N_ACT * ACTION_DIM));
  ASSERT_EQ(expected.size(), static_cast<size_t>(N_ACT * ACTION_DIM));

  const size_t graph_ctx_mem = 4u * 1024 * 1024; // 4 MiB
  std::vector<uint8_t> graph_mem(graph_ctx_mem);
  struct ggml_init_params gp{
      /*.mem_size   =*/graph_ctx_mem,
      /*.mem_buffer =*/graph_mem.data(),
      /*.no_alloc   =*/false,
  };
  struct ggml_context* ctx_g = ggml_init(gp);
  ASSERT_NE(ctx_g, nullptr);

  struct ggml_tensor* x_t =
      ggml_new_tensor_2d(ctx_g, GGML_TYPE_F32, ACTION_DIM, N_ACT);
  struct ggml_tensor* v_t_t =
      ggml_new_tensor_2d(ctx_g, GGML_TYPE_F32, ACTION_DIM, N_ACT);
  std::memcpy(x_t->data, noise.data(), noise.size() * sizeof(float));
  std::memcpy(v_t_t->data, v_t.data(), v_t.size() * sizeof(float));

  using qvac_lib_infer_vla_ggml::pi05BuildEulerStepGraph;
  struct ggml_tensor* out = pi05BuildEulerStepGraph(ctx_g, x_t, v_t_t, STEP_DT);
  ASSERT_NE(out, nullptr);

  struct ggml_cgraph* gf = ggml_new_graph(ctx_g);
  ggml_build_forward_expand(gf, out);
  ASSERT_EQ(
      ggml_graph_compute_with_ctx(ctx_g, gf, /*n_threads=*/4),
      GGML_STATUS_SUCCESS);

  ASSERT_EQ(ggml_nelements(out), static_cast<int64_t>(N_ACT * ACTION_DIM));
  const float* got = static_cast<const float*>(out->data);
  const float cos = cosineSim(got, expected.data(), expected.size());
  const float diff = maxAbsDiff(got, expected.data(), expected.size());

  float max_abs = 0.0f;
  for (float v : expected) {
    const float a = std::fabs(v);
    if (a > max_abs) {
      max_abs = a;
    }
  }
  std::cerr << "[M3.11] ode.step_0.x_next: cos=" << cos
            << " max_abs_diff=" << diff << " max_abs_expected=" << max_abs
            << " rel_max=" << (diff / std::max(max_abs, 1e-9f)) << "\n";

  // Euler step is just a scale + add — F32 throughout, no quant noise.
  // Tight bars.
  EXPECT_GT(cos, 0.99999f);
  EXPECT_LT(diff, 1e-5f);

  ggml_free(ctx_g);
}
