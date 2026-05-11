#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>
#include <stable-diffusion.h>

#include "handlers/SdCtxHandlers.hpp"
#include "utils/EsrganUpscaler.hpp"

class EsrganUpscalerModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  explicit EsrganUpscalerModel(qvac_lib_inference_addon_sd::SdCtxConfig config);
  ~EsrganUpscalerModel() override;

  EsrganUpscalerModel(const EsrganUpscalerModel&) = delete;
  EsrganUpscalerModel& operator=(const EsrganUpscalerModel&) = delete;
  EsrganUpscalerModel(EsrganUpscalerModel&&) = delete;
  EsrganUpscalerModel& operator=(EsrganUpscalerModel&&) = delete;

  [[nodiscard]] std::string getName() const final {
    return "EsrganUpscalerModel";
  }

  void load();
  [[nodiscard]] bool isLoaded() const noexcept;

  std::any process(const std::any& input) final;
  void cancel() const final;

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

  struct UpscaleJob {
    std::vector<uint8_t> imageBytes;
    int repeats{1};
    std::function<void(const std::vector<uint8_t>&)> outputCallback;
  };

private:
  qvac_lib_inference_addon_sd::SdCtxConfig config_;
  qvac_lib_inference_addon_sd::EsrganUpscaler upscaler_;
  mutable std::atomic<bool> cancelRequested_{false};
  mutable qvac_lib_inference_addon_cpp::RuntimeStats lastStats_{};

  struct CumulativeStats {
    int64_t modelLoadMs{0};
    int64_t totalUpscaleMs{0};
    int64_t totalWallMs{0};
    int64_t totalUpscales{0};
    int64_t totalImages{0};
    int64_t totalPixels{0};
  };
  CumulativeStats stats_{};
};
