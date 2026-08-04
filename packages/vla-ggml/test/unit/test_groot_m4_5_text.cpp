// M4.5 text-decoder parity: grootBuildTextDecoderGraph on the oracle's
// text_model_input vs backbone_output.backbone_features.
//
// GOTCHA: backbone_features is the pre-norm residual after all 16 layers
// (select_layer=16, NO final norm). The post-norm hidden_states.16 is a
// different tensor (cos 0.11) — do not gate on it.
// GOTCHA: the residual carries a massive activation (token 0, dim 1793, ≈15296)
// that dominates a global cosine, so we also report cos with that outlier
// zeroed to prove the small-magnitude channels are right, not just masked by
// it.

#include <algorithm>
#include <cmath>
#include <cstdint>
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

constexpr int T_TOK = 148; // LIBERO v4 fixture: 128 image + 20 text tokens
constexpr int DIM = 2048;
constexpr int N_LAYERS = 16;
constexpr int N_HEAD = 16;
constexpr int N_HEAD_KV = 8;
constexpr int HEAD_DIM = 128;
constexpr int FFN_LEN = 6144;
constexpr float ROPE_FREQ_BASE = 5000000.0f;
constexpr float RMS_EPS = 1e-6f;

const char* envOrNull(const char* n) {
  const char* v = std::getenv(n);
  return (v != nullptr && v[0] != '\0') ? v : nullptr;
}

float cosineSim(const float* a, const float* b, size_t n) {
  double dot = 0.0, na = 0.0, nb = 0.0;
  for (size_t i = 0; i < n; ++i) {
    dot += double(a[i]) * double(b[i]);
    na += double(a[i]) * double(a[i]);
    nb += double(b[i]) * double(b[i]);
  }
  const double d = std::sqrt(na) * std::sqrt(nb);
  return d > 0.0 ? float(dot / d) : 0.0f;
}

float relMaxDiff(const float* a, const float* b, size_t n) {
  float m = 0.0f, scale = 0.0f;
  for (size_t i = 0; i < n; ++i) {
    m = std::max(m, std::fabs(a[i] - b[i]));
    scale = std::max(scale, std::fabs(b[i]));
  }
  return scale > 0.0f ? m / scale : m;
}

struct ggml_tensor* gt(struct ggml_context* c, const std::string& n) {
  return ggml_get_tensor(c, n.c_str());
}

} // namespace

