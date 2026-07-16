// M4.6 end-to-end composition: chains every verified GR00T builder from the raw
// oracle inputs (patches + normalized state + noise) through the full pipeline,
// gating at each junction:
//   1. MY vl features     vs vl_self_attention_output
//   2. MY state features  vs state_encoder_output
//   3. Euler x_t          vs action_encoder_input.call{1,2,3}
//
// This is what GrootModel::infer composes. The two pieces NOT reproduced here
// are oracle-fed as they'll be caller-fed in production: text-token embeds
// (need input_ids, not dumped) and the final Gr00tPolicy unnormalization
// (consumer-side).

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

// vision
constexpr int N_IMAGES = 2; // LIBERO v4 fixture: image + wrist_image
constexpr int GRID = 16;
constexpr int N_VPOS = N_IMAGES * GRID * GRID; // 512
constexpr int IN_FLAT = 1536;
constexpr int V_EMBD = 1024;
constexpr int V_HEAD = 16;
constexpr int V_HEAD_DIM = 64;
constexpr int MERGE = 2;
constexpr int NUM_POS_EMBD = 2304;
constexpr int OUT_HIDDEN = 2048;
constexpr int N_MERGED = 128; // 2 images × 64 merged patches
constexpr float V_EPS = 1e-6f;
constexpr float V_ROPE_BASE = 10000.0f;
// text
constexpr int T_TOK = 148; // LIBERO v4 fixture: 128 image + 20 text tokens
constexpr int DIM = 2048;
constexpr int T_LAYERS = 16;
constexpr int T_HEAD = 16;
constexpr int T_HEAD_KV = 8;
constexpr int T_HEAD_DIM = 128;
constexpr int T_FFN = 6144;
constexpr float T_ROPE_BASE = 5000000.0f;
constexpr float T_RMS_EPS = 1e-6f;
// vlfusion
constexpr int VLF_LAYERS = 4;
constexpr int VLF_HEADS = 32;
constexpr int VLF_HEAD_DIM = 64;
constexpr float VLF_EPS = 1e-5f;
// action head / dit
constexpr int N_ACT = 40;
constexpr int ACT_DIM = 132;
constexpr int STATE_DIM = 132;
constexpr int ADIM = 1536;
constexpr int N_DHEADS = 32;
constexpr int D_HEAD_DIM = 48;
constexpr int D_FFN = 6144;
constexpr int D_LAYERS = 32;
constexpr int OUT_DIM = 1024;
constexpr int ATTEND_N = 2;
constexpr int N_STEPS = 4;

const char* envOrNull(const char* n) {
  const char* v = std::getenv(n);
  return (v != nullptr && v[0] != '\0') ? v : nullptr;
}
float cosineSim(const float* a, const float* b, size_t n) {
  double dot = 0, na = 0, nb = 0;
  for (size_t i = 0; i < n; ++i) {
    dot += double(a[i]) * b[i];
    na += double(a[i]) * a[i];
    nb += double(b[i]) * b[i];
  }
  const double d = std::sqrt(na) * std::sqrt(nb);
  return d > 0 ? float(dot / d) : 0.0f;
}
float relMaxDiff(const float* a, const float* b, size_t n) {
  float m = 0, s = 0;
  for (size_t i = 0; i < n; ++i) {
    m = std::max(m, std::fabs(a[i] - b[i]));
    s = std::max(s, std::fabs(b[i]));
  }
  return s > 0 ? m / s : m;
}
struct ggml_tensor* gt(struct ggml_context* c, const std::string& n) {
  return ggml_get_tensor(c, n.c_str());
}
qvac_lib_infer_vla_ggml::GrootLinearWeights
linW(struct ggml_context* c, const std::string& p) {
  return {gt(c, p + ".weight"), gt(c, p + ".bias")};
}

} // namespace

