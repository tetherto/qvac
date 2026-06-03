// C++ integration test for `Pi05Model::infer` — the production entry
// point used by the JS addon. Same fixture as M3.13 but the call
// shape goes through `IVlaModel::infer` rather than calling the M3.x
// helpers directly. Catches:
//   * GGUF loader bugs (tensor naming drift, missing hparams, etc.)
//   * Multi-camera wiring (the test exercises all 3 cameras, vs M3.13
//     which short-circuited the SigLIP path)
//   * Embedding lookup integration (the production path computes
//     lang embeds, vs M3.13 which fed `vlm.prefix_concat` directly)
//   * `infer()`'s overall composition + timing population

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/pi05.hpp"
#include "model-interface/vla_model.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

constexpr int N_CAMERAS = 3;
constexpr int IMAGE_SIZE = 224;
constexpr int TOKEN_MAX_LEN = 200;
constexpr int VALID_TOKEN_LEN = 64; // fixture's real_len (build_fixture)
constexpr int N_ACT = 50;
constexpr int ACTION_DIM = 32;

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

TEST(Pi05Integration, InferEndToEndMatchesPytorch) {
  const char* gguf_path = envOrNull("PI05_TEST_GGUF");
  const char* fixture_path = envOrNull("PI05_TEST_FIXTURE");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (gguf_path == nullptr || fixture_path == nullptr ||
      activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_GGUF, PI05_TEST_FIXTURE and "
                    "PI05_TEST_ACTIVATIONS to run the integration test.";
  }

  // ── Fixture inputs ────────────────────────────────────────────────
  qvac_vla_safetensors_lite::Reader fixture;
  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(fixture.open(fixture_path));
  ASSERT_NO_THROW(activations.open(activations_path));

  const std::vector<float> images_all = fixture.readF32("fixture.images");
  const std::vector<float> noise = fixture.readF32("fixture.noise");
  const std::vector<float> expected_actions =
      activations.readF32("ode.actions_final");

  const size_t per_cam = 3 * IMAGE_SIZE * IMAGE_SIZE;
  ASSERT_EQ(images_all.size(), N_CAMERAS * per_cam);
  ASSERT_EQ(noise.size(), N_ACT * ACTION_DIM);

  // Pointer-to-pointer for images, one per camera.
  std::vector<const float*> image_ptrs(N_CAMERAS);
  for (int cam = 0; cam < N_CAMERAS; ++cam) {
    image_ptrs[cam] = images_all.data() + cam * per_cam;
  }

  // Tokens are I32 in the fixture; safetensors_lite only exposes F32
  // via readF32, so we re-read the raw byte range for tokens just like
  // the M3.4 test does.
  std::vector<int32_t> tokens(TOKEN_MAX_LEN);
  std::vector<uint8_t> token_mask(TOKEN_MAX_LEN);
  {
    const auto& tok_rec = fixture.record("fixture.tokens");
    const auto& mask_rec = fixture.record("fixture.mask");
    ASSERT_EQ(tok_rec.dtype, "I32");
    ASSERT_EQ(mask_rec.dtype, "BOOL");
    std::ifstream in(fixture_path, std::ios::binary);
    ASSERT_TRUE(in);
    uint64_t header_len = 0;
    in.read(reinterpret_cast<char*>(&header_len), 8);
    const std::streamoff blob_start =
        8 + static_cast<std::streamoff>(header_len);
    in.seekg(
        blob_start + static_cast<std::streamoff>(tok_rec.byte_offset),
        std::ios::beg);
    in.read(reinterpret_cast<char*>(tokens.data()), tok_rec.byte_length);
    ASSERT_TRUE(in);
    in.seekg(
        blob_start + static_cast<std::streamoff>(mask_rec.byte_offset),
        std::ios::beg);
    in.read(reinterpret_cast<char*>(token_mask.data()), mask_rec.byte_length);
    ASSERT_TRUE(in);
  }
  std::vector<bool> lang_mask_vec(TOKEN_MAX_LEN);
  for (int i = 0; i < TOKEN_MAX_LEN; ++i) {
    lang_mask_vec[i] = token_mask[i] != 0;
  }
  // std::vector<bool> is bit-packed and has no .data(); copy into a plain
  // bool[] for the C-style pointer the IVlaModel API takes.
  std::vector<bool> lang_mask_storage = lang_mask_vec;
  // Reinterpret to a contiguous bool array.
  std::unique_ptr<bool[]> lang_mask(new bool[TOKEN_MAX_LEN]);
  for (int i = 0; i < TOKEN_MAX_LEN; ++i) {
    lang_mask[i] = lang_mask_storage[i];
  }

  // Verify fixture matches the convention we baked into infer():
  // leading-contiguous valid range.
  int valid = 0;
  while (valid < TOKEN_MAX_LEN && lang_mask[valid]) {
    ++valid;
  }
  ASSERT_EQ(valid, VALID_TOKEN_LEN);

  // ── Load Pi05Model and run inference ─────────────────────────────
  using qvac_lib_infer_vla_ggml::Pi05Model;
  using qvac_lib_infer_vla_ggml::VlaTimingGeneric;
  auto model = std::make_unique<Pi05Model>(
      std::string(gguf_path), /*forceCpu=*/true, /*backendsDir=*/"");
  ASSERT_NE(model, nullptr);

  // hparams sanity check before inference.
  const auto& hp = model->hparams();
  EXPECT_EQ(hp.chunk_size, N_ACT);
  EXPECT_EQ(hp.action_dim, ACTION_DIM);
  EXPECT_EQ(hp.tokenizer_max_length, TOKEN_MAX_LEN);
  EXPECT_EQ(hp.vision_image_size, IMAGE_SIZE);
  EXPECT_EQ(hp.num_cameras, N_CAMERAS);
  EXPECT_EQ(
      hp.state_input_mode,
      qvac_lib_infer_vla_ggml::VlaHparamsGeneric::StateInputMode::Discrete);

  std::vector<float> actions_out(N_ACT * ACTION_DIM);
  int n_actions_out = 0;
  VlaTimingGeneric timing{};
  const bool ok = model->infer(
      image_ptrs.data(),
      N_CAMERAS,
      IMAGE_SIZE,
      IMAGE_SIZE,
      /*state=*/nullptr, // pi05 ignores `state` (discrete state lives in the
                         // prompt)
      /*state_dim=*/0,
      tokens.data(),
      lang_mask.get(),
      TOKEN_MAX_LEN,
      noise.data(),
      actions_out.data(),
      &n_actions_out,
      &timing);
  ASSERT_TRUE(ok);
  ASSERT_EQ(n_actions_out, N_ACT);

  // ── Compare against PyTorch ──────────────────────────────────────
  const float cos = cosineSim(
      actions_out.data(), expected_actions.data(), expected_actions.size());
  const float diff = maxAbsDiff(
      actions_out.data(), expected_actions.data(), expected_actions.size());
  float max_abs = 0.0f;
  for (float v : expected_actions) {
    const float a = std::fabs(v);
    if (a > max_abs) {
      max_abs = a;
    }
  }
  std::cerr << "[Pi05Integration] actions: cos=" << cos
            << " max_abs_diff=" << diff << " max_abs_expected=" << max_abs
            << " rel_max=" << (diff / std::max(max_abs, 1e-9f)) << "\n"
            << "[Pi05Integration] timing: vision=" << timing.vision_ms
            << "ms prefill=" << timing.prefill_total_ms
            << "ms ode=" << timing.ode_ms << "ms total=" << timing.total_ms
            << "ms\n";

  // Plan §5 end-to-end bar (CPU): cos > 0.999.
  EXPECT_GT(cos, 0.999f);
  EXPECT_LT(diff / std::max(max_abs, 1e-9f), 0.05f);
  EXPECT_GT(timing.total_ms, 0.0);
  EXPECT_EQ(model->backendName(), "cpu");
  EXPECT_FALSE(model->hasGpu());
}
