// M4.7 parity: locks grootDeriveMRopePositions (the Qwen3-VL 3-axis M-RoPE
// position-id derivation, done C++-side in infer) against the oracle's
// text_model_input.position_ids.
//
// The oracle dumps position_ids and visual_pos_masks but NOT input_ids, so we
// synthesize langTokens with the image-placeholder id at every image position
// (visual_pos_masks == 1) and arbitrary distinct ids elsewhere —
// grootDeriveMRopePositions only branches on == imageTokenId, so the text ids'
// values don't affect the derived positions.

#include <cstdint>
#include <cstdlib>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/groot.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

constexpr int T_TOK = 148; // LIBERO v4 fixture: 128 image + 20 text tokens
constexpr int IMAGE_TOKEN_ID = 151655; // Qwen3-VL placeholder
constexpr int MERGED_GRID = 8;         // 256/16/2 per image

const char* envOrNull(const char* n) {
  const char* v = std::getenv(n);
  return (v != nullptr && v[0] != '\0') ? v : nullptr;
}

} // namespace

TEST(GrootM4_7, MRopePositionsMatchPytorch) {
  const char* actPath = envOrNull("GROOT_TEST_ACTIVATIONS_V4");
  if (actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_ACTIVATIONS_V4 to run the M4.7 position-id "
                    "parity test.";
  }
  qvac_vla_safetensors_lite::Reader act;
  ASSERT_NO_THROW(act.open(actPath));

  // visual_pos_masks [1,148] — 1 at image-token positions.
  const std::vector<float> vpm =
      act.readF32("text_model_input.call0.kwargs.visual_pos_masks");
  ASSERT_EQ(vpm.size(), static_cast<size_t>(T_TOK));

  // position_ids [3,1,148] — axis-major (temporal, height, width).
  const std::vector<float> expPos =
      act.readF32("text_model_input.call0.kwargs.position_ids");
  ASSERT_EQ(expPos.size(), static_cast<size_t>(3 * T_TOK));

  // Synthesize langTokens: image id at image positions, distinct text ids else.
  std::vector<int32_t> tokens(T_TOK);
  for (int t = 0; t < T_TOK; ++t) {
    tokens[t] = (vpm[t] > 0.5f) ? IMAGE_TOKEN_ID : (1000 + t);
  }

  std::vector<int32_t> got(static_cast<size_t>(T_TOK) * 4);
  qvac_lib_infer_vla_ggml::grootDeriveMRopePositions(
      tokens.data(),
      T_TOK,
      IMAGE_TOKEN_ID,
      MERGED_GRID,
      MERGED_GRID,
      got.data());

  // Compare the 3 real axes exactly (integer, no tolerance).
  int mismatches = 0;
  int firstBad = -1;
  for (int ax = 0; ax < 3; ++ax) {
    for (int t = 0; t < T_TOK; ++t) {
      const int expv = static_cast<int>(expPos[ax * T_TOK + t]);
      const int gotv = got[ax * T_TOK + t];
      if (expv != gotv) {
        if (firstBad < 0)
          firstBad = ax * T_TOK + t;
        ++mismatches;
      }
    }
  }
  EXPECT_EQ(mismatches, 0) << "first mismatch at flat idx " << firstBad;
}
