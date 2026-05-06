#include "EsrganUpscalerModel.hpp"

#include <chrono>
#include <memory>
#include <stdexcept>
#include <utility>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/Logger.hpp>

#include "utils/BackendLoader.hpp"
#include "utils/ImageCodec.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp;
using namespace qvac_errors;

namespace {

qvac_lib_inference_addon_sd::EsrganUpscalerConfig
makeUpscalerConfig(const qvac_lib_inference_addon_sd::SdCtxConfig& config) {
  return {
      config.esrganPath,
      config.nThreads,
      config.upscalerThreads,
      config.upscalerTileSize,
      config.upscalerDirect,
      config.upscalerOffloadParamsToCpu};
}

void throwIfCancelled(const std::atomic<bool>& cancelRequested) {
  if (cancelRequested.load()) {
    throw std::runtime_error("Job cancelled");
  }
}

} // namespace

EsrganUpscalerModel::EsrganUpscalerModel(
    qvac_lib_inference_addon_sd::SdCtxConfig config)
    : config_(std::move(config)), upscaler_(makeUpscalerConfig(config_)) {
  sd_set_log_callback(EsrganUpscalerModel::sdLogCallback, nullptr);
}

EsrganUpscalerModel::~EsrganUpscalerModel() = default;

bool EsrganUpscalerModel::isLoaded() const noexcept {
  return upscaler_.isLoaded();
}

void EsrganUpscalerModel::load() {
  if (isLoaded()) {
    return;
  }

  const auto tLoadStart = std::chrono::steady_clock::now();

  qvac_lib_inference_addon_sd::loadBackendModulesOnce(config_.backendsDir);
  upscaler_.load();

  stats_.modelLoadMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::steady_clock::now() - tLoadStart)
                           .count();
}

std::any EsrganUpscalerModel::process(const std::any& input) {
  if (!isLoaded()) {
    throw StatusError(
        general_error::InternalError,
        "EsrganUpscalerModel::process() called before load()");
  }

  const auto& job = std::any_cast<const UpscaleJob&>(input);
  cancelRequested_.store(false);

  const auto t0 = std::chrono::steady_clock::now();

  sd_image_t decoded = image_codec::decodeImage(job.imageBytes);
  std::unique_ptr<uint8_t, image_codec::FreeDeleter> decodedData(decoded.data);
  if (!decoded.data) {
    throw StatusError(
        general_error::InvalidArgument,
        "Failed to decode input image; expected PNG or JPEG bytes");
  }

  throwIfCancelled(cancelRequested_);

  sd_image_t upscaled = upscaler_.upscaleImage(
      decoded, job.repeats, [this]() { return cancelRequested_.load(); });
  std::unique_ptr<uint8_t, image_codec::FreeDeleter> upscaledData(
      upscaled.data);

  throwIfCancelled(cancelRequested_);

  auto png = image_codec::encodeToPng(upscaled);
  if (png.empty()) {
    throw StatusError(
        general_error::InternalError, "Failed to encode ESRGAN output as PNG");
  }

  throwIfCancelled(cancelRequested_);

  int outputCount = 0;
  int64_t outputPixels = 0;
  int64_t statsWidth = 0;
  int64_t statsHeight = 0;
  if (job.outputCallback) {
    const int64_t outputWidth = static_cast<int64_t>(upscaled.width);
    const int64_t outputHeight = static_cast<int64_t>(upscaled.height);
    job.outputCallback(png);
    outputCount = 1;
    outputPixels = outputWidth * outputHeight;
    statsWidth = outputWidth;
    statsHeight = outputHeight;
  }

  const auto t1 = std::chrono::steady_clock::now();
  const int64_t upscaleMs = static_cast<int64_t>(
      std::chrono::duration<double, std::milli>(t1 - t0).count());

  stats_.totalUpscaleMs += upscaleMs;
  stats_.totalWallMs += upscaleMs;
  stats_.totalUpscales++;
  stats_.totalImages += outputCount;
  stats_.totalPixels += outputPixels;

  lastStats_.clear();
  lastStats_.emplace_back("modelLoadMs", stats_.modelLoadMs);
  lastStats_.emplace_back("upscaleMs", upscaleMs);
  lastStats_.emplace_back("totalUpscaleMs", stats_.totalUpscaleMs);
  lastStats_.emplace_back("totalWallMs", stats_.totalWallMs);
  lastStats_.emplace_back("totalUpscales", stats_.totalUpscales);
  lastStats_.emplace_back("totalImages", stats_.totalImages);
  lastStats_.emplace_back("totalPixels", stats_.totalPixels);
  lastStats_.emplace_back("width", statsWidth);
  lastStats_.emplace_back("height", statsHeight);
  lastStats_.emplace_back("repeats", static_cast<int64_t>(job.repeats));

  return std::any{};
}

void EsrganUpscalerModel::cancel() const { cancelRequested_.store(true); }

qvac_lib_inference_addon_cpp::RuntimeStats
EsrganUpscalerModel::runtimeStats() const {
  return lastStats_;
}

void EsrganUpscalerModel::sdLogCallback(
    sd_log_level_t level, const char* text, void* /*userData*/) {
  namespace lg = qvac_lib_inference_addon_cpp::logger;
  lg::Priority priority;
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
  case SD_LOG_ERROR:
    priority = lg::Priority::ERROR;
    break;
  default:
    priority = lg::Priority::ERROR;
    break;
  }
  QLOG_IF(priority, std::string(text ? text : ""));
}
