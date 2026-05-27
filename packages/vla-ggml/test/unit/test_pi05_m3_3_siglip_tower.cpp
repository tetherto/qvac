// M3.3 parity test: full SigLIP-So400m/14 vision tower.
//
// End-to-end vision forward: patch_embed → pos_embed → 27 transformer
// blocks → post_layernorm → head Linear. Loads the full tower from
// pi05_base.gguf (≈430 tensors), feeds in the cam0 fixture image, runs
// the graph, and asserts against `vision.head_out[cam0]` from the
// PyTorch reference.

#include <algorithm>
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

constexpr int IMAGE_SIZE = 224;
constexpr int PATCH_SIZE = 14;
constexpr int N_PATCHES = (IMAGE_SIZE / PATCH_SIZE) * (IMAGE_SIZE / PATCH_SIZE); // 256
constexpr int HIDDEN = 1152;
constexpr int N_HEADS = 16;
constexpr int N_BLOCKS = 27;     // SigLIP-So400m/14 depth
constexpr int PROJ_DIM = 2048;   // VLM input width
constexpr float LAYER_NORM_EPS = 1e-6f;

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

struct ggml_tensor* mustGetTensor(struct ggml_context* ctx, const char* name) {
  struct ggml_tensor* t = ggml_get_tensor(ctx, name);
  if (t == nullptr) {
    ADD_FAILURE() << "tensor missing from GGUF: " << name;
  }
  return t;
}

// Fetch one block's 16 tensors from the GGUF.
qvac_lib_infer_vla_ggml::Pi05SiglipBlockWeights
loadBlockWeights(struct ggml_context* ctx, int i) {
  qvac_lib_infer_vla_ggml::Pi05SiglipBlockWeights bw{};
  const std::string base = "vision.blk." + std::to_string(i);
  bw.ln1_w = mustGetTensor(ctx, (base + ".ln1.weight").c_str());
  bw.ln1_b = mustGetTensor(ctx, (base + ".ln1.bias").c_str());
  bw.attn_q_w = mustGetTensor(ctx, (base + ".attn_q.weight").c_str());
  bw.attn_q_b = mustGetTensor(ctx, (base + ".attn_q.bias").c_str());
  bw.attn_k_w = mustGetTensor(ctx, (base + ".attn_k.weight").c_str());
  bw.attn_k_b = mustGetTensor(ctx, (base + ".attn_k.bias").c_str());
  bw.attn_v_w = mustGetTensor(ctx, (base + ".attn_v.weight").c_str());
  bw.attn_v_b = mustGetTensor(ctx, (base + ".attn_v.bias").c_str());
  bw.attn_out_w = mustGetTensor(ctx, (base + ".attn_out.weight").c_str());
  bw.attn_out_b = mustGetTensor(ctx, (base + ".attn_out.bias").c_str());
  bw.ln2_w = mustGetTensor(ctx, (base + ".ln2.weight").c_str());
  bw.ln2_b = mustGetTensor(ctx, (base + ".ln2.bias").c_str());
  bw.fc1_w = mustGetTensor(ctx, (base + ".fc1.weight").c_str());
  bw.fc1_b = mustGetTensor(ctx, (base + ".fc1.bias").c_str());
  bw.fc2_w = mustGetTensor(ctx, (base + ".fc2.weight").c_str());
  bw.fc2_b = mustGetTensor(ctx, (base + ".fc2.bias").c_str());
  return bw;
}

} // namespace

