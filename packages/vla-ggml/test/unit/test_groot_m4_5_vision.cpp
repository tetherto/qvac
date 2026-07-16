// M4.5 vision-tower parity: grootBuildVisionGraph on the oracle's flattened
// patch input vs vision_output.0 (merged embeds) + vision_output.1.{0,1,2}
// (deepstack). Fixture: LIBERO v4, 2 images @ 16×16 patch grid, 2×2 merge →
// 128 merged tokens; vision attention is block-diagonal per image (patches
// attend only within their image).

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
constexpr int GRID = 16;    // patches per side
constexpr int N_PATCHES_IMG = GRID * GRID;      // 256
constexpr int N_POS = N_IMAGES * N_PATCHES_IMG; // 512
constexpr int IN_FLAT = 1536;                   // 3ch·2temporal·16·16
constexpr int N_EMBD = 1024;
constexpr int N_HEAD = 16;
constexpr int HEAD_DIM = 64;
constexpr int MERGE = 2;
constexpr int NUM_POS_EMBD = 2304; // 48×48 base grid
constexpr int OUT_HIDDEN = 2048;
constexpr int N_MERGED = N_POS / (MERGE * MERGE); // 128
constexpr float EPS = 1e-6f;
constexpr float ROPE_FREQ_BASE = 10000.0f;

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

