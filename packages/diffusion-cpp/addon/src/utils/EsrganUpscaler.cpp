#include "EsrganUpscaler.hpp"

#include <algorithm>
#include <cstdlib>
#include <stdexcept>
#include <utility>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

using namespace qvac_errors;

namespace qvac_lib_inference_addon_sd {

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
    threads = 1;
  }
  return threads;
}

upscaler_ctx_t* EsrganUpscaler::ensureContextLocked() {
  if (config_.esrganPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "ESRGAN upscale requested but files.esrgan was not provided");
  }

  if (ctx_) {
    return ctx_.get();
  }

  const int tileSize = std::max(1, config_.upscalerTileSize);
  upscaler_ctx_t* raw = new_upscaler_ctx(
      config_.esrganPath.c_str(),
      config_.upscalerOffloadParamsToCpu,
      config_.upscalerDirect,
      resolveThreads(),
      tileSize);

  if (!raw) {
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
  const uint32_t factor = static_cast<uint32_t>(scale);

  sd_image_t current = inputImage;
  bool currentOwned = false;

  for (int repeat = 0; repeat < repeats; ++repeat) {
    if (shouldCancel && shouldCancel()) {
      if (currentOwned) {
        free(current.data);
      }
      throw std::runtime_error("Job cancelled");
    }

    sd_image_t next = upscale(ctx, current, factor);
    if (!next.data) {
      if (currentOwned) {
        free(current.data);
      }
      throw StatusError(general_error::InternalError, "ESRGAN upscale failed");
    }

    if (currentOwned) {
      free(current.data);
    }
    current = next;
    currentOwned = true;
  }

  return current;
}

} // namespace qvac_lib_inference_addon_sd
