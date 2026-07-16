// M4.3 parity: GR00T DiT (AlternateVLDiT) — 32 alternating self-/cross-
// attention AdaLayerNorm blocks + output head. Fed the augmented dump's step-0
// DiT inputs; temb is fed directly to isolate this from the M4.2 timestep
// encoder. Checks every dit_block_{i}_output.call0 (i=0..31) and the head.
//
// Tolerances: cos > 0.9995 + relative max-abs-diff < 1.5%. The looser relative
// bar (vs 1% for the shallow VL fusion) reflects the 32-layer depth: bf16
// per-op rounding compounds to ~1.1% at the deepest blocks while cosine stays
// > 0.9999 (reference-side noise, not a structural defect). Our path is F32.

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

constexpr int T_TOK = 41;
constexpr int S_TOK = 148; // LIBERO v4 fixture: 128 image + 20 text tokens
constexpr int DIM = 1536;
constexpr int CROSS_DIM = 2048;
constexpr int N_HEADS = 32;
constexpr int HEAD_DIM = 48;
constexpr int FFN_INNER = 6144;
constexpr int N_LAYERS = 32;
constexpr int OUTPUT_DIM = 1024;
constexpr int ATTEND_TEXT_EVERY_N = 2;

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

struct ggml_tensor* g(struct ggml_context* c, const std::string& n) {
  return ggml_get_tensor(c, n.c_str());
}

struct ggml_tensor* feed2d(
    struct ggml_context* c, const std::vector<float>& data, int d, int rows) {
  struct ggml_tensor* t = ggml_new_tensor_2d(c, GGML_TYPE_F32, d, rows);
  std::memcpy(t->data, data.data(), data.size() * sizeof(float));
  return t;
}

} // namespace