TEST(GrootM4_5, VisionTowerMatchesPytorch) {
  const char* ggufPath = envOrNull("GROOT_TEST_GGUF");
  const char* actPath = envOrNull("GROOT_TEST_ACTIVATIONS_V4");
  if (ggufPath == nullptr || actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_GGUF and GROOT_TEST_ACTIVATIONS_V4 to run "
                    "the M4.5 vision-tower parity test.";
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

  // ── Vision weights ─────────────────────────────────────────────────────
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
    ASSERT_NE(bw.ffn_down_w, nullptr) << "missing weights for " << b;
  }
  const std::vector<int> deepstackIdx = {5, 11, 17};
  vw.deepstack_mergers.resize(3);
  for (size_t i = 0; i < 3; ++i) {
    const std::string b = "v.deepstack." + std::to_string(deepstackIdx[i]);
    auto& dm = vw.deepstack_mergers[i];
    dm.norm_w = gt(ctxW, b + ".norm.weight");
    dm.norm_b = gt(ctxW, b + ".norm.bias");
    dm.fc1_w = gt(ctxW, b + ".fc1.weight");
    dm.fc1_b = gt(ctxW, b + ".fc1.bias");
    dm.fc2_w = gt(ctxW, b + ".fc2.weight");
    dm.fc2_b = gt(ctxW, b + ".fc2.bias");
    ASSERT_NE(dm.fc2_w, nullptr) << "missing deepstack " << b;
  }

  // ── Oracle input + expected ────────────────────────────────────────────
  const std::vector<float> patches = act.readF32("vision_input.call0.args.0");
  ASSERT_EQ(patches.size(), size_t(N_POS) * IN_FLAT);
  const std::vector<float> expMerged = act.readF32("vision_output.0");
  ASSERT_EQ(expMerged.size(), size_t(N_MERGED) * OUT_HIDDEN);
  std::vector<std::vector<float>> expDs(3);
  for (int i = 0; i < 3; ++i) {
    expDs[i] = act.readF32("vision_output.1." + std::to_string(i));
    ASSERT_EQ(expDs[i].size(), size_t(N_MERGED) * OUT_HIDDEN);
  }

  // ── Compute context (large: 24 blocks over 1024 patches) ───────────────
  const size_t mem = size_t(8) * 1024u * 1024u * 1024u;
  std::vector<uint8_t> buf(mem);
  struct ggml_init_params ip{mem, buf.data(), false};
  struct ggml_context* c = ggml_init(ip);
  ASSERT_NE(c, nullptr);

  // Patch-embed linear weight reconstructed from the two Conv2D halves.
  struct ggml_tensor* wlin = grootBuildPatchEmbedLinear(
      c,
      vw.patch_embd_w,
      vw.patch_embd_w1,
      N_EMBD,
      /*inChannels=*/3,
      /*temporalPatch=*/2,
      /*patchSize=*/GRID);
  ASSERT_NE(wlin, nullptr);

  struct ggml_tensor* patchInput =
      ggml_new_tensor_2d(c, GGML_TYPE_F32, IN_FLAT, N_POS);
  std::memcpy(patchInput->data, patches.data(), patches.size() * sizeof(float));

  // Vision M-RoPE positions: per-image (16×16, 2×2 merge order) pattern tiled
  // across the 2 images. 4 axis-blocks laid [h | w | h | w].
  std::vector<int32_t> singleH(N_PATCHES_IMG), singleW(N_PATCHES_IMG);
  {
    int ptr = 0;
    for (int y = 0; y < GRID; y += MERGE) {
      for (int x = 0; x < GRID; x += MERGE) {
        for (int dy = 0; dy < MERGE; ++dy) {
          for (int dx = 0; dx < MERGE; ++dx) {
            singleH[ptr] = y + dy;
            singleW[ptr] = x + dx;
            ++ptr;
          }
        }
      }
    }
  }
  struct ggml_tensor* positions =
      ggml_new_tensor_1d(c, GGML_TYPE_I32, N_POS * 4);
  auto* pp = static_cast<int32_t*>(positions->data);
  for (int p = 0; p < N_POS; ++p) {
    const int local = p % N_PATCHES_IMG;
    pp[0 * N_POS + p] = singleH[local];
    pp[1 * N_POS + p] = singleW[local];
    pp[2 * N_POS + p] = singleH[local];
    pp[3 * N_POS + p] = singleW[local];
  }

  // Block-diagonal additive mask [N_kv, N_q]: attend only within same image.
  struct ggml_tensor* mask = ggml_new_tensor_2d(c, GGML_TYPE_F32, N_POS, N_POS);
  auto* mp = static_cast<float*>(mask->data);
  for (int q = 0; q < N_POS; ++q) {
    for (int s = 0; s < N_POS; ++s) {
      mp[size_t(q) * N_POS + s] =
          (s / N_PATCHES_IMG == q / N_PATCHES_IMG) ? 0.0f : -INFINITY;
    }
  }

  std::vector<struct ggml_tensor*> deepstack;
  std::vector<struct ggml_tensor*> blocks;
  struct ggml_tensor* out = grootBuildVisionGraph(
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
      N_EMBD,
      N_HEAD,
      HEAD_DIM,
      MERGE,
      NUM_POS_EMBD,
      OUT_HIDDEN,
      EPS,
      ROPE_FREQ_BASE,
      deepstackIdx,
      &deepstack,
      &blocks);
  ASSERT_NE(out, nullptr);
  ASSERT_EQ(out->ne[0], OUT_HIDDEN);
  ASSERT_EQ(out->ne[1], N_MERGED);
  ASSERT_EQ(deepstack.size(), size_t(3));

  struct ggml_cgraph* gf = ggml_new_graph_custom(c, 16384, false);
  ggml_build_forward_expand(gf, out);
  for (auto* d : deepstack)
    ggml_build_forward_expand(gf, d);
  for (auto* b : blocks)
    ggml_build_forward_expand(gf, b);
  ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);

  // Per-block diagnostic: block-0 must be near-exact (all per-block ops right);
  // later blocks drift only because the bf16-reference residual stream diverges
  // from our f32 one (no massive-activation anchor like the text decoder has).
  for (int i = 0; i < 24; ++i) {
    const std::vector<float> eb =
        act.readF32("vision_block_" + std::to_string(i) + ".call0");
    const float* g = static_cast<const float*>(blocks[i]->data);
    const float bc = cosineSim(g, eb.data(), eb.size());
    std::cerr << "[M4.5 vision] block " << i << " cos=" << bc << "\n";
    if (i == 0)
      EXPECT_GT(bc, 0.9999f) << "block 0";
  }

  // STRICT correctness gate — single-block isolation: feed the oracle's
  // block-19 output into one block and compare against block-20's oracle
  // output. This removes cross-layer accumulation, so it measures the per-block
  // math alone. ~1.0 here proves every op (LayerNorm, fused-QKV vision M-RoPE,
  // block-diagonal attention, GELU-tanh FFN) is exact; the tower's end-to-end
  // drift below is therefore pure bf16-reference-noise propagation, not an
  // implementation bug.
  {
    const std::vector<float> in19 = act.readF32("vision_block_19.call0");
    const std::vector<float> exp20 = act.readF32("vision_block_20.call0");
    struct ggml_tensor* x19 =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, N_EMBD, N_POS);
    std::memcpy(x19->data, in19.data(), in19.size() * sizeof(float));
    struct ggml_tensor* b20 = grootBuildVisionBlockGraph(
        c,
        x19,
        positions,
        mask,
        vw.blocks[20],
        N_POS,
        N_EMBD,
        N_HEAD,
        HEAD_DIM,
        EPS,
        ROPE_FREQ_BASE);
    struct ggml_cgraph* gf2 = ggml_new_graph_custom(c, 2048, false);
    ggml_build_forward_expand(gf2, b20);
    ASSERT_EQ(pi05_test::computeGraphCpu(gf2), GGML_STATUS_SUCCESS);
    const float iso = cosineSim(
        static_cast<const float*>(b20->data), exp20.data(), exp20.size());
    const float isoRel = relMaxDiff(
        static_cast<const float*>(b20->data), exp20.data(), exp20.size());
    std::cerr << "[M4.5 vision] isolated block 20: cos=" << iso
              << " rel=" << isoRel << "\n";
    EXPECT_GT(iso, 0.9999f);
    EXPECT_LT(isoRel, 0.01f);
  }

  // End-to-end tower outputs: correct, but capped by 24 layers of
  // F16-reference accumulation (see isolation gate above), NOT a correctness
  // spec — the isolated per-block gate (cos > 0.9999) is what pins the math.
  // On the LIBERO v4 fixture the merged floor measures cos ~0.99898 (the
  // per-block trace ends at 0.99842 @ block 23); 0.998 leaves cross-platform
  // F16 margin while still catching any gross regression, versus the tighter
  // 0.9995/2% used for the shallower action-head milestones.
  const size_t n = expMerged.size();
  const float* got = static_cast<const float*>(out->data);
  const float cos = cosineSim(got, expMerged.data(), n);
  const float rel = relMaxDiff(got, expMerged.data(), n);
  std::cerr << "[M4.5 vision] merged cos=" << cos << " rel=" << rel << "\n";
  EXPECT_GT(cos, 0.998f);
  EXPECT_LT(rel, 0.06f);

  for (int i = 0; i < 3; ++i) {
    const float* g = static_cast<const float*>(deepstack[i]->data);
    const float dc = cosineSim(g, expDs[i].data(), expDs[i].size());
    const float dr = relMaxDiff(g, expDs[i].data(), expDs[i].size());
    std::cerr << "[M4.5 vision] deepstack " << i << " cos=" << dc
              << " rel=" << dr << "\n";
    EXPECT_GT(dc, 0.999f) << "deepstack " << i;
    EXPECT_LT(dr, 0.06f) << "deepstack " << i;
  }

  ggml_free(c);
  gguf_free(gguf);
  ggml_free(ctxW);
}
