#include "LamAudio2ExpressionModel.hpp"

#include <chrono>
#include <memory>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>
#include <picojson/picojson.h>

#include "utils/BackendLoader.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/SdErrors.hpp"

using namespace qvac_lib_inference_addon_cpp;
using namespace qvac_errors;

namespace {

void throwIfCancelled(const std::atomic<bool>& cancelRequested) {
  if (cancelRequested.load()) {
    throw qvac_lib_inference_addon_sd::errors::makeCancelledError();
  }
}

std::string framesToJson(
    const std::vector<qvac_lib_inference_addon_sd::LamA2eFrame>& frames) {
  picojson::array frameArray;
  frameArray.reserve(frames.size());
  for (const auto& frame : frames) {
    picojson::array arkit;
    arkit.reserve(frame.arkit52.size());
    for (float value : frame.arkit52) {
      arkit.emplace_back(static_cast<double>(value));
    }
    picojson::object frameObj;
    frameObj["timestampUs"] =
        picojson::value(static_cast<double>(frame.timestampUs));
    frameObj["arkit52"] = picojson::value(arkit);
    frameArray.emplace_back(frameObj);
  }
  picojson::object root;
  root["frames"] = picojson::value(frameArray);
  return picojson::value(root).serialize();
}

} // namespace

LamAudio2ExpressionModel::LamAudio2ExpressionModel(
    qvac_lib_inference_addon_sd::LamAudio2ExpressionConfig config)
    : config_(std::move(config)), a2e_(config_) {}

LamAudio2ExpressionModel::~LamAudio2ExpressionModel() = default;

bool LamAudio2ExpressionModel::isLoaded() const noexcept {
  return a2e_.isLoaded();
}

void LamAudio2ExpressionModel::load() {
  if (isLoaded()) {
    return;
  }

  const auto tLoadStart = std::chrono::steady_clock::now();

  qvac_lib_inference_addon_sd::loadBackendModulesOnce(config_.backendsDir);
  a2e_.load();

  stats_.modelLoadMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::steady_clock::now() - tLoadStart)
                           .count();
}

std::any LamAudio2ExpressionModel::process(const std::any& input) {
  if (!isLoaded()) {
    throw StatusError(
        general_error::InternalError,
        "LamAudio2ExpressionModel::process() called before load()");
  }

  const auto& job = std::any_cast<const ProcessJob&>(input);
  cancelRequested_.store(false);

  // NOTE: cancellation is only observed before the blocking native call
  // starts. lam_a2e_process_pcm_f32() is a single synchronous call with no
  // cancellation hook, so a cancel requested mid-inference has no effect
  // until the call returns (mirrors the ESRGAN single-pass limitation).
  throwIfCancelled(cancelRequested_);

  const auto inferStart = std::chrono::steady_clock::now();
  std::vector<qvac_lib_inference_addon_sd::LamA2eFrame> frames =
      a2e_.processPcmF32(job.pcm, job.sampleRate, job.identityIndex);
  const auto inferEnd = std::chrono::steady_clock::now();
  const int64_t inferenceMs = static_cast<int64_t>(
      std::chrono::duration<double, std::milli>(inferEnd - inferStart)
          .count());

  throwIfCancelled(cancelRequested_);

  if (job.outputCallback) {
    job.outputCallback(framesToJson(frames));
  } else {
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
    QLOG_IF(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "LAM audio2expression produced frames but no callback was "
        "registered; result discarded.");
  }

  stats_.totalInferenceMs += inferenceMs;
  stats_.totalWallMs += inferenceMs;
  stats_.totalRuns++;
  stats_.totalFrames += static_cast<int64_t>(frames.size());

  lastStats_.clear();
  lastStats_.emplace_back("modelLoadMs", stats_.modelLoadMs);
  lastStats_.emplace_back("inferenceMs", inferenceMs);
  lastStats_.emplace_back("totalInferenceMs", stats_.totalInferenceMs);
  lastStats_.emplace_back("totalWallMs", stats_.totalWallMs);
  lastStats_.emplace_back("totalRuns", stats_.totalRuns);
  lastStats_.emplace_back("frameCount", static_cast<int64_t>(frames.size()));
  lastStats_.emplace_back("totalFrames", stats_.totalFrames);
  lastStats_.emplace_back("sampleRate", static_cast<int64_t>(job.sampleRate));
  const int backendDevice = a2e_.actualBackendDevice();
  if (backendDevice >= 0) {
    lastStats_.emplace_back(
        "backendDevice", static_cast<int64_t>(backendDevice));
  }

  return std::any{};
}

void LamAudio2ExpressionModel::cancel() const { cancelRequested_.store(true); }

qvac_lib_inference_addon_cpp::RuntimeStats
LamAudio2ExpressionModel::runtimeStats() const {
  return lastStats_;
}
