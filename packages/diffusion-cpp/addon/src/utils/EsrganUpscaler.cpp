#include "EsrganUpscaler.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/Logger.hpp>

#include "BackendSelection.hpp"
#include "LoggingMacros.hpp"
#include "SdErrors.hpp"

using namespace qvac_errors;

namespace qvac_lib_inference_addon_sd {

namespace {

sd_upscaler_device_t deviceStringToSd(const std::string& deviceStr) {
  using sd_backend_selection::ConfigDevice;
  using sd_backend_selection::parseConfigDeviceString;
  switch (parseConfigDeviceString(deviceStr)) {
  case ConfigDevice::Cpu:
    return SD_UPSCALER_DEVICE_CPU;
  case ConfigDevice::Gpu:
    return SD_UPSCALER_DEVICE_GPU;
  }
}

void freeSdImageData(sd_image_t& image) noexcept {
  if (image.data == nullptr) {
    return;
  }

  // Frees ADDON-owned pixel copies only (see upscaleImage: engine output is
  // deep-copied and released with free_sd_images; the input image belongs to
  // the caller and is never freed here).
  // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory)
  free(image.data);
  image.data = nullptr;
}

void freeSdImageBatch(sd_image_t* images, int count) noexcept {
  if (images == nullptr) {
    return;
  }

  // The engine owns the count on successful output. A negative count is
  // invalid, so only release the outer allocation in that malformed case.
  for (int i = 0; i < count; ++i) {
    freeSdImageData(images[i]);
  }
  free(images);
}

} // namespace

EsrganUpscalerConfig makeUpscalerConfig(const SdCtxConfig& config) {
  return EsrganUpscalerConfig{
      .esrganPath = config.esrganPath,
      .device = config.device,
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

int EsrganUpscaler::actualBackendDevice() const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (ctx_ == nullptr) {
    return -1;
  }
  return get_upscaler_backend_device(ctx_.get());
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
  const sd_upscaler_device_t sdDev = deviceStringToSd(config_.device);
  const sd_backend_preference_t backendPref =
      sd_backend_selection::preferredEsrganBackendForConfigDevice(
          config_.device);
  upscaler_ctx_t* raw = new_upscaler_ctx_with_device(
      config_.esrganPath.c_str(),
      config_.upscalerOffloadParamsToCpu,
      config_.upscalerDirect,
      resolveThreads(),
      tileSize,
      sdDev,
      backendPref);

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
      throw errors::makeCancelledError();
    }

    sd_image_t* outImages = nullptr;
    int outCount = 0;
    const bool ok = upscale(ctx, current, factor, &outImages, &outCount);
    if (!ok || outCount < 1 || outImages == nullptr ||
        outImages[0].data == nullptr) {
      if (outImages != nullptr) {
        free_sd_images(outImages, outCount);
      }
      if (currentOwned) {
        freeSdImageData(current);
      }
      throw StatusError(general_error::InternalError, "ESRGAN upscale failed");
    }
    // The engine owns the returned array and every pixel buffer in it; the
    // matching deallocator is free_sd_images(). Deep-copy the first image
    // into addon-owned memory before releasing the whole batch, so no
    // engine allocation is ever passed to the addon's free() (allocator/CRT
    // boundaries differ on Windows prebuilds and mixing them corrupts the
    // heap).
    sd_image_t next = outImages[0];
    const size_t nextBytes = static_cast<size_t>(next.width) *
                             static_cast<size_t>(next.height) *
                             static_cast<size_t>(next.channel);
    // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory)
    auto* copied = static_cast<uint8_t*>(malloc(nextBytes));
    if (copied == nullptr) {
      free_sd_images(outImages, outCount);
      if (currentOwned) {
        freeSdImageData(current);
      }
      throw StatusError(
          general_error::InternalError,
          "ESRGAN upscale: failed to allocate the result copy");
    }
    memcpy(copied, next.data, nextBytes);
    next.data = copied;
    free_sd_images(outImages, outCount);

    if (currentOwned) {
      freeSdImageData(current);
    }
    current = next;
    currentOwned = true;
  }

  return current;
}

} // namespace qvac_lib_inference_addon_sd