TEST(GrootM4_3, DitMatchesPytorch) {
  const char* ggufPath = envOrNull("GROOT_TEST_GGUF");
  const char* actPath = envOrNull("GROOT_TEST_ACTIVATIONS_V4");
  if (ggufPath == nullptr || actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_GGUF and GROOT_TEST_ACTIVATIONS_V4 to run "
                    "the M4.3 DiT parity test.";
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

  // ── DiT weights ───────────────────────────────────────────────────────
  qvac_lib_infer_vla_ggml::GrootDitWeights w{};
  w.proj_out_1_w = g(ctxW, "dit.proj_out_1.weight");
  w.proj_out_1_b = g(ctxW, "dit.proj_out_1.bias");
  w.proj_out_2_w = g(ctxW, "dit.proj_out_2.weight");
  w.proj_out_2_b = g(ctxW, "dit.proj_out_2.bias");
  ASSERT_NE(w.proj_out_2_b, nullptr);
  w.blocks.resize(N_LAYERS);
  for (int i = 0; i < N_LAYERS; ++i) {
    const std::string b = "dit.blk." + std::to_string(i);
    auto& bw = w.blocks[i];
    bw.norm1_linear_w = g(ctxW, b + ".norm1_linear.weight");
    bw.norm1_linear_b = g(ctxW, b + ".norm1_linear.bias");
    bw.attn_q_w = g(ctxW, b + ".attn_q.weight");
    bw.attn_q_b = g(ctxW, b + ".attn_q.bias");
    bw.attn_k_w = g(ctxW, b + ".attn_k.weight");
    bw.attn_k_b = g(ctxW, b + ".attn_k.bias");
    bw.attn_v_w = g(ctxW, b + ".attn_v.weight");
    bw.attn_v_b = g(ctxW, b + ".attn_v.bias");
    bw.attn_out_w = g(ctxW, b + ".attn_out.weight");
    bw.attn_out_b = g(ctxW, b + ".attn_out.bias");
    bw.ffn_in_w = g(ctxW, b + ".ffn_in.weight");
    bw.ffn_in_b = g(ctxW, b + ".ffn_in.bias");
    bw.ffn_out_w = g(ctxW, b + ".ffn_out.weight");
    bw.ffn_out_b = g(ctxW, b + ".ffn_out.bias");
    ASSERT_NE(bw.ffn_out_b, nullptr) << b;
  }

  // ── Inputs ──────────────────────────────────────────────────────────────
  const size_t mem = 512u * 1024u * 1024u;
  std::vector<uint8_t> buf(mem);
  struct ggml_init_params ip{mem, buf.data(), false};
  struct ggml_context* c = ggml_init(ip);
  ASSERT_NE(c, nullptr);

  struct ggml_tensor* hidden = feed2d(
      c, act.readF32("dit_model_input.call0.kwargs.hidden_states"), DIM, T_TOK);
  struct ggml_tensor* encoder = feed2d(
      c,
      act.readF32("dit_model_input.call0.kwargs.encoder_hidden_states"),
      CROSS_DIM,
      S_TOK);
  const std::vector<float> tembV = act.readF32("timestep_encoder_output.call0");
  struct ggml_tensor* temb = ggml_new_tensor_1d(c, GGML_TYPE_F32, DIM);
  std::memcpy(temb->data, tembV.data(), tembV.size() * sizeof(float));

  // Additive key-masks [S, T]: 0 to attend, −inf to block. backbone_mask is
  // all-ones for this fixture; image tokens vs text tokens split by image_mask.
  const std::vector<float> imageMask =
      act.readF32("dit_model_input.call0.kwargs.image_mask");
  const std::vector<float> bbMask =
      act.readF32("dit_model_input.call0.kwargs.backbone_attention_mask");
  struct ggml_tensor* imageKeyMask =
      ggml_new_tensor_2d(c, GGML_TYPE_F32, S_TOK, T_TOK);
  struct ggml_tensor* textKeyMask =
      ggml_new_tensor_2d(c, GGML_TYPE_F32, S_TOK, T_TOK);
  auto* im = static_cast<float*>(imageKeyMask->data);
  auto* tm = static_cast<float*>(textKeyMask->data);
  for (int t = 0; t < T_TOK; ++t) {
    for (int s = 0; s < S_TOK; ++s) {
      const bool valid = bbMask[s] > 0.5f;
      const bool isImg = imageMask[s] > 0.5f;
      im[t * S_TOK + s] = (valid && isImg) ? 0.0f : -INFINITY;
      tm[t * S_TOK + s] = (valid && !isImg) ? 0.0f : -INFINITY;
    }
  }

  // ── Build + run ─────────────────────────────────────────────────────────
  std::vector<struct ggml_tensor*> blocks;
  struct ggml_tensor* out = qvac_lib_infer_vla_ggml::grootBuildDitGraph(
      c,
      hidden,
      temb,
      encoder,
      imageKeyMask,
      textKeyMask,
      w,
      N_LAYERS,
      N_HEADS,
      HEAD_DIM,
      DIM,
      CROSS_DIM,
      FFN_INNER,
      OUTPUT_DIM,
      ATTEND_TEXT_EVERY_N,
      /*eps=*/1e-5f,
      &blocks);
  ASSERT_NE(out, nullptr);
  ASSERT_EQ(static_cast<int>(blocks.size()), N_LAYERS);

  struct ggml_cgraph* gf = ggml_new_graph_custom(c, 8192, false);
  for (auto* b : blocks) {
    ggml_build_forward_expand(gf, b);
  }
  ggml_build_forward_expand(gf, out);
  ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);

  // ── Compare each block output + the head ──────────────────────────────
  int worstBlock = -1;
  float worstCos = 1.0f;
  for (int i = 0; i < N_LAYERS; ++i) {
    const std::vector<float> exp =
        act.readF32("dit_block_" + std::to_string(i) + "_output.call0");
    const float* got = static_cast<const float*>(blocks[i]->data);
    const float cos = cosineSim(got, exp.data(), exp.size());
    const float rel = relMaxDiff(got, exp.data(), exp.size());
    if (cos < worstCos) {
      worstCos = cos;
      worstBlock = i;
    }
    // cos is the strict structural gate. The rel bound is the empirical q8
    // floor: on the shipped groot-q8_vf16.gguf the deepest block (dit_block_31)
    // measures rel ~0.0154 (cos still 0.99994) from q8 weight quantization;
    // 0.02 leaves cross-platform margin. Unquantized groot.gguf stays ~0.009.
    EXPECT_GT(cos, 0.9995f) << "dit_block_" << i;
    EXPECT_LT(rel, 0.02f) << "dit_block_" << i;
  }
  std::cerr << "[M4.3] worst block cos=" << worstCos << " @ block "
            << worstBlock << "\n";

  const std::vector<float> expOut =
      act.readF32("action_decoder_input.call0.args.0");
  const float* gotOut = static_cast<const float*>(out->data);
  const float cosOut = cosineSim(gotOut, expOut.data(), expOut.size());
  const float relOut = relMaxDiff(gotOut, expOut.data(), expOut.size());
  std::cerr << "[M4.3] model_output: cos=" << cosOut << " rel=" << relOut
            << "\n";
  EXPECT_GT(cosOut, 0.9995f);
  EXPECT_LT(relOut, 0.015f);

  ggml_free(c);
  gguf_free(gguf);
  ggml_free(ctxW);
}
