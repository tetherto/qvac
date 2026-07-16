// M4.5 backbone composition parity: vision tower → merge → 16-layer text
// decoder vs backbone_output.backbone_features, using MY vision output spliced
// into the oracle text seq (raw input_ids aren't dumped, so text-token embeds
// are oracle's).

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

constexpr int N_IMAGES = 2; // LIBERO v4 fixture: image + wrist_image
constexpr int GRID = 16;
constexpr int N_POS = N_IMAGES * GRID * GRID; // 512
constexpr int IN_FLAT = 1536;
constexpr int V_EMBD = 1024;
constexpr int V_HEAD = 16;
constexpr int V_HEAD_DIM = 64;
constexpr int MERGE = 2;
constexpr int NUM_POS_EMBD = 2304;
constexpr int OUT_HIDDEN = 2048;
constexpr int N_MERGED = 128; // 2 images × 64 merged patches

constexpr int T_TOK = 148; // LIBERO v4 fixture: 128 image + 20 text tokens
constexpr int DIM = 2048;
constexpr int N_LAYERS = 16;
constexpr int N_HEAD = 16;
constexpr int N_HEAD_KV = 8;
constexpr int HEAD_DIM = 128;
constexpr int FFN_LEN = 6144;
constexpr float ROPE_FREQ_BASE = 5000000.0f;
constexpr float RMS_EPS = 1e-6f;
constexpr float V_EPS = 1e-6f;
constexpr float V_ROPE_BASE = 10000.0f;

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

