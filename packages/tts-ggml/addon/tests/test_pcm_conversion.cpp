// Unit tests for the shared float->int16 PCM conversion (PcmConversion.hpp),
// centralized from the two engines during the coding-standards refactor.

#include <cmath>
#include <cstdint>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/PcmConversion.hpp"

using qvac::ttsggml::kInt16PcmScale;
using qvac::ttsggml::pcmFloatToInt16;

TEST(PcmConversion, ScaleIsSymmetricFullScale) {
  EXPECT_FLOAT_EQ(kInt16PcmScale, 32767.0f);
}

TEST(PcmConversion, MapsEndpointsToSymmetricFullScale) {
  const std::vector<float> in{0.0f, 1.0f, -1.0f};
  const auto out = pcmFloatToInt16(in);
  ASSERT_EQ(out.size(), 3u);
  EXPECT_EQ(out[0], 0);
  EXPECT_EQ(out[1], static_cast<int16_t>(32767));
  EXPECT_EQ(out[2], static_cast<int16_t>(-32767));
}

TEST(PcmConversion, ClampsOutOfRangeInput) {
  const std::vector<float> in{2.0f, -2.0f, 1.5f, -3.3f};
  const auto out = pcmFloatToInt16(in);
  EXPECT_EQ(out[0], static_cast<int16_t>(32767));
  EXPECT_EQ(out[1], static_cast<int16_t>(-32767));
  EXPECT_EQ(out[2], static_cast<int16_t>(32767));
  EXPECT_EQ(out[3], static_cast<int16_t>(-32767));
}

TEST(PcmConversion, RoundsHalfAwayFromZero) {
  // 0.5 * 32767 = 16383.5 -> std::lround rounds half away from zero.
  const std::vector<float> in{0.5f, -0.5f};
  const auto out = pcmFloatToInt16(in);
  EXPECT_EQ(out[0], static_cast<int16_t>(16384));
  EXPECT_EQ(out[1], static_cast<int16_t>(-16384));
}

TEST(PcmConversion, PointerAndVectorOverloadsAgree) {
  const std::vector<float> in{0.1f, -0.2f, 0.9f, -0.9f, 0.0f};
  const auto viaVector = pcmFloatToInt16(in);
  const auto viaPointer = pcmFloatToInt16(in.data(), in.size());
  EXPECT_EQ(viaVector, viaPointer);
}
