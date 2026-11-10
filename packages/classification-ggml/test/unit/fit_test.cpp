// fitVerdict and capToAppLimit on hand-built rows, plus assessModelFit on each
// model that is present: MobileNet from weights/ or
// QVAC_CLASSIFICATION_MODEL_PATH, MegaLoc from QVAC_MEGALOC_F16_MODEL_PATH,
// BridgeDepth from QVAC_BRIDGEDEPTH_MODEL_PATH. QVAC_FOOTPRINT_BACKEND picks
// the device for MegaLoc and BridgeDepth (default CPU, as footprint_test).

#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/ModelFit.hpp"
#include "model-interface/ModelFootprint.hpp"

namespace fit = classification_ggml::fit;

namespace {

constexpr uint64_t MI_B = 1024ULL * 1024ULL;
constexpr uint64_t FREE_BYTES = 1000 * MI_B;
constexpr uint64_t TOTAL_BYTES = 2000 * MI_B;

fit::FitDevice
row(const std::string& id, bool unified, uint64_t usedBytes,
    uint64_t freeBytes = FREE_BYTES) {
  return {id, id, unified, usedBytes, freeBytes, TOTAL_BYTES};
}

TEST(FitVerdict, FitsWhenUsagePlusMarginIsFree) {
  const std::vector<fit::FitDevice> rows{row("CPU", true, FREE_BYTES / 2)};
  EXPECT_EQ(fit::fitVerdict(rows, FREE_BYTES / 2), "fits");
  EXPECT_EQ(fit::fitVerdict(rows, FREE_BYTES / 2 + 1), "does-not-fit");
}

TEST(FitVerdict, MarginLargerThanFreeDoesNotFit) {
  const std::vector<fit::FitDevice> rows{row("CPU", true, 0)};
  EXPECT_EQ(fit::fitVerdict(rows, FREE_BYTES + 1), "does-not-fit");
}

TEST(FitVerdict, UnifiedRowsShareTheHostPool) {
  // Each row alone fits; together they take more than the host has free.
  const uint64_t share = FREE_BYTES / 2 + 1;
  const std::vector<fit::FitDevice> rows{
      row("MTL0", true, share), row("CPU", true, share)};
  EXPECT_EQ(fit::fitVerdict(rows, 0), "does-not-fit");
}

TEST(FitVerdict, UnifiedPoolUsesTheLowestFreeFigure) {
  const uint64_t gpuFree = FREE_BYTES / 4;
  const std::vector<fit::FitDevice> rows{
      row("MTL0", true, gpuFree, gpuFree), row("CPU", true, 1)};
  EXPECT_EQ(fit::fitVerdict(rows, 0), "does-not-fit");
}

TEST(FitVerdict, DiscreteDeviceIsItsOwnPool) {
  const uint64_t share = FREE_BYTES / 2 + 1;
  const std::vector<fit::FitDevice> fitting{
      row("0000:01:00.0", false, share), row("CPU", true, share)};
  EXPECT_EQ(fit::fitVerdict(fitting, 0), "fits");
  const std::vector<fit::FitDevice> over{
      row("0000:01:00.0", false, FREE_BYTES + 1), row("CPU", true, 0)};
  EXPECT_EQ(fit::fitVerdict(over, 0), "does-not-fit");
}

TEST(CapToAppLimit, CapsOnlyUnifiedRows) {
  const uint64_t limit = FREE_BYTES / 2;
  std::vector<fit::FitDevice> rows{
      row("0000:01:00.0", false, 0), row("CPU", true, 0)};
  fit::capToAppLimit(rows, limit);
  EXPECT_EQ(rows[0].freeBytes, FREE_BYTES);
  EXPECT_EQ(rows[1].freeBytes, limit);
}

TEST(CapToAppLimit, ExhaustedLimitDoesNotFit) {
  std::vector<fit::FitDevice> rows{row("CPU", true, 1)};
  fit::capToAppLimit(rows, 0);
  EXPECT_EQ(fit::fitVerdict(rows, 0), "does-not-fit");
}

std::string mobileNetPath() {
  const char* env = std::getenv("QVAC_CLASSIFICATION_MODEL_PATH");
  if (env != nullptr && std::filesystem::exists(env))
    return env;
  // The binary runs from build/test/unit; weights/ is in the package root.
  constexpr int maxParents = 6;
  std::filesystem::path here = std::filesystem::current_path();
  for (int i = 0; i < maxParents; ++i) {
    const auto candidate = here / "weights" / "mobilenetv3_3class_v3_fp16.gguf";
    if (std::filesystem::exists(candidate))
      return candidate.string();
    if (!here.has_parent_path())
      break;
    here = here.parent_path();
  }
  return "";
}

TEST(AssessModelFit, MobileNetIsOneHostRowWithTheMeasuredTerms) {
  const std::string path = mobileNetPath();
  if (path.empty())
    GTEST_SKIP() << "MobileNet weights not found";
  const auto footprint = classification_ggml::measureFootprint(
      path, "", "", fit::DEFAULT_FIT_WIDTH, fit::DEFAULT_FIT_HEIGHT);
  const auto result = fit::assessModelFit(
      path,
      "",
      "",
      fit::DEFAULT_FIT_WIDTH,
      fit::DEFAULT_FIT_HEIGHT,
      classification_ggml::DEFAULT_THREADS,
      0);
  ASSERT_EQ(result.status, "fits");
  ASSERT_EQ(result.devices.size(), 1U);
  EXPECT_EQ(result.devices[0].name, "CPU");
  EXPECT_TRUE(result.devices[0].unified);
  EXPECT_EQ(
      result.devices[0].usedBytes,
      footprint.hostWeightBytes + footprint.hostComputeBytes +
          footprint.hostWorkBytes + footprint.hostStagingBytes);

  const auto reserved = fit::assessModelFit(
      path,
      "",
      "",
      fit::DEFAULT_FIT_WIDTH,
      fit::DEFAULT_FIT_HEIGHT,
      classification_ggml::DEFAULT_THREADS,
      fit::MAX_JS_SAFE_INTEGER);
  EXPECT_EQ(reserved.status, "does-not-fit");
}

std::string envOr(const char* name, const std::string& fallback) {
  const char* value = std::getenv(name);
  return value != nullptr && *value != '\0' ? value : fallback;
}

// Each footprint term lands on exactly one row: device buffers on the device
// row, everything else on the host row, which is the only row of a CPU load.
void expectRowsMatchFootprint(const std::string& path) {
  const std::string backend = envOr("QVAC_FOOTPRINT_BACKEND", "CPU");
  const auto footprint = classification_ggml::measureFootprint(
      path, backend, "", fit::DEFAULT_FIT_WIDTH, fit::DEFAULT_FIT_HEIGHT);
  const auto result = fit::assessModelFit(
      path,
      backend,
      "",
      fit::DEFAULT_FIT_WIDTH,
      fit::DEFAULT_FIT_HEIGHT,
      classification_ggml::DEFAULT_THREADS,
      0);
  ASSERT_EQ(result.status, "fits");
  const uint64_t hostBytes =
      footprint.hostWeightBytes + footprint.hostComputeBytes +
      footprint.hostWorkBytes + footprint.hostStagingBytes;
  if (footprint.deviceIsCpu) {
    ASSERT_EQ(result.devices.size(), 1U);
  } else {
    ASSERT_EQ(result.devices.size(), 2U);
    EXPECT_EQ(result.devices[0].name, footprint.deviceName);
    EXPECT_EQ(
        result.devices[0].usedBytes,
        footprint.deviceWeightBytes + footprint.deviceComputeBytes);
  }
  EXPECT_EQ(result.devices.back().name, "CPU");
  EXPECT_EQ(result.devices.back().usedBytes, hostBytes);
}

TEST(AssessModelFit, MegaLocRowsMatchTheFootprint) {
  const std::string path = envOr("QVAC_MEGALOC_F16_MODEL_PATH", "");
  if (path.empty())
    GTEST_SKIP() << "QVAC_MEGALOC_F16_MODEL_PATH not set";
  expectRowsMatchFootprint(path);
}

TEST(AssessModelFit, BridgeDepthRowsMatchTheFootprint) {
  const std::string path = envOr("QVAC_BRIDGEDEPTH_MODEL_PATH", "");
  if (path.empty())
    GTEST_SKIP() << "QVAC_BRIDGEDEPTH_MODEL_PATH not set";
  expectRowsMatchFootprint(path);
}

TEST(AssessModelFit, UnreadableModelThrows) {
  EXPECT_ANY_THROW(
      fit::assessModelFit(
          "/nonexistent/model.gguf",
          "",
          "",
          fit::DEFAULT_FIT_WIDTH,
          fit::DEFAULT_FIT_HEIGHT,
          classification_ggml::DEFAULT_THREADS,
          0));
}

} // namespace