TEST(GrootM4_5, BackboneCompositionMatchesPytorch) {
  const char* ggufPath = envOrNull("GROOT_TEST_GGUF");
  const char* actPath = envOrNull("GROOT_TEST_ACTIVATIONS_V4");
  if (ggufPath == nullptr || actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_GGUF and GROOT_TEST_ACTIVATIONS_V4 to run "
                    "the M4.5 backbone-composition test.";
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

  const std::vector<float> vpm =
      act.readF32("text_model_input.call0.kwargs.visual_pos_masks");
  ASSERT_EQ(vpm.size(), size_t(T_TOK));

  // ── Phase 1: vision tower → my image embeds + deepstack (to host) ──────
  std::vector<float> myVision(size_t(N_MERGED) * OUT_HIDDEN);
  std::vector<std::vector<float>> myDeepstack(3);
  {
    GrootVisionWeights vw{};
    vw.patch_embd_w = gt(ctxW, "v.patch_embd.weight");
    vw.patch_embd_w1 = gt(ctxW, "v.patch_embd.weight.1");
    vw.patch_embd_b = gt(ctxW, "v.patch_embd.bias");
    vw.position_embd = gt(ctxW, "v.position_embd.weight");
    vw.post_ln_w = gt(ctxW, "v.post_ln.weight");
    vw.post_ln_b = gt(ctxW, "v.post_ln.bias");
    vw.mm_0_w = gt(ctxW, "mm.0.weight");
    vw.mm_0_b = gt(ctxW, "mm.0.bias");
    vw.mm_2_w = gt(ctxW, "mm.2.weight");
    vw.mm_2_b = gt(ctxW, "mm.2.bias");
    vw.blocks.resize(24);
    for (int i = 0; i < 24; ++i) {
      const std::string b = "v.blk." + std::to_string(i);
      auto& bw = vw.blocks[i];
      bw.ln1_w = gt(ctxW, b + ".ln1.weight");
      bw.ln1_b = gt(ctxW, b + ".ln1.bias");
      bw.attn_qkv_w = gt(ctxW, b + ".attn_qkv.weight");
      bw.attn_qkv_b = gt(ctxW, b + ".attn_qkv.bias");
      bw.attn_out_w = gt(ctxW, b + ".attn_out.weight");
      bw.attn_out_b = gt(ctxW, b + ".attn_out.bias");
      bw.ln2_w = gt(ctxW, b + ".ln2.weight");
      bw.ln2_b = gt(ctxW, b + ".ln2.bias");
      bw.ffn_up_w = gt(ctxW, b + ".ffn_up.weight");
      bw.ffn_up_b = gt(ctxW, b + ".ffn_up.bias");
      bw.ffn_down_w = gt(ctxW, b + ".ffn_down.weight");
      bw.ffn_down_b = gt(ctxW, b + ".ffn_down.bias");
    }
    const std::vector<int> dsIdx = {5, 11, 17};
    vw.deepstack_mergers.resize(3);
    for (size_t i = 0; i < 3; ++i) {
      const std::string b = "v.deepstack." + std::to_string(dsIdx[i]);
      auto& dm = vw.deepstack_mergers[i];
      dm.norm_w = gt(ctxW, b + ".norm.weight");
      dm.norm_b = gt(ctxW, b + ".norm.bias");
      dm.fc1_w = gt(ctxW, b + ".fc1.weight");
      dm.fc1_b = gt(ctxW, b + ".fc1.bias");
      dm.fc2_w = gt(ctxW, b + ".fc2.weight");
      dm.fc2_b = gt(ctxW, b + ".fc2.bias");
    }

    const std::vector<float> patchesv =
        act.readF32("vision_input.call0.args.0");
    ASSERT_EQ(patchesv.size(), size_t(N_POS) * IN_FLAT);

    const size_t mem = size_t(8) * 1024u * 1024u * 1024u;
    std::vector<uint8_t> buf(mem);
    struct ggml_init_params ip{mem, buf.data(), false};
    struct ggml_context* c = ggml_init(ip);
    ASSERT_NE(c, nullptr);

    struct ggml_tensor* wlin = grootBuildPatchEmbedLinear(
        c, vw.patch_embd_w, vw.patch_embd_w1, V_EMBD, 3, 2, GRID);
    struct ggml_tensor* patchInput =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, IN_FLAT, N_POS);
    std::memcpy(
        patchInput->data, patchesv.data(), patchesv.size() * sizeof(float));

    std::vector<int32_t> sH(GRID * GRID), sW(GRID * GRID);
    int ptr = 0;
    for (int y = 0; y < GRID; y += MERGE)
      for (int x = 0; x < GRID; x += MERGE)
        for (int dy = 0; dy < MERGE; ++dy)
          for (int dx = 0; dx < MERGE; ++dx) {
            sH[ptr] = y + dy;
            sW[ptr] = x + dx;
            ++ptr;
          }
    struct ggml_tensor* positions =
        ggml_new_tensor_1d(c, GGML_TYPE_I32, N_POS * 4);
    auto* pp = static_cast<int32_t*>(positions->data);
    for (int p = 0; p < N_POS; ++p) {
      const int loc = p % (GRID * GRID);
      pp[0 * N_POS + p] = sH[loc];
      pp[1 * N_POS + p] = sW[loc];
      pp[2 * N_POS + p] = sH[loc];
      pp[3 * N_POS + p] = sW[loc];
    }
    struct ggml_tensor* mask =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, N_POS, N_POS);
    auto* mp = static_cast<float*>(mask->data);
    for (int q = 0; q < N_POS; ++q)
      for (int s = 0; s < N_POS; ++s)
        mp[size_t(q) * N_POS + s] =
            (s / (GRID * GRID) == q / (GRID * GRID)) ? 0.0f : -INFINITY;

    std::vector<struct ggml_tensor*> deepstack;
    struct ggml_tensor* vout = grootBuildVisionGraph(
        c,
        patchInput,
        wlin,
        vw.patch_embd_b,
        vw.position_embd,
        positions,
        mask,
        vw,
        N_IMAGES,
        GRID,
        GRID,
        V_EMBD,
        V_HEAD,
        V_HEAD_DIM,
        MERGE,
        NUM_POS_EMBD,
        OUT_HIDDEN,
        V_EPS,
        V_ROPE_BASE,
        dsIdx,
        &deepstack);
    ASSERT_NE(vout, nullptr);
    ASSERT_EQ(deepstack.size(), size_t(3));

    struct ggml_cgraph* gf = ggml_new_graph_custom(c, 16384, false);
    ggml_build_forward_expand(gf, vout);
    for (auto* d : deepstack)
      ggml_build_forward_expand(gf, d);
    ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);

    std::memcpy(myVision.data(), vout->data, myVision.size() * sizeof(float));
    for (int i = 0; i < 3; ++i) {
      myDeepstack[i].resize(size_t(N_MERGED) * OUT_HIDDEN);
      std::memcpy(
          myDeepstack[i].data(),
          deepstack[i]->data,
          myDeepstack[i].size() * sizeof(float));
    }
    ggml_free(c);
  }

  // ── Phase 2: merge into text sequence + text decoder ───────────────────
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
  }

  // Start from the oracle inputs_embeds (text-token embeds we can't reproduce
  // without input_ids), then overwrite the image positions with MY vision
  // embeds and validate those rows match — the composition point under test.
  std::vector<float> embeds =
      act.readF32("text_model_input.call0.kwargs.inputs_embeds");
  const std::vector<float> posIds =
      act.readF32("text_model_input.call0.kwargs.position_ids");
  const std::vector<float> expected =
      act.readF32("backbone_output.backbone_features");

  // Splice in my vision embeds and gate their agreement vs the oracle's before
  // propagating through the decoder.
  {
    int img = 0;
    double dot = 0, na = 0, nb = 0;
    for (int t = 0; t < T_TOK; ++t) {
      if (vpm[t] > 0.5f) {
        for (int e = 0; e < DIM; ++e) {
          const float mine = myVision[size_t(img) * OUT_HIDDEN + e];
          const float orac = embeds[size_t(t) * DIM + e];
          dot += double(mine) * orac;
          na += double(mine) * mine;
          nb += double(orac) * orac;
          embeds[size_t(t) * DIM + e] = mine;
        }
        ++img;
      }
    }
    ASSERT_EQ(img, N_MERGED);
    const float imgCos = float(dot / (std::sqrt(na) * std::sqrt(nb)));
    std::cerr << "[M4.5 backbone] my image embeds vs oracle cos=" << imgCos
              << "\n";
    // Same F16 vision-tower accumulation floor as M4.5 vision's merged gate
    // (~0.99898 on the LIBERO v4 fixture); the composed backbone_features check
    // below stays at the tighter 0.999. See test_groot_m4_5_vision.cpp.
    EXPECT_GT(imgCos, 0.998f);
  }

  const size_t mem = size_t(2) * 1024u * 1024u * 1024u;
  std::vector<uint8_t> buf(mem);
  struct ggml_init_params ip{mem, buf.data(), false};
  struct ggml_context* c = ggml_init(ip);
  ASSERT_NE(c, nullptr);

  struct ggml_tensor* inpE = ggml_new_tensor_2d(c, GGML_TYPE_F32, DIM, T_TOK);
  std::memcpy(inpE->data, embeds.data(), embeds.size() * sizeof(float));

  struct ggml_tensor* positions =
      ggml_new_tensor_1d(c, GGML_TYPE_I32, T_TOK * 4);
  auto* pp = static_cast<int32_t*>(positions->data);
  for (int ax = 0; ax < 3; ++ax)
    for (int t = 0; t < T_TOK; ++t)
      pp[ax * T_TOK + t] = static_cast<int32_t>(posIds[ax * T_TOK + t]);
  for (int t = 0; t < T_TOK; ++t)
    pp[3 * T_TOK + t] = 0;

  struct ggml_tensor* mask = ggml_new_tensor_2d(c, GGML_TYPE_F32, T_TOK, T_TOK);
  auto* mp = static_cast<float*>(mask->data);
  for (int q = 0; q < T_TOK; ++q)
    for (int s = 0; s < T_TOK; ++s)
      mp[q * T_TOK + s] = (s <= q) ? 0.0f : -INFINITY;

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
            &myDeepstack[i][size_t(img) * DIM],
            DIM * sizeof(float));
        ++img;
      }
    }
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

  struct ggml_cgraph* gf = ggml_new_graph_custom(c, 8192, false);
  ggml_build_forward_expand(gf, out);
  ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);

  const float* got = static_cast<const float*>(out->data);
  const size_t n = expected.size();
  const float cos = cosineSim(got, expected.data(), n);
  const float rel = relMaxDiff(got, expected.data(), n);
  std::cerr << "[M4.5 backbone] composed backbone_features cos=" << cos
            << " rel=" << rel << "\n";
  EXPECT_GT(cos, 0.9995f);
  EXPECT_LT(rel, 0.02f);

  ggml_free(c);
  gguf_free(gguf);
  ggml_free(ctxW);
}
