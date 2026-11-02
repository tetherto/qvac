#include <cstdint>
#include <tuple>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>

#include "model-interface/PcmDecode.hpp"

// Property tests over the s16le PCM decoder extracted from ParakeetModel.
// Allocation is bounded by the input size (odd trailing byte dropped). The
// target compiles the header without whisper/parakeet/fabric so ASan +
// LeakSanitizer stay at full strength. See docs/architecture/ADDON-FUZZING.md.

namespace {

using qvac::asrggml::decodeS16lePcm;
using qvac::asrggml::pcmS16ToFloat32;
using qvac::asrggml::readLittleEndianS16;

std::vector<uint8_t> s16leSeed(const std::vector<int16_t>& samples) {
  std::vector<uint8_t> bytes(samples.size() * 2);
  for (std::size_t i = 0; i < samples.size(); ++i) {
    const auto sample = static_cast<uint16_t>(samples[i]);
    bytes[i * 2] = static_cast<uint8_t>(sample & 0xffU);
    bytes[i * 2 + 1] = static_cast<uint8_t>((sample >> 8) & 0xffU);
  }
  return bytes;
}

void DecodeS16leNeverCrashes(const std::vector<uint8_t>& bytes) {
  (void)decodeS16lePcm(bytes);
}
FUZZ_TEST(PcmDecodeFuzz, DecodeS16leNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::vector<uint8_t>>().WithMaxSize(4096))
    .WithSeeds([] {
      return std::vector<std::tuple<std::vector<uint8_t>>>{
          {{}},
          {{0x00}},
          {s16leSeed({0})},
          {s16leSeed({-32768, -1, 0, 1, 32767})},
          {{0xff, 0x7f, 0x00}},
      };
    });

TEST(PcmDecodeFuzzSeeds, EmptyAndOddLengthDoNotOverRead) {
  EXPECT_TRUE(decodeS16lePcm({}).empty());
  EXPECT_TRUE(decodeS16lePcm({0x12}).empty());
  const auto odd = decodeS16lePcm({0x00, 0x01, 0xff});
  ASSERT_EQ(odd.size(), 1U);
  EXPECT_EQ(odd[0], pcmS16ToFloat32(readLittleEndianS16(0x00, 0x01)));
}

TEST(PcmDecodeFuzzSeeds, KnownSamplesScaleToFloat32) {
  const auto decoded = decodeS16lePcm(s16leSeed({-32768, 0, 32767}));
  ASSERT_EQ(decoded.size(), 3U);
  EXPECT_EQ(decoded[0], pcmS16ToFloat32(-32768));
  EXPECT_EQ(decoded[1], 0.0F);
  EXPECT_EQ(decoded[2], pcmS16ToFloat32(32767));
}

} // namespace
