// M3.7 parity test: time-step → adaRMSNorm conditioning.
//
// For each of the dump's three probe time values (t = 1.0, 0.5, 0.1),
// build the (1024,) sin-cos embedding in C++, push it through the
// MLP+swish graph using `proj.time_mlp_{in,out}.{weight,bias}` from
// the GGUF, and compare against `expert.cond[t=X.X]` from the dump.

#include <cmath>
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

constexpr int COND_DIM = 1024;
constexpr float MIN_PERIOD = 4e-3f;
constexpr float MAX_PERIOD = 4.0f;

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

void runOne(float t,
            const std::string& expected_key,
            struct ggml_tensor* w_in_w,
            struct ggml_tensor* w_in_b,
            struct ggml_tensor* w_out_w,
            struct ggml_tensor* w_out_b,
            const qvac_vla_safetensors_lite::Reader& activations) {
  const std::vector<float> expected = activations.readF32(expected_key);
  ASSERT_EQ(expected.size(), static_cast<size_t>(COND_DIM));

  // Sin-cos embedding (CPU-side, F64 internal).
  std::vector<float> sincos(COND_DIM);
  qvac_lib_infer_vla_ggml::pi05ComputeTimeSincos(
      t, COND_DIM, MIN_PERIOD, MAX_PERIOD, sincos.data());

  // Tiny graph — fits comfortably in the bump allocator.
  const size_t graph_ctx_mem = 8u * 1024 * 1024; // 8 MiB
  std::vector<uint8_t> graph_mem(graph_ctx_mem);
  struct ggml_init_params gp{
      /*.mem_size   =*/graph_ctx_mem,
      /*.mem_buffer =*/graph_mem.data(),
      /*.no_alloc   =*/false,
  };
  struct ggml_context* ctx_g = ggml_init(gp);
  ASSERT_NE(ctx_g, nullptr);

  struct ggml_tensor* time_emb =
      ggml_new_tensor_1d(ctx_g, GGML_TYPE_F32, COND_DIM);
  std::memcpy(time_emb->data, sincos.data(),
              COND_DIM * sizeof(float));

  using qvac_lib_infer_vla_ggml::pi05BuildTimeMlpGraph;
  struct ggml_tensor* out = pi05BuildTimeMlpGraph(
      ctx_g, time_emb, w_in_w, w_in_b, w_out_w, w_out_b);
  ASSERT_NE(out, nullptr);

  struct ggml_cgraph* gf = ggml_new_graph(ctx_g);
  ggml_build_forward_expand(gf, out);
  ASSERT_EQ(ggml_graph_compute_with_ctx(ctx_g, gf, /*n_threads=*/4),
            GGML_STATUS_SUCCESS);

  ASSERT_EQ(ggml_nelements(out), static_cast<int64_t>(COND_DIM));
  const float* got = static_cast<const float*>(out->data);
  const float cos = cosineSim(got, expected.data(), expected.size());
  const float diff = maxAbsDiff(got, expected.data(), expected.size());

  float max_abs_expected = 0.0f;
  for (size_t i = 0; i < expected.size(); ++i) {
    const float a = std::fabs(expected[i]);
    if (a > max_abs_expected) {
      max_abs_expected = a;
    }
  }
  std::cerr << "[M3.7] expert.cond[t=" << t
            << "]: cos=" << cos
            << " max_abs_diff=" << diff
            << " max_abs_expected=" << max_abs_expected
            << " rel_max=" << (diff / std::max(max_abs_expected, 1e-9f))
            << "\n";

  // Plan §5 CPU bar (per-block intermediate): cos > 0.9995,
  // max_abs_diff < 5e-3. Two Linear→SiLU layers don't accumulate
  // F16 noise much; expecting tight numbers.
  EXPECT_GT(cos, 0.99999f);
  EXPECT_LT(diff, 5e-3f);

  ggml_free(ctx_g);
}

} // namespace

TEST(Pi05M3_7, TimeCondMatchesPytorch) {
  const char* gguf_path = envOrNull("PI05_TEST_GGUF");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (gguf_path == nullptr || activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_GGUF and PI05_TEST_ACTIVATIONS to "
                    "run the M3.7 parity test.";
  }

  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(activations.open(activations_path));

  struct ggml_context* ctx_w = nullptr;
  struct gguf_init_params gguf_params{};
  gguf_params.no_alloc = false;
  gguf_params.ctx = &ctx_w;
  struct gguf_context* gguf = gguf_init_from_file(gguf_path, gguf_params);
  ASSERT_NE(gguf, nullptr);
  ASSERT_NE(ctx_w, nullptr);

  struct ggml_tensor* w_in_w = mustGet(ctx_w, "proj.time_mlp_in.weight");
  struct ggml_tensor* w_in_b = mustGet(ctx_w, "proj.time_mlp_in.bias");
  struct ggml_tensor* w_out_w = mustGet(ctx_w, "proj.time_mlp_out.weight");
  struct ggml_tensor* w_out_b = mustGet(ctx_w, "proj.time_mlp_out.bias");
  if (::testing::Test::HasFailure()) {
    gguf_free(gguf);
    ggml_free(ctx_w);
    FAIL() << "time_mlp tensors missing";
  }

  runOne(1.0f, "expert.cond[t=1.0]", w_in_w, w_in_b, w_out_w, w_out_b, activations);
  runOne(0.5f, "expert.cond[t=0.5]", w_in_w, w_in_b, w_out_w, w_out_b, activations);
  runOne(0.1f, "expert.cond[t=0.1]", w_in_w, w_in_b, w_out_w, w_out_b, activations);

  gguf_free(gguf);
  ggml_free(ctx_w);
}
