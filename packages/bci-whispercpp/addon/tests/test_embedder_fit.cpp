#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/bci/EmbedderFit.hpp"
#include "model-interface/bci/NeuralProcessor.hpp"

using namespace qvac_lib_inference_addon_bci;

namespace {

constexpr uint64_t K_ELEMENT_BYTES = sizeof(float);
constexpr uint64_t K_FEATURES = 4;
constexpr uint64_t K_RANK = 2;
constexpr uint64_t K_DAYS = 2;
constexpr uint64_t K_MONTHS = 1;
constexpr uint64_t K_SESSIONS = 3;
constexpr uint64_t K_LARGEST_CONV = 8;
constexpr size_t K_TRUNCATED_BYTES = 4;
constexpr size_t K_RANK_OFFSET = 9 * sizeof(uint32_t);

std::string fixture(const std::string& name) {
  return std::string(BCI_TEST_FIXTURES_DIR) + "/" + name;
}

std::vector<char> readBytes(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

std::string writeTemp(const std::string& name, const std::vector<char>& bytes) {
  const auto path = std::filesystem::temp_directory_path() / name;
  std::ofstream(path, std::ios::binary)
      .write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  return path.string();
}

uint64_t expectedResidentBytes() {
  const uint64_t day = K_FEATURES * K_RANK + K_RANK * K_FEATURES + K_FEATURES;
  const uint64_t month = K_FEATURES * K_FEATURES + K_FEATURES;
  return (K_DAYS * day + K_MONTHS * month + K_SESSIONS) * K_ELEMENT_BYTES;
}

uint64_t expectedProjectionCacheBytes() {
  return (K_FEATURES * K_FEATURES + K_FEATURES) * K_ELEMENT_BYTES;
}

} // namespace

TEST(EmbedderFit, MeasuresTheResidentWeightsOfAnEmbedderFile) {
  const auto footprint = measureEmbedder(fixture("bci-embedder-small.bin"));

  ASSERT_TRUE(footprint.has_value());
  EXPECT_EQ(footprint->residentBytes, expectedResidentBytes());
  EXPECT_EQ(footprint->projectionCacheBytes, expectedProjectionCacheBytes());
  EXPECT_EQ(footprint->largestTransientBytes, K_LARGEST_CONV * K_ELEMENT_BYTES);
  EXPECT_EQ(
      footprint->hostBytes(),
      expectedResidentBytes() + expectedProjectionCacheBytes());
}

TEST(EmbedderFit, ADescriptionMeasuresLikeTheFileItDescribes) {
  const auto file = measureEmbedder(fixture("bci-embedder-small.bin"));
  const auto description =
      measureEmbedder(fixture("bci-embedder-small.fit.gguf"));

  ASSERT_TRUE(file.has_value());
  ASSERT_TRUE(description.has_value());
  EXPECT_EQ(description->residentBytes, file->residentBytes);
  EXPECT_EQ(description->projectionCacheBytes, file->projectionCacheBytes);
  EXPECT_EQ(description->largestTransientBytes, file->largestTransientBytes);
}

TEST(EmbedderFit, AFileTheLoaderAcceptsIsMeasured) {
  NeuralProcessor processor;
  EXPECT_TRUE(processor.loadEmbedderWeights(fixture("bci-embedder-small.bin")));
  EXPECT_TRUE(measureEmbedder(fixture("bci-embedder-small.bin")).has_value());
}

TEST(EmbedderFit, ATruncatedFileIsRefused) {
  auto bytes = readBytes(fixture("bci-embedder-small.bin"));
  bytes.resize(bytes.size() - K_TRUNCATED_BYTES);
  const auto path = writeTemp("bci-embedder-truncated.bin", bytes);

  EXPECT_FALSE(measureEmbedder(path).has_value());
  std::filesystem::remove(path);
}

TEST(EmbedderFit, ArraysThatDoNotMatchTheHeaderAreRefused) {
  auto bytes = readBytes(fixture("bci-embedder-small.bin"));
  bytes[K_RANK_OFFSET] = static_cast<char>(K_RANK + 1);
  const auto path = writeTemp("bci-embedder-mismatched.bin", bytes);

  EXPECT_FALSE(measureEmbedder(path).has_value());
  std::filesystem::remove(path);
}

TEST(EmbedderFit, AMissingFileIsRefused) {
  EXPECT_FALSE(measureEmbedder(fixture("absent-embedder.bin")).has_value());
}

TEST(EmbedderFit, ADescriptionOfAnotherFormatIsRefused) {
  EXPECT_FALSE(
      measureEmbedder(fixture("bci-whisper-header.fit.gguf")).has_value());
}

TEST(EmbedderFit, TheColocatedEmbedderSitsBesideTheModel) {
  EXPECT_EQ(
      colocatedEmbedderPath("/models/ggml-bci-windowed.bin"),
      "/models/bci-embedder.bin");
  EXPECT_EQ(
      colocatedEmbedderPath("C:\\models\\ggml-bci-windowed.bin"),
      "C:\\models/bci-embedder.bin");
  EXPECT_EQ(
      colocatedEmbedderPath("ggml-bci-windowed.bin"), "./bci-embedder.bin");
}