TEST(Pi05M3_3, SiglipFullTowerMatchesPytorch) {
  const char* gguf_path = envOrNull("PI05_TEST_GGUF");
  const char* fixture_path = envOrNull("PI05_TEST_FIXTURE");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (gguf_path == nullptr || fixture_path == nullptr ||
      activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_GGUF, PI05_TEST_FIXTURE and "
                    "PI05_TEST_ACTIVATIONS to run the M3.3 parity test.";
  }

  // ── 1. Fixture image + expected tower output. ─────────────────────────
  qvac_vla_safetensors_lite::Reader fixture;
  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(fixture.open(fixture_path));
  ASSERT_NO_THROW(activations.open(activations_path));

  const std::vector<float> images_all = fixture.readF32("fixture.images");
  const size_t per_cam = 3 * IMAGE_SIZE * IMAGE_SIZE;
  ASSERT_GE(images_all.size(), per_cam);
  std::vector<float> cam0_image(images_all.begin(),
                                 images_all.begin() + per_cam);
  const std::vector<float> expected =
      activations.readF32("vision.head_out[cam0]");
  ASSERT_EQ(expected.size(), static_cast<size_t>(N_PATCHES * PROJ_DIM));

  // ── 2. Load every vision tensor pi05_base needs. ──────────────────────
  struct ggml_context* ctx_w = nullptr;
  struct gguf_init_params gguf_params{};
  gguf_params.no_alloc = false;
  gguf_params.ctx = &ctx_w;
  struct gguf_context* gguf = gguf_init_from_file(gguf_path, gguf_params);
  ASSERT_NE(gguf, nullptr);
  ASSERT_NE(ctx_w, nullptr);

  qvac_lib_infer_vla_ggml::Pi05VisionTowerWeights tw{};
  tw.patch_embed_w = mustGetTensor(ctx_w, "vision.patch_embed.weight");
  tw.patch_embed_b = mustGetTensor(ctx_w, "vision.patch_embed.bias");
  tw.pos_embed = mustGetTensor(ctx_w, "vision.pos_embed");
  tw.post_ln_w = mustGetTensor(ctx_w, "vision.post_ln.weight");
  tw.post_ln_b = mustGetTensor(ctx_w, "vision.post_ln.bias");
  tw.head_w = mustGetTensor(ctx_w, "vision.head.weight");
  tw.head_b = mustGetTensor(ctx_w, "vision.head.bias");
  tw.blocks.reserve(N_BLOCKS);
  for (int i = 0; i < N_BLOCKS; ++i) {
    tw.blocks.push_back(loadBlockWeights(ctx_w, i));
  }
  if (::testing::Test::HasFailure()) {
    gguf_free(gguf);
    ggml_free(ctx_w);
    FAIL() << "one or more SigLIP tensors missing from GGUF";
  }

  // ── 3. Build the M3.3 graph. ──────────────────────────────────────────
  // A full 27-block SigLIP forward on a 256-patch input is heavy: every
  // block instantiates ~25 intermediate tensors, plus a soft_max_ext
  // per layer, plus the attention K^T product. Empirically ~1.5 GiB of
  // scratch is enough; leave headroom.
  const size_t graph_ctx_mem = 2u * 1024u * 1024u * 1024u;
  std::vector<uint8_t> graph_mem(graph_ctx_mem);
  struct ggml_init_params gp{
      /*.mem_size   =*/graph_ctx_mem,
      /*.mem_buffer =*/graph_mem.data(),
      /*.no_alloc   =*/false,
  };
  struct ggml_context* ctx_g = ggml_init(gp);
  ASSERT_NE(ctx_g, nullptr);

  // Permute fixture cam0 (C, H, W) → ggml's (W, H, C, N).
  struct ggml_tensor* pixels = ggml_new_tensor_4d(
      ctx_g, GGML_TYPE_F32, IMAGE_SIZE, IMAGE_SIZE, 3, 1);
  std::vector<float> permuted(per_cam);
  for (int c = 0; c < 3; ++c) {
    for (int h = 0; h < IMAGE_SIZE; ++h) {
      for (int w = 0; w < IMAGE_SIZE; ++w) {
        const size_t src = static_cast<size_t>(c) * IMAGE_SIZE * IMAGE_SIZE +
                           static_cast<size_t>(h) * IMAGE_SIZE +
                           static_cast<size_t>(w);
        const size_t dst = static_cast<size_t>(w) +
                           static_cast<size_t>(h) * IMAGE_SIZE +
                           static_cast<size_t>(c) * IMAGE_SIZE * IMAGE_SIZE;
        permuted[dst] = cam0_image[src];
      }
    }
  }
  std::memcpy(pixels->data, permuted.data(), per_cam * sizeof(float));

  using qvac_lib_infer_vla_ggml::pi05BuildSiglipTowerGraph;
  auto out = pi05BuildSiglipTowerGraph(
      ctx_g, pixels, tw, N_PATCHES, HIDDEN, PROJ_DIM, N_HEADS, PATCH_SIZE,
      LAYER_NORM_EPS);
  ASSERT_NE(out.head_out, nullptr);

  struct ggml_cgraph* gf = ggml_new_graph_custom(
      ctx_g, /*size=*/8192, /*grads=*/false);
  ggml_build_forward_expand(gf, out.head_out);
  ASSERT_EQ(ggml_graph_compute_with_ctx(ctx_g, gf, /*n_threads=*/4),
            GGML_STATUS_SUCCESS);

  // ── 4. Compare against vision.head_out[cam0]. ─────────────────────────
  ASSERT_EQ(ggml_nelements(out.head_out),
            static_cast<int64_t>(N_PATCHES * PROJ_DIM));
  const float* got = static_cast<const float*>(out.head_out->data);
  const float cos = cosineSim(got, expected.data(), expected.size());
  const float diff = maxAbsDiff(got, expected.data(), expected.size());

  float max_abs_expected = 0.0f;
  double sum_sq_diff = 0.0;
  for (size_t i = 0; i < expected.size(); ++i) {
    const float a = std::fabs(expected[i]);
    if (a > max_abs_expected) {
      max_abs_expected = a;
    }
    const double d = static_cast<double>(got[i]) - expected[i];
    sum_sq_diff += d * d;
  }
  const float rms_diff =
      static_cast<float>(std::sqrt(sum_sq_diff / expected.size()));
  std::cerr << "[M3.3] head_out: cos=" << cos
            << " max_abs_diff=" << diff
            << " rms_diff=" << rms_diff
            << " max_abs_expected=" << max_abs_expected
            << " rel_max=" << (diff / std::max(max_abs_expected, 1e-9f))
            << "\n";

  // q_aggressive Q5_0 vision across 27 blocks. Observed cos ~0.9995 and
  // rel_max ~0.031; bars give ~2× headroom for cross-hardware variance.
  EXPECT_GT(cos, 0.999f);
  EXPECT_LT(diff / std::max(max_abs_expected, 1e-9f), 0.07f);

  ggml_free(ctx_g);
  gguf_free(gguf);
  ggml_free(ctx_w);
}
