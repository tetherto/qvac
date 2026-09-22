#include <cstdint>
#include <cstring>
#include <tuple>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>

#include "utils/VideoModelCapabilities.hpp"

// Property tests over GGUF capability inspection. Malformed files return the
// default capability set rather than crashing or hanging on an unbounded
// string length. See docs/architecture/ADDON-FUZZING.md.

namespace {

using qvac_lib_inference_addon_sd::inspectVideoModelCapabilities;
using qvac_lib_inference_addon_sd::VideoModelCapabilities;

constexpr uint32_t K_GGUF_MAGIC = 0x46554747;

template <typename T>
void appendLe(std::vector<uint8_t>& out, T value) {
  uint8_t bytes[sizeof(T)];
  std::memcpy(bytes, &value, sizeof(T));
  out.insert(out.end(), bytes, bytes + sizeof(T));
}

std::vector<uint8_t> emptyGguf(uint32_t version = 3) {
  std::vector<uint8_t> bytes;
  appendLe<uint32_t>(bytes, K_GGUF_MAGIC);
  appendLe<uint32_t>(bytes, version);
  appendLe<uint64_t>(bytes, 0);
  appendLe<uint64_t>(bytes, 0);
  return bytes;
}

std::vector<uint8_t> hugeKvStringGguf() {
  std::vector<uint8_t> bytes;
  appendLe<uint32_t>(bytes, K_GGUF_MAGIC);
  appendLe<uint32_t>(bytes, 3);
  appendLe<uint64_t>(bytes, 0);
  appendLe<uint64_t>(bytes, 1);
  appendLe<uint64_t>(bytes, uint64_t{1} << 40);
  return bytes;
}

void InspectNeverCrashes(const std::vector<uint8_t>& bytes) {
  (void)inspectVideoModelCapabilities(
      bytes.empty() ? nullptr : bytes.data(), bytes.size());
}
FUZZ_TEST(VideoModelCapabilitiesFuzz, InspectNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::vector<uint8_t>>().WithMaxSize(4096))
    .WithSeeds([] {
      return std::vector<std::tuple<std::vector<uint8_t>>>{
          {{}},
          {emptyGguf()},
          {emptyGguf(2)},
          {hugeKvStringGguf()},
          {{'G', 'G', 'U', 'F'}},
      };
    });

TEST(VideoModelCapabilitiesFuzzSeeds, EmptyBufferKeepsDefaults) {
  const VideoModelCapabilities caps =
      inspectVideoModelCapabilities(nullptr, 0);
  EXPECT_EQ(caps.spatialAlignment, 16);
  EXPECT_FALSE(caps.isMiniMaxH3);
}

TEST(VideoModelCapabilitiesFuzzSeeds, EmptyGgufKeepsDefaults) {
  const auto bytes = emptyGguf();
  const VideoModelCapabilities caps =
      inspectVideoModelCapabilities(bytes.data(), bytes.size());
  EXPECT_EQ(caps.spatialAlignment, 16);
  EXPECT_EQ(caps.frameCountStride, 4);
}

TEST(VideoModelCapabilitiesFuzzSeeds, HugeKvStringDoesNotHang) {
  const auto bytes = hugeKvStringGguf();
  const VideoModelCapabilities caps =
      inspectVideoModelCapabilities(bytes.data(), bytes.size());
  EXPECT_EQ(caps.spatialAlignment, 16);
}

} // namespace
