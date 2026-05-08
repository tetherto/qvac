#include "EsrganUpscaler.hpp"

#include <algorithm>
#include <cstdlib>
#include <stdexcept>
#include <utility>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/Logger.hpp>

#include "LoggingMacros.hpp"

using namespace qvac_errors;

namespace qvac_lib_inference_addon_sd {

namespace {

void freeSdImageData(sd_image_t& image) noexcept {
  if (image.data == nullptr) {
    return;
  }

  // stable-diffusion.cpp returns malloc-owned sd_image_t::data from upscale().
  // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory)
  free(image.data);
  image.data = nullptr;
}

} // namespace

EsrganUpscalerConfig makeUpscalerConfig(const SdCtxConfig& config) {
  return EsrganUpscalerConfig{
      .esrganPath = config.esrganPath,
      .nThreads = config.nThreads,
      .upscalerThreads = config.upscalerThreads,
      .upscalerTileSize = config.upscalerTileSize,
      .upscalerDirect = config.upscalerDirect,
      .upscalerOffloadParamsToCpu = config.upscalerOffloadParamsToCpu};
}

void sdLogCallback(sd_log_level_t level, const char* text, void* /*userData*/) {
  namespace lg = qvac_lib_inference_addon_cpp::logger;
  auto priority = lg::Priority::ERROR;
  switch (level) {
  case SD_LOG_DEBUG:
    priority = lg::Priority::DEBUG;
    break;
  case SD_LOG_INFO:
    priority = lg::Priority::INFO;
    break;
  case SD_LOG_WARN:
    priority = lg::Priority::WARNING;
    break;
  default:
    break;
  }
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
  QLOG_IF(priority, std::string(text != nullptr ? text : ""));
}

EsrganUpscaler::EsrganUpscaler(EsrganUpscalerConfig config)
    : config_(std::move(config)), ctx_(nullptr, &free_upscaler_ctx) {}

EsrganUpscaler::~EsrganUpscaler() = default;

bool EsrganUpscaler::isLoaded() const noexcept { return ctx_ != nullptr; }

void EsrganUpscaler::load() {
  std::lock_guard<std::mutex> lock(mutex_);
  ensureContextLocked();
}

int EsrganUpscaler::resolveThreads() const {
  if (config_.upscalerThreads == 0 || config_.upscalerThreads < -1) {
    throw StatusError(
        general_error::InvalidArgument,
        "upscaler_threads must be -1 (auto) or a positive integer");
  }

  int threads =
      config_.upscalerThreads > 0 ? config_.upscalerThreads : config_.nThreads;
  if (threads <= 0) {
    threads = sd_get_num_physical_cores();
  }
  if (threads <= 0) {
    throw StatusError(
        general_error::InternalError,
        "Failed to auto-detect upscaler thread count; set upscaler_threads to "
        "a positive integer");
  }
  return threads;
}

upscaler_ctx_t* EsrganUpscaler::ensureContextLocked() {
  if (config_.esrganPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "ESRGAN upscale requested but files.esrgan was not provided");
  }

  if (ctx_ != nullptr) {
    return ctx_.get();
  }

  const int tileSize = std::max(1, config_.upscalerTileSize);
  upscaler_ctx_t* raw = new_upscaler_ctx(
      config_.esrganPath.c_str(),
      config_.upscalerOffloadParamsToCpu,
      config_.upscalerDirect,
      resolveThreads(),
      tileSize);

  if (raw == nullptr) {
    throw StatusError(
        general_error::InternalError,
        "Failed to create ESRGAN upscaler context from files.esrgan: " +
            config_.esrganPath);
  }

  ctx_.reset(raw);
  return ctx_.get();
}

sd_image_t EsrganUpscaler::upscaleImage(
    const sd_image_t& inputImage, int repeats,
    const std::function<bool()>& shouldCancel) {
  if (repeats <= 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "upscale.repeats must be a positive integer");
  }

  std::lock_guard<std::mutex> lock(mutex_);

  upscaler_ctx_t* ctx = ensureContextLocked();
  const int scale = get_upscale_factor(ctx);
  if (scale <= 0) {
    throw StatusError(
        general_error::InternalError,
        "ESRGAN upscaler reported an invalid scale factor");
  }
  const auto factor = static_cast<uint32_t>(scale);

  sd_image_t current = inputImage;
  bool currentOwned = false;

  // NOTE: cancellation is checked between ESRGAN repeat passes. A single
  // stable-diffusion.cpp upscale() pass cannot be interrupted mid-pass/tile
  // without upstream support.
  for (int repeat = 0; repeat < repeats; ++repeat) {
    if (static_cast<bool>(shouldCancel) && shouldCancel()) {
      if (currentOwned) {
        freeSdImageData(current);
      }
      throw std::runtime_error("Job cancelled");
    }

    sd_image_t next = upscale(ctx, current, factor);
    if (next.data == nullptr) {
      if (currentOwned) {
        freeSdImageData(current);
      }
      throw StatusError(general_error::InternalError, "ESRGAN upscale failed");
    }

    if (currentOwned) {
      freeSdImageData(current);
    }
    current = next;
    currentOwned = true;
  }

  return current;
}

} // namespace qvac_lib_inference_addon_sd