TEST(GrootM4_5, TextDecoderMatchesPytorch) {
  const char* ggufPath = envOrNull("GROOT_TEST_GGUF");
  const char* actPath = envOrNull("GROOT_TEST_ACTIVATIONS_V4");
  if (ggufPath == nullptr || actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_GGUF and GROOT_TEST_ACTIVATIONS_V4 to run "
                    "the M4.5 text-decoder parity test.";
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

  using namespace qvac_lib_infer_vla_ggml;

  // ── Weights ────────────────────────────────────────────────────────────
  GrootTextWeights tw{};
  tw.token_embd_w = gt(ctxW, "token_embd.weight");
  tw.output_norm_w = gt(ctxW, "output_norm.weight");
  tw.blocks.resize(N_LAYERS);
  for (int i = 0; i < N_LAYERS; ++i) {
    const std::string b = "blk." + std::to_string(i);
    auto& bw = tw.blocks[i];
    bw.attn_norm_w = gt(ctxW, b + ".attn_norm.weight");
    bw.attn_q_w = gt(ctxW, b + ".attn_q.weight");
    bw.attn_k_w = gt(ctxW, b + ".attn_k.weight");
    bw.attn_v_w = gt(ctxW, b + ".attn_v.weight");
    bw.attn_output_w = gt(ctxW, b + ".attn_output.weight");
    bw.attn_q_norm_w = gt(ctxW, b + ".attn_q_norm.weight");
    bw.attn_k_norm_w = gt(ctxW, b + ".attn_k_norm.weight");
    bw.ffn_norm_w = gt(ctxW, b + ".ffn_norm.weight");
    bw.ffn_gate_w = gt(ctxW, b + ".ffn_gate.weight");
    bw.ffn_up_w = gt(ctxW, b + ".ffn_up.weight");
    bw.ffn_down_w = gt(ctxW, b + ".ffn_down.weight");
    ASSERT_NE(bw.ffn_down_w, nullptr) << "missing weights for " << b;
  }

  // ── Oracle inputs ──────────────────────────────────────────────────────
  const std::vector<float> embeds =
      act.readF32("text_model_input.call0.kwargs.inputs_embeds");
  ASSERT_EQ(embeds.size(), size_t(T_TOK) * DIM);
  const std::vector<float> posIds =
      act.readF32("text_model_input.call0.kwargs.position_ids"); // [3,1,280]
  ASSERT_EQ(posIds.size(), size_t(3) * T_TOK);
  const std::vector<float> vpm =
      act.readF32("text_model_input.call0.kwargs.visual_pos_masks"); // [1,280]
  ASSERT_EQ(vpm.size(), size_t(T_TOK));

  std::vector<std::vector<float>> dsSrc(3);
  for (int i = 0; i < 3; ++i) {
    dsSrc[i] = act.readF32(
        "text_model_input.call0.kwargs.deepstack_visual_embeds." +
        std::to_string(i)); // [256, 2048]
  }

  const std::vector<float> expected =
      act.readF32("backbone_output.backbone_features"); // [1,280,2048]
  ASSERT_EQ(expected.size(), size_t(T_TOK) * DIM);

  // ── Build graph inputs ─────────────────────────────────────────────────
  const size_t mem = 2048u * 1024u * 1024u;
  std::vector<uint8_t> buf(mem);
  struct ggml_init_params ip{mem, buf.data(), false};
  struct ggml_context* c = ggml_init(ip);
  ASSERT_NE(c, nullptr);

  struct ggml_tensor* inpE = ggml_new_tensor_2d(c, GGML_TYPE_F32, DIM, T_TOK);
  std::memcpy(inpE->data, embeds.data(), embeds.size() * sizeof(float));

  // M-RoPE positions: 4 blocks of T tokens [axis0 | axis1 | axis2 | axis3],
  // axis3 unused (section width 0) → zeros.
  struct ggml_tensor* positions =
      ggml_new_tensor_1d(c, GGML_TYPE_I32, T_TOK * 4);
  auto* pp = static_cast<int32_t*>(positions->data);
  for (int ax = 0; ax < 3; ++ax) {
    for (int t = 0; t < T_TOK; ++t) {
      pp[ax * T_TOK + t] = static_cast<int32_t>(posIds[ax * T_TOK + t]);
    }
  }
  for (int t = 0; t < T_TOK; ++t)
    pp[3 * T_TOK + t] = 0;

  // Causal additive mask [T_kv, T_q]: 0 if kv<=q else -inf.
  struct ggml_tensor* mask = ggml_new_tensor_2d(c, GGML_TYPE_F32, T_TOK, T_TOK);
  auto* mp = static_cast<float*>(mask->data);
  for (int q = 0; q < T_TOK; ++q) {
    for (int s = 0; s < T_TOK; ++s) {
      mp[q * T_TOK + s] = (s <= q) ? 0.0f : -INFINITY;
    }
  }

  // Deepstack: scatter each [128,2048] into a [2048,148] map at the image
  // token positions (visual_pos_masks), zero elsewhere.
  std::vector<struct ggml_tensor*> deepstack(3, nullptr);
  for (int i = 0; i < 3; ++i) {
    struct ggml_tensor* d = ggml_new_tensor_2d(c, GGML_TYPE_F32, DIM, T_TOK);
    auto* dp = static_cast<float*>(d->data);
    std::memset(dp, 0, size_t(DIM) * T_TOK * sizeof(float));
    int img = 0;
    for (int t = 0; t < T_TOK; ++t) {
      if (vpm[t] > 0.5f) {
        std::memcpy(
            &dp[size_t(t) * DIM],
            &dsSrc[i][size_t(img) * DIM],
            DIM * sizeof(float));
        ++img;
      }
    }
    ASSERT_EQ(img, 128) << "deepstack " << i << " image-token count mismatch";
    deepstack[i] = d;
  }

  const int sections[4] = {24, 20, 20, 0};
  struct ggml_tensor* out = grootBuildTextDecoderGraph(
      c,
      inpE,
      positions,
      mask,
      deepstack,
      tw,
      N_LAYERS,
      T_TOK,
      N_HEAD,
      N_HEAD_KV,
      HEAD_DIM,
      FFN_LEN,
      ROPE_FREQ_BASE,
      sections,
      RMS_EPS);
  ASSERT_NE(out, nullptr);
  ASSERT_EQ(out->ne[0], DIM);
  ASSERT_EQ(out->ne[1], T_TOK);

  struct ggml_cgraph* gf = ggml_new_graph_custom(c, 8192, false);
  ggml_build_forward_expand(gf, out);
  ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);

  const float* got = static_cast<const float*>(out->data);
  const size_t n = expected.size();
  const float cos = cosineSim(got, expected.data(), n);
  const float rel = relMaxDiff(got, expected.data(), n);

  // Cosine with the single massive-activation outlier zeroed (proves the
  // small channels track, not just the dominant dim).
  size_t argmax = 0;
  float amax = 0.0f;
  for (size_t i = 0; i < n; ++i) {
    if (std::fabs(expected[i]) > amax) {
      amax = std::fabs(expected[i]);
      argmax = i;
    }
  }
  std::vector<float> ga(got, got + n), ea = expected;
  ga[argmax] = 0.0f;
  ea[argmax] = 0.0f;
  const float cosNoOutlier = cosineSim(ga.data(), ea.data(), n);

  std::cerr << "[M4.5 text] cos=" << cos << " rel=" << rel
            << " cos(no-outlier)=" << cosNoOutlier << " outlier=" << amax
            << "\n";
  EXPECT_GT(cos, 0.9995f);
  EXPECT_LT(rel, 0.02f);
  EXPECT_GT(cosNoOutlier, 0.999f);

  ggml_free(c);
  gguf_free(gguf);
  ggml_free(ctxW);
}
