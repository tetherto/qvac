// C++ API-surface test for GrootModel at the IVlaModel boundary — the cheap,
// no-inference counterpart to test_groot_infer_parity.cpp. Covers only what
// parity doesn't: hparams surface, backend name / hasGpu on forceCpu, and
// host-side input rejection (guards infer() applies before any compute).

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/groot.hpp"
#include "model-interface/vla_model.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

constexpr int N_IMAGES = 2; // LIBERO v4 fixture: image + wrist_image
constexpr int PATCHES_PER_IMG = 256;
constexpr int IN_FLAT = 1536;
constexpr int T_TOK = 148; // LIBERO v4 fixture: 128 image + 20 text tokens
constexpr int IMAGE_TOKEN_ID = 151655;
constexpr int STATE_DIM = 132;
constexpr int N_ACT = 40;
constexpr int ACT_DIM = 132;
constexpr int IMAGE_SIZE = 256;
constexpr int NUM_CAMERAS = 2;
constexpr int N_MERGED =
    128; // 2 imgs × 64 merged patches — image-placeholder count

const char* envOrNull(const char* name) {
  const char* v = std::getenv(name);
  return (v != nullptr && v[0] != '\0') ? v : nullptr;
}

} // namespace

TEST(GrootSurface, HparamsBackendSurfaceAndHostRejection) {
  const char* ggufPath = envOrNull("GROOT_TEST_GGUF");
  const char* actPath = envOrNull("GROOT_TEST_ACTIVATIONS_V4");
  if (ggufPath == nullptr || actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_GGUF and GROOT_TEST_ACTIVATIONS_V4 to run "
                    "the GrootModel surface test.";
  }

  // ── Real fixture inputs (same as the smoke test) ──────────────────────
  qvac_vla_safetensors_lite::Reader act;
  ASSERT_NO_THROW(act.open(actPath));

  const std::vector<float> patches = act.readF32("vision_input.call0.args.0");
  ASSERT_EQ(
      patches.size(),
      static_cast<size_t>(N_IMAGES) * PATCHES_PER_IMG * IN_FLAT);
  std::vector<const float*> images(N_IMAGES);
  for (int i = 0; i < N_IMAGES; ++i) {
    images[i] =
        patches.data() + static_cast<size_t>(i) * PATCHES_PER_IMG * IN_FLAT;
  }

  const std::vector<float> state =
      act.readF32("state_encoder_input.call0.args.0");
  ASSERT_EQ(state.size(), static_cast<size_t>(STATE_DIM));
  const std::vector<float> noise =
      act.readF32("action_encoder_input.call0.args.0");
  ASSERT_EQ(noise.size(), static_cast<size_t>(N_ACT) * ACT_DIM);

  const std::vector<float> vpm =
      act.readF32("text_model_input.call0.kwargs.visual_pos_masks");
  ASSERT_EQ(vpm.size(), static_cast<size_t>(T_TOK));
  std::vector<int32_t> tokens(T_TOK);
  for (int t = 0; t < T_TOK; ++t) {
    tokens[t] = (vpm[t] > 0.5f) ? IMAGE_TOKEN_ID : (1000 + t);
  }
  std::vector<char> langMaskBuf(T_TOK, 1);
  const bool* langMask = reinterpret_cast<const bool*>(langMaskBuf.data());

  // ── Load model ────────────────────────────────────────────────────────
  using qvac_lib_infer_vla_ggml::GrootModel;
  using qvac_lib_infer_vla_ggml::VlaHparamsGeneric;
  using qvac_lib_infer_vla_ggml::VlaTimingGeneric;
  auto model = std::make_unique<GrootModel>(
      std::string(ggufPath), /*forceCpu=*/true, /*backendsDir=*/"");
  ASSERT_NE(model, nullptr);

  // ── hparams surface ───────────────────────────────────────────────────
  const auto& hp = model->hparams();
  EXPECT_EQ(hp.chunk_size, N_ACT);
  EXPECT_EQ(hp.action_dim, ACT_DIM);
  EXPECT_EQ(hp.max_action_dim, ACT_DIM);
  EXPECT_EQ(hp.max_state_dim, STATE_DIM);
  EXPECT_EQ(hp.vision_image_size, IMAGE_SIZE);
  EXPECT_EQ(hp.num_cameras, NUM_CAMERAS);
  EXPECT_EQ(hp.state_input_mode, VlaHparamsGeneric::StateInputMode::Continuous);

  // ── Backend surface (forceCpu) ────────────────────────────────────────
  std::string backendNameLower = model->backendName();
  std::transform(
      backendNameLower.begin(),
      backendNameLower.end(),
      backendNameLower.begin(),
      [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  EXPECT_EQ(backendNameLower, "cpu");
  EXPECT_FALSE(model->hasGpu());

  // ── Host-side rejection matrix ────────────────────────────────────────
  // Each variant must be rejected by infer()'s guards BEFORE any graph
  // build / compute. Reuse the otherwise-valid inputs and vary one arg.
  std::vector<float> actionsOut(static_cast<size_t>(N_ACT) * ACT_DIM, 0.0f);
  int nActionsOut = -1;
  VlaTimingGeneric timing{};

  auto callWith = [&](const float** imgs,
                      int nImages,
                      int imgW,
                      int imgH,
                      const float* st,
                      int stDim,
                      const int32_t* toks,
                      const bool* mask,
                      int len) {
    nActionsOut = -1;
    return model->infer(
        imgs,
        nImages,
        imgW,
        imgH,
        st,
        stDim,
        toks,
        mask,
        len,
        noise.data(),
        actionsOut.data(),
        &nActionsOut,
        &timing);
  };

  // nImages < 1.
  EXPECT_FALSE(callWith(
      images.data(),
      0,
      IMAGE_SIZE,
      IMAGE_SIZE,
      state.data(),
      STATE_DIM,
      tokens.data(),
      langMask,
      T_TOK));

  // Non-square image dims.
  EXPECT_FALSE(callWith(
      images.data(),
      N_IMAGES,
      IMAGE_SIZE,
      IMAGE_SIZE + 16,
      state.data(),
      STATE_DIM,
      tokens.data(),
      langMask,
      T_TOK));

  // Zero image dim.
  EXPECT_FALSE(callWith(
      images.data(),
      N_IMAGES,
      0,
      0,
      state.data(),
      STATE_DIM,
      tokens.data(),
      langMask,
      T_TOK));

  // state_dim mismatch (must equal max_state_dim).
  EXPECT_FALSE(callWith(
      images.data(),
      N_IMAGES,
      IMAGE_SIZE,
      IMAGE_SIZE,
      state.data(),
      STATE_DIM - 1,
      tokens.data(),
      langMask,
      T_TOK));

  // Wrong image-placeholder-token count: drop one image token so
  // nImgTok != nMerged.
  {
    std::vector<int32_t> badTokens = tokens;
    for (int t = 0; t < T_TOK; ++t) {
      if (badTokens[t] == IMAGE_TOKEN_ID) {
        badTokens[t] = 42; // demote a single placeholder to a text id
        break;
      }
    }
    int imgTok = 0;
    for (int t = 0; t < T_TOK; ++t) {
      if (badTokens[t] == IMAGE_TOKEN_ID) {
        ++imgTok;
      }
    }
    ASSERT_EQ(imgTok, N_MERGED - 1); // sanity: we really removed one
    EXPECT_FALSE(callWith(
        images.data(),
        N_IMAGES,
        IMAGE_SIZE,
        IMAGE_SIZE,
        state.data(),
        STATE_DIM,
        badTokens.data(),
        langMask,
        T_TOK));
  }

  // Null required pointers.
  EXPECT_FALSE(callWith(
      images.data(),
      N_IMAGES,
      IMAGE_SIZE,
      IMAGE_SIZE,
      /*state=*/nullptr,
      STATE_DIM,
      tokens.data(),
      langMask,
      T_TOK));
  EXPECT_FALSE(callWith(
      /*images=*/nullptr,
      N_IMAGES,
      IMAGE_SIZE,
      IMAGE_SIZE,
      state.data(),
      STATE_DIM,
      tokens.data(),
      langMask,
      T_TOK));

  // A per-image null pointer inside an otherwise-valid array.
  {
    std::vector<const float*> badImgs = images;
    badImgs[1] = nullptr;
    EXPECT_FALSE(callWith(
        badImgs.data(),
        N_IMAGES,
        IMAGE_SIZE,
        IMAGE_SIZE,
        state.data(),
        STATE_DIM,
        tokens.data(),
        langMask,
        T_TOK));
  }

  // All rejections must leave nActionsOut untouched (never written on the
  // early-return paths).
  EXPECT_EQ(nActionsOut, -1);
}