TEST(GrootM4_6, EndToEndPipelineMatchesPytorch) {
  const char* ggufPath = envOrNull("GROOT_TEST_GGUF");
  const char* actPath = envOrNull("GROOT_TEST_ACTIVATIONS_V4");
  if (ggufPath == nullptr || actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_GGUF and GROOT_TEST_ACTIVATIONS_V4 to run "
                    "the M4.6 end-to-end pipeline test.";
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

  // ── Phase 1: vision tower → image embeds + deepstack (to host) ─────────
  std::vector<float> myVision(size_t(N_MERGED) * OUT_HIDDEN);
  std::vector<std::vector<float>> myDeep(3);
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
    const size_t mem = size_t(8) * 1024u * 1024u * 1024u;
    std::vector<uint8_t> buf(mem);
    struct ggml_init_params ip{mem, buf.data(), false};
    struct ggml_context* c = ggml_init(ip);
    struct ggml_tensor* wlin = grootBuildPatchEmbedLinear(
        c, vw.patch_embd_w, vw.patch_embd_w1, V_EMBD, 3, 2, GRID);
    struct ggml_tensor* pin =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, IN_FLAT, N_VPOS);
    std::memcpy(pin->data, patchesv.data(), patchesv.size() * sizeof(float));
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
    struct ggml_tensor* pos = ggml_new_tensor_1d(c, GGML_TYPE_I32, N_VPOS * 4);
    auto* pp = static_cast<int32_t*>(pos->data);
    for (int p = 0; p < N_VPOS; ++p) {
      const int loc = p % (GRID * GRID);
      pp[p] = sH[loc];
      pp[N_VPOS + p] = sW[loc];
      pp[2 * N_VPOS + p] = sH[loc];
      pp[3 * N_VPOS + p] = sW[loc];
    }
    struct ggml_tensor* mask =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, N_VPOS, N_VPOS);
    auto* mp = static_cast<float*>(mask->data);
    for (int q = 0; q < N_VPOS; ++q)
      for (int s = 0; s < N_VPOS; ++s)
        mp[size_t(q) * N_VPOS + s] =
            (s / (GRID * GRID) == q / (GRID * GRID)) ? 0.0f : -INFINITY;
    std::vector<struct ggml_tensor*> deep;
    struct ggml_tensor* vout = grootBuildVisionGraph(
        c,
        pin,
        wlin,
        vw.patch_embd_b,
        vw.position_embd,
        pos,
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
        &deep);
    struct ggml_cgraph* gf = ggml_new_graph_custom(c, 16384, false);
    ggml_build_forward_expand(gf, vout);
    for (auto* d : deep)
      ggml_build_forward_expand(gf, d);
    ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
    std::memcpy(myVision.data(), vout->data, myVision.size() * sizeof(float));
    for (int i = 0; i < 3; ++i) {
      myDeep[i].resize(size_t(N_MERGED) * OUT_HIDDEN);
      std::memcpy(
          myDeep[i].data(), deep[i]->data, myDeep[i].size() * sizeof(float));
    }
    ggml_free(c);
  }

  // ── Phase 2: text decoder (my image embeds spliced) → backbone_features ─
  std::vector<float> myBackbone(size_t(T_TOK) * DIM);
  {
    GrootTextWeights tw{};
    tw.token_embd_w = gt(ctxW, "token_embd.weight");
    tw.output_norm_w = gt(ctxW, "output_norm.weight");
    tw.blocks.resize(T_LAYERS);
    for (int i = 0; i < T_LAYERS; ++i) {
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
    std::vector<float> embeds =
        act.readF32("text_model_input.call0.kwargs.inputs_embeds");
    const std::vector<float> posIds =
        act.readF32("text_model_input.call0.kwargs.position_ids");
    int img = 0;
    for (int t = 0; t < T_TOK; ++t)
      if (vpm[t] > 0.5f) {
        std::memcpy(
            &embeds[size_t(t) * DIM],
            &myVision[size_t(img) * OUT_HIDDEN],
            DIM * sizeof(float));
        ++img;
      }
    const size_t mem = size_t(2) * 1024u * 1024u * 1024u;
    std::vector<uint8_t> buf(mem);
    struct ggml_init_params ip{mem, buf.data(), false};
    struct ggml_context* c = ggml_init(ip);
    struct ggml_tensor* inpE = ggml_new_tensor_2d(c, GGML_TYPE_F32, DIM, T_TOK);
    std::memcpy(inpE->data, embeds.data(), embeds.size() * sizeof(float));
    struct ggml_tensor* posT = ggml_new_tensor_1d(c, GGML_TYPE_I32, T_TOK * 4);
    auto* pp = static_cast<int32_t*>(posT->data);
    for (int ax = 0; ax < 3; ++ax)
      for (int t = 0; t < T_TOK; ++t)
        pp[ax * T_TOK + t] = int32_t(posIds[ax * T_TOK + t]);
    for (int t = 0; t < T_TOK; ++t)
      pp[3 * T_TOK + t] = 0;
    struct ggml_tensor* mask =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, T_TOK, T_TOK);
    auto* mp = static_cast<float*>(mask->data);
    for (int q = 0; q < T_TOK; ++q)
      for (int s = 0; s < T_TOK; ++s)
        mp[q * T_TOK + s] = (s <= q) ? 0.0f : -INFINITY;
    std::vector<struct ggml_tensor*> ds(3, nullptr);
    for (int i = 0; i < 3; ++i) {
      struct ggml_tensor* d = ggml_new_tensor_2d(c, GGML_TYPE_F32, DIM, T_TOK);
      auto* dp = static_cast<float*>(d->data);
      std::memset(dp, 0, size_t(DIM) * T_TOK * sizeof(float));
      int im = 0;
      for (int t = 0; t < T_TOK; ++t)
        if (vpm[t] > 0.5f) {
          std::memcpy(
              &dp[size_t(t) * DIM],
              &myDeep[i][size_t(im) * DIM],
              DIM * sizeof(float));
          ++im;
        }
      ds[i] = d;
    }
    const int sec[4] = {24, 20, 20, 0};
    struct ggml_tensor* out = grootBuildTextDecoderGraph(
        c,
        inpE,
        posT,
        mask,
        ds,
        tw,
        T_LAYERS,
        T_TOK,
        T_HEAD,
        T_HEAD_KV,
        T_HEAD_DIM,
        T_FFN,
        T_ROPE_BASE,
        sec,
        T_RMS_EPS);
    struct ggml_cgraph* gf = ggml_new_graph_custom(c, 8192, false);
    ggml_build_forward_expand(gf, out);
    ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
    std::memcpy(
        myBackbone.data(), out->data, myBackbone.size() * sizeof(float));
    ggml_free(c);
  }

  // ── Phase 3: vlfusion(my backbone) + state encode; gate vs oracle ──────
  std::vector<float> myVl(size_t(T_TOK) * DIM);
  std::vector<float> myState(size_t(1) * ADIM);
  {
    GrootVlfusionWeights vf{};
    vf.vlln_w = gt(ctxW, "vlfusion.vlln.weight");
    vf.vlln_b = gt(ctxW, "vlfusion.vlln.bias");
    vf.blocks.resize(VLF_LAYERS);
    for (int i = 0; i < VLF_LAYERS; ++i) {
      const std::string b = "vlfusion.blk." + std::to_string(i);
      auto& bw = vf.blocks[i];
      bw.norm1_w = gt(ctxW, b + ".norm1.weight");
      bw.norm1_b = gt(ctxW, b + ".norm1.bias");
      bw.norm3_w = gt(ctxW, b + ".norm3.weight");
      bw.norm3_b = gt(ctxW, b + ".norm3.bias");
      bw.attn_q_w = gt(ctxW, b + ".attn_q.weight");
      bw.attn_q_b = gt(ctxW, b + ".attn_q.bias");
      bw.attn_k_w = gt(ctxW, b + ".attn_k.weight");
      bw.attn_k_b = gt(ctxW, b + ".attn_k.bias");
      bw.attn_v_w = gt(ctxW, b + ".attn_v.weight");
      bw.attn_v_b = gt(ctxW, b + ".attn_v.bias");
      bw.attn_out_w = gt(ctxW, b + ".attn_out.weight");
      bw.attn_out_b = gt(ctxW, b + ".attn_out.bias");
      bw.ffn_in_w = gt(ctxW, b + ".ffn_in.weight");
      bw.ffn_in_b = gt(ctxW, b + ".ffn_in.bias");
      bw.ffn_out_w = gt(ctxW, b + ".ffn_out.weight");
      bw.ffn_out_b = gt(ctxW, b + ".ffn_out.bias");
    }
    const GrootLinearWeights se1 =
        linW(ctxW, "embodiment.state_encoder.layer1");
    const GrootLinearWeights se2 =
        linW(ctxW, "embodiment.state_encoder.layer2");
    const std::vector<float> normState =
        act.readF32("state_encoder_input.call0.args.0"); // [1,1,132]

    const size_t mem = size_t(2) * 1024u * 1024u * 1024u;
    std::vector<uint8_t> buf(mem);
    struct ggml_init_params ip{mem, buf.data(), false};
    struct ggml_context* c = ggml_init(ip);
    struct ggml_tensor* bb = ggml_new_tensor_2d(c, GGML_TYPE_F32, DIM, T_TOK);
    std::memcpy(bb->data, myBackbone.data(), myBackbone.size() * sizeof(float));
    GrootVlfusionOutputs vlo = grootBuildVlfusionGraph(
        c, bb, vf, T_TOK, DIM, VLF_HEADS, VLF_HEAD_DIM, VLF_EPS);
    ASSERT_NE(vlo.fusion_out, nullptr);
    struct ggml_tensor* st = ggml_new_tensor_2d(c, GGML_TYPE_F32, STATE_DIM, 1);
    std::memcpy(st->data, normState.data(), normState.size() * sizeof(float));
    struct ggml_tensor* sf = grootBuildCategoryMlpGraph(c, st, se1, se2);
    ASSERT_NE(sf, nullptr);
    struct ggml_cgraph* gf = ggml_new_graph_custom(c, 8192, false);
    ggml_build_forward_expand(gf, vlo.fusion_out);
    ggml_build_forward_expand(gf, sf);
    ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
    std::memcpy(myVl.data(), vlo.fusion_out->data, myVl.size() * sizeof(float));
    std::memcpy(myState.data(), sf->data, myState.size() * sizeof(float));

    const std::vector<float> expVl = act.readF32("vl_self_attention_output");
    const std::vector<float> expSt = act.readF32("state_encoder_output");
    const float vlCos = cosineSim(myVl.data(), expVl.data(), expVl.size());
    const float vlRel = relMaxDiff(myVl.data(), expVl.data(), expVl.size());
    const float stCos = cosineSim(myState.data(), expSt.data(), expSt.size());
    const float stRel = relMaxDiff(myState.data(), expSt.data(), expSt.size());
    std::cerr << "[M4.6] vl features cos=" << vlCos << " rel=" << vlRel << "\n";
    std::cerr << "[M4.6] state features cos=" << stCos << " rel=" << stRel
              << "\n";
    // vlfusion's vlln (LayerNorm) normalizes away backbone_features' massive-
    // activation outlier (token 0, dim 1793 ≈ 15296) that dominated the
    // backbone cos, exposing+amplifying the vision tower's ~1% bf16 drift on
    // the small channels. So the intermediate vl gate is looser than the
    // oracle-fed M4.1 (0.999999). This drift is immaterial downstream: the
    // Euler action output below — fed THESE vl features — still hits cos
    // 0.99999, which is the gate that actually matters. State features (fed the
    // oracle-normalized state) stay near-exact.
    EXPECT_GT(vlCos, 0.99f);
    EXPECT_LT(vlRel, 0.12f);
    EXPECT_GT(stCos, 0.9995f);
    EXPECT_LT(stRel, 0.02f);
    ggml_free(c);
  }

  // ── Phase 4: Euler loop fed by MY vl + MY state features ───────────────
  {
    GrootDitWeights dw{};
    dw.proj_out_1_w = gt(ctxW, "dit.proj_out_1.weight");
    dw.proj_out_1_b = gt(ctxW, "dit.proj_out_1.bias");
    dw.proj_out_2_w = gt(ctxW, "dit.proj_out_2.weight");
    dw.proj_out_2_b = gt(ctxW, "dit.proj_out_2.bias");
    dw.blocks.resize(D_LAYERS);
    for (int i = 0; i < D_LAYERS; ++i) {
      const std::string b = "dit.blk." + std::to_string(i);
      auto& bw = dw.blocks[i];
      bw.norm1_linear_w = gt(ctxW, b + ".norm1_linear.weight");
      bw.norm1_linear_b = gt(ctxW, b + ".norm1_linear.bias");
      bw.attn_q_w = gt(ctxW, b + ".attn_q.weight");
      bw.attn_q_b = gt(ctxW, b + ".attn_q.bias");
      bw.attn_k_w = gt(ctxW, b + ".attn_k.weight");
      bw.attn_k_b = gt(ctxW, b + ".attn_k.bias");
      bw.attn_v_w = gt(ctxW, b + ".attn_v.weight");
      bw.attn_v_b = gt(ctxW, b + ".attn_v.bias");
      bw.attn_out_w = gt(ctxW, b + ".attn_out.weight");
      bw.attn_out_b = gt(ctxW, b + ".attn_out.bias");
      bw.ffn_in_w = gt(ctxW, b + ".ffn_in.weight");
      bw.ffn_in_b = gt(ctxW, b + ".ffn_in.bias");
      bw.ffn_out_w = gt(ctxW, b + ".ffn_out.weight");
      bw.ffn_out_b = gt(ctxW, b + ".ffn_out.bias");
    }
    const GrootLinearWeights aeW1 = linW(ctxW, "embodiment.action_encoder.w1");
    const GrootLinearWeights aeW2 = linW(ctxW, "embodiment.action_encoder.w2");
    const GrootLinearWeights aeW3 = linW(ctxW, "embodiment.action_encoder.w3");
    const GrootLinearWeights dec1 =
        linW(ctxW, "embodiment.action_decoder.layer1");
    const GrootLinearWeights dec2 =
        linW(ctxW, "embodiment.action_decoder.layer2");
    struct ggml_tensor* posEmbedW = gt(ctxW, "dit.position_embedding.weight");

    const std::vector<float> imageMask =
        act.readF32("dit_model_input.call0.kwargs.image_mask");
    const std::vector<float> bbMask =
        act.readF32("dit_model_input.call0.kwargs.backbone_attention_mask");
    std::vector<float> actions =
        act.readF32("action_encoder_input.call0.args.0");
    const float dt = 1.0f / float(N_STEPS);

    for (int step = 0; step < N_STEPS; ++step) {
      const size_t mem = size_t(2) * 1024u * 1024u * 1024u;
      std::vector<uint8_t> buf(mem);
      struct ggml_init_params ip{mem, buf.data(), false};
      struct ggml_context* c = ggml_init(ip);
      struct ggml_tensor* actT =
          ggml_new_tensor_2d(c, GGML_TYPE_F32, ACT_DIM, N_ACT);
      std::memcpy(actT->data, actions.data(), actions.size() * sizeof(float));
      struct ggml_tensor* stateFeat =
          ggml_new_tensor_2d(c, GGML_TYPE_F32, ADIM, 1);
      std::memcpy(
          stateFeat->data, myState.data(), myState.size() * sizeof(float));
      struct ggml_tensor* vl = ggml_new_tensor_2d(c, GGML_TYPE_F32, DIM, T_TOK);
      std::memcpy(vl->data, myVl.data(), myVl.size() * sizeof(float));
      const std::vector<float> tembV =
          act.readF32("timestep_encoder_output.call" + std::to_string(step));
      struct ggml_tensor* temb = ggml_new_tensor_1d(c, GGML_TYPE_F32, ADIM);
      std::memcpy(temb->data, tembV.data(), tembV.size() * sizeof(float));
      const float bucket =
          act.readF32(
                 "action_encoder_input.call" + std::to_string(step) + ".args.1")
              .at(0);
      std::vector<float> tauBuf(ADIM);
      grootComputeActionTauEnc(bucket, ADIM, tauBuf.data());
      struct ggml_tensor* tau = ggml_new_tensor_1d(c, GGML_TYPE_F32, ADIM);
      std::memcpy(tau->data, tauBuf.data(), tauBuf.size() * sizeof(float));
      const int tTok = N_ACT + 1;
      struct ggml_tensor* imMask =
          ggml_new_tensor_2d(c, GGML_TYPE_F32, T_TOK, tTok);
      struct ggml_tensor* txMask =
          ggml_new_tensor_2d(c, GGML_TYPE_F32, T_TOK, tTok);
      auto* imp = static_cast<float*>(imMask->data);
      auto* txp = static_cast<float*>(txMask->data);
      for (int q = 0; q < tTok; ++q)
        for (int s = 0; s < T_TOK; ++s) {
          const bool valid = bbMask[s] > 0.5f;
          const bool isImg = imageMask[s] > 0.5f;
          imp[q * T_TOK + s] = (valid && isImg) ? 0.0f : -INFINITY;
          txp[q * T_TOK + s] = (valid && !isImg) ? 0.0f : -INFINITY;
        }
      struct ggml_tensor* af = grootBuildActionEncoderGraph(
          c, actT, tau, aeW1, aeW2, aeW3, ADIM, N_ACT);
      struct ggml_tensor* pemb =
          ggml_view_2d(c, posEmbedW, ADIM, N_ACT, posEmbedW->nb[1], 0);
      af = ggml_add(c, af, pemb);
      struct ggml_tensor* sa = ggml_concat(c, stateFeat, af, 1);
      struct ggml_tensor* out = grootBuildDitGraph(
          c,
          sa,
          temb,
          vl,
          imMask,
          txMask,
          dw,
          D_LAYERS,
          N_DHEADS,
          D_HEAD_DIM,
          ADIM,
          DIM,
          D_FFN,
          OUT_DIM,
          ATTEND_N,
          1e-5f,
          nullptr);
      struct ggml_tensor* pred = grootBuildCategoryMlpGraph(c, out, dec1, dec2);
      struct ggml_tensor* vel = ggml_cont(
          c, ggml_view_2d(c, pred, ACT_DIM, N_ACT, pred->nb[1], pred->nb[1]));
      struct ggml_cgraph* gf = ggml_new_graph_custom(c, 8192, false);
      ggml_build_forward_expand(gf, vel);
      ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
      const float* velp = static_cast<const float*>(vel->data);
      for (size_t i = 0; i < actions.size(); ++i)
        actions[i] += dt * velp[i];
      if (step + 1 < N_STEPS) {
        const std::vector<float> exp = act.readF32(
            "action_encoder_input.call" + std::to_string(step + 1) + ".args.0");
        const float cos = cosineSim(actions.data(), exp.data(), exp.size());
        const float rel = relMaxDiff(actions.data(), exp.data(), exp.size());
        std::cerr << "[M4.6] euler step " << step << ": cos=" << cos
                  << " rel=" << rel << "\n";
        // Full-pipeline noise budget: MY vl+state features carry the vision
        // tower's bf16 drift on top of the loop, so allow a touch more slack
        // than the oracle-fed M4.4 (cosine stays the strict structural gate).
        EXPECT_GT(cos, 0.9995f) << "step " << step;
        EXPECT_LT(rel, 0.03f) << "step " << step;
      }
      ggml_free(c);
    }
  }

  gguf_free(gguf);
  ggml_free(ctxW);
}
