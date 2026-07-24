#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "utils/LamAudio2Expression.hpp"

class LamAudio2ExpressionModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  explicit LamAudio2ExpressionModel(
      qvac_lib_inference_addon_sd::LamAudio2ExpressionConfig config);
  ~LamAudio2ExpressionModel() override;

  LamAudio2ExpressionModel(const LamAudio2ExpressionModel&) = delete;
  LamAudio2ExpressionModel& operator=(const LamAudio2ExpressionModel&) =
      delete;
  LamAudio2ExpressionModel(LamAudio2ExpressionModel&&) = delete;
  LamAudio2ExpressionModel& operator=(LamAudio2ExpressionModel&&) = delete;

  [[nodiscard]] std::string getName() const final {
    return "LamAudio2ExpressionModel";
  }

  void load();
  [[nodiscard]] bool isLoaded() const noexcept;

  std::any process(const std::any& input) final;
  void cancel() const final;

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

  struct ProcessJob {
    std::vector<float> pcm;
    int32_t sampleRate{16000};
    std::optional<int32_t> identityIndex;
    std::function<void(const std::string&)> outputCallback;
  };

private:
  qvac_lib_inference_addon_sd::LamAudio2ExpressionConfig config_;
  qvac_lib_inference_addon_sd::LamAudio2Expression a2e_;
  mutable std::atomic<bool> cancelRequested_{false};
  mutable qvac_lib_inference_addon_cpp::RuntimeStats lastStats_;

  struct CumulativeStats {
    int64_t modelLoadMs{0};
    int64_t totalInferenceMs{0};
    int64_t totalWallMs{0};
    int64_t totalRuns{0};
    int64_t totalFrames{0};
  };
  CumulativeStats stats_{};
};
