// M4.2 parity: GR00T timestep encoder + embodiment-conditioned MLPs (state
// encoder, action decoder, action encoder), each fed the oracle's dumped input
// from the augmented dump (activations_v2; v1 lacks the per-step inputs).
// call0 is the first denoising step. Tolerances: cos > 0.9995 + relative
// max-abs-diff < 1% (bf16 oracle; see test_groot_m4_1_vlfusion.cpp).

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "model-interface/groot.hpp"
#include "pi05_compute.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

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
  const double denom = std::sqrt(na) * std::sqrt(nb);
  return denom > 0.0 ? static_cast<float>(dot / denom) : 0.0f;
}

float relMaxDiff(const float* a, const float* b, size_t n) {
  float m = 0.0f, scale = 0.0f;
  for (size_t i = 0; i < n; ++i) {
    m = std::max(m, std::fabs(a[i] - b[i]));
    scale = std::max(scale, std::fabs(b[i]));
  }
  return scale > 0.0f ? m / scale : m;
}

struct ggml_tensor* g(struct ggml_context* c, const char* n) {
  return ggml_get_tensor(c, n);
}

qvac_lib_infer_vla_ggml::GrootLinearWeights
linW(struct ggml_context* c, const std::string& prefix) {
  return {g(c, (prefix + ".weight").c_str()), g(c, (prefix + ".bias").c_str())};
}

// Feed a numpy (…, D) row-major buffer as ggml ne=[D, rows].
struct ggml_tensor* feed2d(
    struct ggml_context* c, const std::vector<float>& data, int d, int rows) {
  struct ggml_tensor* t = ggml_new_tensor_2d(c, GGML_TYPE_F32, d, rows);
  std::memcpy(t->data, data.data(), data.size() * sizeof(float));
  return t;
}

void check(const char* tag, const float* got, const std::vector<float>& exp) {
  const float cos = cosineSim(got, exp.data(), exp.size());
  const float rel = relMaxDiff(got, exp.data(), exp.size());
  std::cerr << "[M4.2] " << tag << ": cos=" << cos << " rel=" << rel << "\n";
  EXPECT_GT(cos, 0.9995f) << tag;
  EXPECT_LT(rel, 0.01f) << tag;
}

} // namespace

TEST(GrootM4_2, EncodersMatchPytorch) {
  const char* ggufPath = envOrNull("GROOT_TEST_GGUF");
  const char* actPath = envOrNull("GROOT_TEST_ACTIVATIONS_V4");
  if (ggufPath == nullptr || actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_GGUF and GROOT_TEST_ACTIVATIONS_V4 "
                    "(augmented dump) to run the M4.2 encoder parity test.";
  }

  qvac_vla_safetensors_lite::Reader act;
  ASSERT_NO_THROW(act.open(actPath));

  struct ggml_context* ctxW = nullptr;
  struct gguf_init_params gp{};
  gp.no_alloc = false;
  gp.ctx = &ctxW;
  struct gguf_context* gguf = gguf_init_from_file(ggufPath, gp);
  ASSERT_NE(gguf, nullptr);
  ASSERT_NE(ctxW, nullptr);

  const size_t mem = 128u * 1024u * 1024u;
  std::vector<uint8_t> buf(mem);
  struct ggml_init_params ip{mem, buf.data(), false};
  struct ggml_context* c = ggml_init(ip);
  ASSERT_NE(c, nullptr);

  using namespace qvac_lib_infer_vla_ggml;

  // ── 1. Timestep encoder ───────────────────────────────────────────────
  {
    const float t = act.readF32("timestep_encoder_input.call0.args.0").at(0);
    std::vector<float> projBuf(256);
    grootComputeTimestepProj(t, 256, projBuf.data());
    struct ggml_tensor* proj = ggml_new_tensor_1d(c, GGML_TYPE_F32, 256);
    std::memcpy(proj->data, projBuf.data(), projBuf.size() * sizeof(float));
    struct ggml_tensor* out = grootBuildTimestepMlpGraph(
        c,
        proj,
        g(ctxW, "dit.timestep_embedder.linear_1.weight"),
        g(ctxW, "dit.timestep_embedder.linear_1.bias"),
        g(ctxW, "dit.timestep_embedder.linear_2.weight"),
        g(ctxW, "dit.timestep_embedder.linear_2.bias"));
    ASSERT_NE(out, nullptr);
    struct ggml_cgraph* gf = ggml_new_graph(c);
    ggml_build_forward_expand(gf, out);
    ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
    check(
        "timestep",
        static_cast<const float*>(out->data),
        act.readF32("timestep_encoder_output.call0"));
  }

  // ── 2. State encoder (CategorySpecificMLP, ReLU) ──────────────────────
  {
    const std::vector<float> in =
        act.readF32("state_encoder_input.call0.args.0");
    struct ggml_tensor* x = feed2d(c, in, 132, 1); // [1,1,132] → [132,1]
    struct ggml_tensor* out = grootBuildCategoryMlpGraph(
        c,
        x,
        linW(ctxW, "embodiment.state_encoder.layer1"),
        linW(ctxW, "embodiment.state_encoder.layer2"));
    ASSERT_NE(out, nullptr);
    struct ggml_cgraph* gf = ggml_new_graph(c);
    ggml_build_forward_expand(gf, out);
    ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
    check(
        "state_encoder",
        static_cast<const float*>(out->data),
        act.readF32("state_encoder_output.call0"));
  }

  // ── 3. Action decoder (CategorySpecificMLP, ReLU) ─────────────────────
  {
    const std::vector<float> in =
        act.readF32("action_decoder_input.call0.args.0");
    struct ggml_tensor* x = feed2d(c, in, 1024, 41); // [1,41,1024] → [1024,41]
    struct ggml_tensor* out = grootBuildCategoryMlpGraph(
        c,
        x,
        linW(ctxW, "embodiment.action_decoder.layer1"),
        linW(ctxW, "embodiment.action_decoder.layer2"));
    ASSERT_NE(out, nullptr);
    struct ggml_cgraph* gf = ggml_new_graph(c);
    ggml_build_forward_expand(gf, out);
    ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
    check(
        "action_decoder",
        static_cast<const float*>(out->data),
        act.readF32("action_decoder_output.call0"));
  }

  // ── 4. Action encoder (MultiEmbodimentActionEncoder, swish) ───────────
  {
    const std::vector<float> in =
        act.readF32("action_encoder_input.call0.args.0"); // [1,40,132]
    const float t = act.readF32("action_encoder_input.call0.args.1").at(0);
    struct ggml_tensor* actions = feed2d(c, in, 132, 40);
    std::vector<float> tauBuf(1536);
    grootComputeActionTauEnc(t, 1536, tauBuf.data());
    struct ggml_tensor* tau = ggml_new_tensor_1d(c, GGML_TYPE_F32, 1536);
    std::memcpy(tau->data, tauBuf.data(), tauBuf.size() * sizeof(float));
    struct ggml_tensor* out = grootBuildActionEncoderGraph(
        c,
        actions,
        tau,
        linW(ctxW, "embodiment.action_encoder.w1"),
        linW(ctxW, "embodiment.action_encoder.w2"),
        linW(ctxW, "embodiment.action_encoder.w3"),
        1536,
        40);
    ASSERT_NE(out, nullptr);
    struct ggml_cgraph* gf = ggml_new_graph(c);
    ggml_build_forward_expand(gf, out);
    ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
    check(
        "action_encoder",
        static_cast<const float*>(out->data),
        act.readF32("action_encoder_output.call0"));
  }

  ggml_free(c);
  gguf_free(gguf);
  ggml_free(ctxW);
}
