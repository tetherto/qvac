#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>

#include <gtest/gtest.h>

#include "utils/VideoModelCapabilities.hpp"
#include "utils/VideoProgress.hpp"

namespace {

template <typename T> void write(std::ofstream& output, T value) {
  output.write(reinterpret_cast<const char*>(&value), sizeof(value));
}

void writeString(std::ofstream& output, const std::string& value) {
  write(output, static_cast<uint64_t>(value.size()));
  output.write(value.data(), static_cast<std::streamsize>(value.size()));
}

void writeTensor(
    std::ofstream& output, const std::string& name,
    const std::array<uint64_t, 4>& dimensions, uint32_t dimensionCount = 4) {
  writeString(output, name);
  write(output, dimensionCount);
  for (uint32_t i = 0; i < dimensionCount; ++i)
    write(output, dimensions[i]);
  write(output, uint32_t{0}); // GGML_TYPE_F32
  write(output, uint64_t{0}); // tensor data offset is not inspected
}

std::filesystem::path makeWan22Ti2vGguf() {
  const auto path = std::filesystem::temp_directory_path() /
                    "qvac-renamed-turbo-capabilities.gguf";
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  EXPECT_TRUE(output.good());
  write(output, uint32_t{0x46554747}); // "GGUF"
  write(output, uint32_t{3});
  write(output, uint64_t{2});
  write(output, uint64_t{0});
  writeTensor(
      output,
      "model.diffusion_model.blocks.0.cross_attn.norm_k.weight",
      {1, 1, 1, 1});
  writeTensor(
      output,
      "model.diffusion_model.patch_embedding.weight",
      {1, 1, 1, 147456});
  output.close();
  return path;
}

} // namespace

TEST(VideoModelCapabilities, DetectsWan22Ti2vFromRenamedGgufContents) {
  const auto path = makeWan22Ti2vGguf();
  const auto capabilities =
      qvac_lib_inference_addon_sd::inspectVideoModelCapabilities(path.string());
  std::filesystem::remove(path);

  EXPECT_EQ(capabilities.spatialAlignment, 32);
}

TEST(VideoModelCapabilities, FallsBackToWan21CompatibleAlignment) {
  const auto capabilities =
      qvac_lib_inference_addon_sd::inspectVideoModelCapabilities(
          "/missing/model.gguf");

  EXPECT_EQ(capabilities.spatialAlignment, 16);
}

TEST(
    VideoProgress,
    LoadedHighNoiseExpertWithZeroBoundarySentinelUsesOneDenoiseSequence) {
  EXPECT_EQ(
      qvac_lib_inference_addon_sd::expectedVideoDenoiseSequences(
          /*hasLoadedHighNoiseExpert=*/true,
          /*highNoiseSteps=*/-1,
          /*moeBoundary=*/0.0f),
      1);
}

TEST(VideoProgress, LoadedHighNoiseExpertWithPositiveStepsUsesTwoSequences) {
  EXPECT_EQ(
      qvac_lib_inference_addon_sd::expectedVideoDenoiseSequences(
          /*hasLoadedHighNoiseExpert=*/true,
          /*highNoiseSteps=*/8,
          /*moeBoundary=*/0.0f),
      2);
}
