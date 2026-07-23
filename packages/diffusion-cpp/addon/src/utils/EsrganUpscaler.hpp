#pragma once

#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include <stable-diffusion.h>

#include "handlers/SdCtxHandlers.hpp"

namespace qvac_lib_inference_addon_sd {

inline constexpr int DEFAULT_UPSCALER_TILE_SIZE = 128;

struct EsrganUpscalerConfig {
  std::string esrganPath;
  /** "cpu" or "gpu" — post-init truth is exposed via actualBackendDevice(). */
  std::string device{"gpu"};
  int nThreads{-1};
  int upscalerThreads{-1};
  int upscalerTileSize{DEFAULT_UPSCALER_TILE_SIZE};
  bool upscalerDirect{false};
  bool upscalerOffloadParamsToCpu{false};
};

EsrganUpscalerConfig makeUpscalerConfig(const SdCtxConfig& config);

void sdLogCallback(sd_log_level_t level, const char* text, void* userData);

class EsrganUpscaler {
public:
  explicit EsrganUpscaler(EsrganUpscalerConfig config);

  EsrganUpscaler(const EsrganUpscaler&) = delete;
  EsrganUpscaler& operator=(const EsrganUpscaler&) = delete;
  EsrganUpscaler(EsrganUpscaler&&) = delete;
  EsrganUpscaler& operator=(EsrganUpscaler&&) = delete;

  ~EsrganUpscaler();

  void load();
  [[nodiscard]] bool isLoaded() const noexcept;
  /** 0 = CPU, 1 = GPU, -1 if not loaded. Reflects actual ggml backend after
   * init. */
  [[nodiscard]] int actualBackendDevice() const;
  sd_image_t upscaleImage(
      const sd_image_t& inputImage, int repeats,
      const std::function<bool()>& shouldCancel = {});

private:
  upscaler_ctx_t* ensureContextLocked();
  [[nodiscard]] int resolveThreads() const;

  const EsrganUpscalerConfig config_;
  std::unique_ptr<upscaler_ctx_t, decltype(&free_upscaler_ctx)> ctx_;
  mutable std::mutex mutex_;
};

} // namespace qvac_lib_inference_addon_sd
