#include <cstdint>
#include <cstring>
#include <string>
#include <tuple>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>

#include "utils/safetensors_lite.hpp"

// Property tests over the custom safetensors v1 header parser. The on-disk
// format is an attacker-controlled uint64 header length followed by a
// hand-rolled JSON-ish object — the same length-field class as the NMT
// n_dims overflow. See docs/architecture/ADDON-FUZZING.md.

namespace {

using qvac_vla_safetensors_lite::Reader;

std::vector<uint8_t> makeSafetensors(
    const std::string& header, const std::vector<uint8_t>& blob) {
  std::vector<uint8_t> out(8 + header.size() + blob.size());
  const uint64_t headerLen = header.size();
  std::memcpy(out.data(), &headerLen, 8);
  std::memcpy(out.data() + 8, header.data(), header.size());
  if (!blob.empty()) {
    std::memcpy(out.data() + 8 + header.size(), blob.data(), blob.size());
  }
  return out;
}

std::vector<uint8_t> validOneTensorSeed() {
  const std::string header =
      R"({"w":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}})";
  const std::vector<uint8_t> blob(4, 0);
  return makeSafetensors(header, blob);
}

void HeaderNeverCrashes(const std::vector<uint8_t>& bytes) {
  try {
    Reader reader;
    reader.openFromMemory(bytes.data(), bytes.size());
    if (reader.has("w")) {
      (void)reader.record("w");
    }
  } catch (const std::runtime_error&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(SafetensorsLiteFuzz, HeaderNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::vector<uint8_t>>().WithMaxSize(512))
    .WithSeeds([] {
      return std::vector<std::tuple<std::vector<uint8_t>>>{
          {validOneTensorSeed()},
          {makeSafetensors("{}", {})},
          {makeSafetensors(R"({"__metadata__":{}})", {})},
          {std::vector<uint8_t>(4, 0)},
      };
    });

TEST(SafetensorsLiteFuzzSeeds, ValidSeedParsesAndReadsF32) {
  const std::vector<uint8_t> bytes = validOneTensorSeed();
  Reader reader;
  ASSERT_NO_THROW(reader.openFromMemory(bytes.data(), bytes.size()));
  ASSERT_TRUE(reader.has("w"));
  std::vector<float> values;
  EXPECT_NO_THROW(values = reader.readF32("w"));
  ASSERT_EQ(values.size(), 1U);
  EXPECT_EQ(values[0], 0.0F);
}

TEST(SafetensorsLiteFuzzSeeds, HugeHeaderLengthIsRejected) {
  std::vector<uint8_t> bytes(16, 0);
  const uint64_t huge = Reader::kMaxHeaderLength + 1;
  std::memcpy(bytes.data(), &huge, 8);
  Reader reader;
  EXPECT_THROW(
      reader.openFromMemory(bytes.data(), bytes.size()), std::runtime_error);
}

} // namespace
