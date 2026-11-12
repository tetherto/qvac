// VlaModel::runtimeStats() over a fake IVlaModel, so the stats JS receives
// with JobEnded are pinned without a GGUF fixture.

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <variant>

#include <gtest/gtest.h>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "addon/AddonCpp.hpp"

using qvac_lib_infer_vla_ggml::IVlaModel;
using qvac_lib_infer_vla_ggml::VlaHparamsGeneric;
using qvac_lib_infer_vla_ggml::VlaModel;
using qvac_lib_infer_vla_ggml::VlaTimingGeneric;
using qvac_lib_inference_addon_cpp::RuntimeStats;
using qvac_lib_inference_addon_cpp::RuntimeStatValue;

namespace {

class FakeVlaModel : public IVlaModel {
public:
  FakeVlaModel(std::string backendName, bool hasGpu)
      : backendName_(std::move(backendName)), hasGpu_(hasGpu) {}

  const VlaHparamsGeneric& hparams() const override { return hparams_; }
  std::string backendName() const override { return backendName_; }
  bool hasGpu() const override { return hasGpu_; }

  bool infer(
      const float** /*images*/, int /*nImages*/, int /*imgWidth*/,
      int /*imgHeight*/, const float* /*state*/, int /*stateDim*/,
      const int32_t* /*langTokens*/, const bool* /*langMask*/, int /*langLen*/,
      const float* /*noise*/, float* /*actionsOut*/, int* /*nActionsOut*/,
      VlaTimingGeneric* /*timingOut*/) override {
    return false;
  }

private:
  VlaHparamsGeneric hparams_{};
  std::string backendName_;
  bool hasGpu_;
};

std::optional<RuntimeStatValue>
findStat(const RuntimeStats& stats, const std::string& key) {
  for (const auto& [name, value] : stats) {
    if (name == key) {
      return value;
    }
  }
  return std::nullopt;
}

RuntimeStats statsFor(const std::string& backendName, bool hasGpu) {
  const VlaModel model(std::make_unique<FakeVlaModel>(backendName, hasGpu));
  return model.runtimeStats();
}

} // namespace

TEST(VlaRuntimeStats, ReportsBackendFamilyAsString) {
  const RuntimeStats stats = statsFor("MTL0", /*hasGpu=*/true);
  const auto backendName = findStat(stats, "backendName");
  ASSERT_TRUE(backendName.has_value());
  ASSERT_TRUE(std::holds_alternative<std::string>(*backendName));
  EXPECT_EQ(std::get<std::string>(*backendName), "metal");

  const auto backendDevice = findStat(stats, "backendDevice");
  ASSERT_TRUE(backendDevice.has_value());
  ASSERT_TRUE(std::holds_alternative<int64_t>(*backendDevice));
  EXPECT_EQ(std::get<int64_t>(*backendDevice), 1);
}

TEST(VlaRuntimeStats, ReportsCpuBackend) {
  const RuntimeStats stats = statsFor("CPU", /*hasGpu=*/false);
  const auto backendName = findStat(stats, "backendName");
  ASSERT_TRUE(backendName.has_value());
  ASSERT_TRUE(std::holds_alternative<std::string>(*backendName));
  EXPECT_EQ(std::get<std::string>(*backendName), "cpu");

  const auto backendDevice = findStat(stats, "backendDevice");
  ASSERT_TRUE(backendDevice.has_value());
  ASSERT_TRUE(std::holds_alternative<int64_t>(*backendDevice));
  EXPECT_EQ(std::get<int64_t>(*backendDevice), 0);
}

TEST(VlaRuntimeStats, OmitsUnknownBackendName) {
  EXPECT_FALSE(
      findStat(statsFor("none", /*hasGpu=*/false), "backendName").has_value());
  EXPECT_FALSE(findStat(statsFor("unknown", /*hasGpu=*/false), "backendName")
                   .has_value());
}

// The string stat does not change the type of the timing stats beside it.
TEST(VlaRuntimeStats, TimingsStayDoubles) {
  const RuntimeStats stats = statsFor("CUDA0", /*hasGpu=*/true);
  for (const char* key :
       {"vision_ms",
        "prefill_compute_ms",
        "prefill_total_ms",
        "smollm2_compute_ms",
        "smollm2_total_ms",
        "ode_ms",
        "total_ms"}) {
    const auto value = findStat(stats, key);
    ASSERT_TRUE(value.has_value()) << key;
    EXPECT_TRUE(std::holds_alternative<double>(*value)) << key;
  }
}
