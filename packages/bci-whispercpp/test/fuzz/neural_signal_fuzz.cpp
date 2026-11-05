#include <cstdint>
#include <cstring>
#include <limits>
#include <tuple>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/bci/NeuralSignalParse.hpp"

// Property tests over the length-prefixed neural-signal parser. The original
// overflow class is uint32 * uint32 * sizeof(float) wrapping size_t before
// the truncated-buffer check. StatusError is the expected reject; ASan abort
// is the finding. See docs/architecture/ADDON-FUZZING.md.

namespace {

using qvac_errors::StatusError;
using qvac_lib_inference_addon_bci::K_NEURAL_SIGNAL_HEADER_BYTES;
using qvac_lib_inference_addon_bci::readNeuralFeatures;

std::vector<uint8_t> signalBytes(
    uint32_t timesteps, uint32_t channels, const std::vector<float>& samples) {
  std::vector<uint8_t> bytes(
      K_NEURAL_SIGNAL_HEADER_BYTES + samples.size() * sizeof(float));
  std::memcpy(bytes.data(), &timesteps, sizeof(uint32_t));
  std::memcpy(bytes.data() + sizeof(uint32_t), &channels, sizeof(uint32_t));
  if (!samples.empty()) {
    std::memcpy(
        bytes.data() + K_NEURAL_SIGNAL_HEADER_BYTES, samples.data(),
        samples.size() * sizeof(float));
  }
  return bytes;
}

void ReadFeaturesNeverCrashes(const std::vector<uint8_t>& bytes) {
  uint32_t timesteps = 0;
  uint32_t channels = 0;
  try {
    (void)readNeuralFeatures(bytes, timesteps, channels);
  } catch (const StatusError&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(NeuralSignalFuzz, ReadFeaturesNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::vector<uint8_t>>().WithMaxSize(4096))
    .WithSeeds([] {
      const uint32_t maxU32 = std::numeric_limits<uint32_t>::max();
      return std::vector<std::tuple<std::vector<uint8_t>>>{
          {{}},
          {std::vector<uint8_t>(3, 0)},
          {signalBytes(0, 0, {})},
          {signalBytes(2, 2, {1.0F, 2.0F, 3.0F, 4.0F})},
          {signalBytes(maxU32, maxU32, {})},
          {signalBytes(maxU32, 2, {})},
          {signalBytes(1, 1, {})},
      };
    });

TEST(NeuralSignalFuzzSeeds, ValidTwoByTwoStillParses) {
  uint32_t timesteps = 0;
  uint32_t channels = 0;
  const auto features =
      readNeuralFeatures(signalBytes(2, 2, {1.0F, 2.0F, 3.0F, 4.0F}),
                         timesteps, channels);
  EXPECT_EQ(timesteps, 2U);
  EXPECT_EQ(channels, 2U);
  ASSERT_EQ(features.size(), 4U);
  EXPECT_EQ(features[0], 1.0F);
  EXPECT_EQ(features[3], 4.0F);
}

TEST(NeuralSignalFuzzSeeds, DimensionOverflowIsRejectedWithoutHugeAlloc) {
  uint32_t timesteps = 0;
  uint32_t channels = 0;
  const uint32_t maxU32 = std::numeric_limits<uint32_t>::max();
  EXPECT_THROW(
      readNeuralFeatures(signalBytes(maxU32, maxU32, {}), timesteps, channels),
      StatusError);
}

TEST(NeuralSignalFuzzSeeds, TruncatedPayloadIsRejected) {
  uint32_t timesteps = 0;
  uint32_t channels = 0;
  EXPECT_THROW(
      readNeuralFeatures(signalBytes(1, 1, {}), timesteps, channels),
      StatusError);
}

} // namespace
