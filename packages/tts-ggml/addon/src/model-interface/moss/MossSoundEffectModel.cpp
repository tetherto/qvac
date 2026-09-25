#include "model-interface/moss/MossSoundEffectModel.hpp"

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <utility>

#include <tts-cpp/moss/sound_effect.h>

#include "addon/TTSErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/BackendUtils.hpp"
#include "model-interface/PcmConversion.hpp"

namespace qvac::ttsggml::moss {

namespace {

using qvac_errors::createTTSError;
using qvac_errors::StatusError;
using qvac_errors::tts_error::TTSErrorCode;
namespace general_error = qvac_errors::general_error;

constexpr int CPU_BACKEND_ID = 0;
constexpr double MS_PER_SECOND = 1000.0;

void requireModelFile(const std::string& path) {
  if (path.empty()) {
    throw StatusError(
        general_error::InvalidArgument, "mossSoundEffectPath is required");
  }
  if (!std::filesystem::exists(path)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "moss sound-effect model not found: " + path);
  }
}

void validateThreads(const MossSoundEffectConfig& cfg) {
  if (cfg.threads.has_value() && *cfg.threads < 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "threads must be >= 0 (0 = engine default)");
  }
}

void validateGpuIntent(const MossSoundEffectConfig& cfg) {
  if (!cfg.useGpu.has_value() || !cfg.nGpuLayers.has_value())
    return;
  const bool wantsGpuFlag = *cfg.useGpu;
  const int layers = *cfg.nGpuLayers;
  if (wantsGpuFlag == (layers != 0))
    return;
  throw StatusError(
      general_error::InvalidArgument,
      std::string("MossSoundEffectModel: useGPU=") +
          (wantsGpuFlag ? "true" : "false") +
          " conflicts with nGpuLayers=" + std::to_string(layers) +
          ". Either drop one of the two, or make them agree "
          "(useGPU:true + nGpuLayers!=0, or useGPU:false + nGpuLayers=0).");
}

bool wantsGpu(const MossSoundEffectConfig& cfg) {
  return cfg.nGpuLayers.has_value() ? *cfg.nGpuLayers != 0
                                    : cfg.useGpu.value_or(false);
}

} // namespace

MossSoundEffectModel::MossSoundEffectModel(MossSoundEffectConfig config)
    : cfg_(std::move(config)) {
  validateConfig(cfg_);
}

MossSoundEffectModel::~MossSoundEffectModel() noexcept = default;

void MossSoundEffectModel::validateConfig(const MossSoundEffectConfig& cfg) {
  requireModelFile(cfg.modelPath);
  validateThreads(cfg);
  validateGpuIntent(cfg);
}

tts_cpp::moss::SoundEffectOptions
MossSoundEffectModel::toEngineOptions(const MossSoundEffectConfig& cfg) {
  tts_cpp::moss::SoundEffectOptions opts;
  opts.model_path = cfg.modelPath;
  if (cfg.threads.value_or(0) > 0)
    opts.n_threads = *cfg.threads;
  if (!cfg.backendsDir.empty())
    opts.backends_dir = resolveBackendsDir(cfg.backendsDir).string();
  opts.use_gpu = wantsGpu(cfg);
  return opts;
}

tts_cpp::moss::SoundEffectRequest MossSoundEffectModel::toRequest(
    const MossSoundEffectConfig& cfg, const AnyInput& input) {
  tts_cpp::moss::SoundEffectRequest request;
  request.prompt = input.text;
  request.negative_prompt = input.call.negativePrompt;
  if (input.call.seconds.has_value())
    request.seconds = *input.call.seconds;
  request.steps = input.call.steps.value_or(0);
  request.guidance = input.call.guidance.value_or(0.0f);
  request.shift = input.call.shift.value_or(0.0f);
  if (cfg.seed.has_value())
    request.seed = static_cast<uint32_t>(*cfg.seed);
  return request;
}

void MossSoundEffectModel::reloadWith(MossSoundEffectConfig config) {
  validateConfig(config);
  std::lock_guard lk(engineMu_);
  cfg_ = std::move(config);
  unloadLocked();
  loadLocked();
}

void MossSoundEffectModel::load() {
  std::lock_guard lk(engineMu_);
  loadLocked();
}

void MossSoundEffectModel::unload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
}

void MossSoundEffectModel::loadLocked() {
  if (engine_)
    return;
  try {
    engine_ = std::make_shared<tts_cpp::moss::SoundEffectEngine>(
        toEngineOptions(cfg_));
  } catch (const std::exception& e) {
    engine_.reset();
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        std::string("MossSoundEffectModel::load: ") + e.what());
  }
  backendName_ = engine_->backend_name();
  backendId_ = backendIdFromName(backendName_);
  backendDevice_ =
      backendId_ == CPU_BACKEND_ID ? kBackendDeviceCpu : kBackendDeviceGpu;
  gpuUnsupported_ = wantsGpu(cfg_) && backendDevice_ == kBackendDeviceCpu;
}

void MossSoundEffectModel::unloadLocked() { engine_.reset(); }

void MossSoundEffectModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
  std::shared_ptr<tts_cpp::moss::SoundEffectEngine> e;
  {
    std::lock_guard lk(engineMu_);
    e = engine_;
  }
  if (e)
    e->cancel();
}

void MossSoundEffectModel::recordStats(double seconds, int64_t samples) {
  totalTime_ = seconds;
  totalSamples_ = samples;
  audioDurationMs_ = static_cast<double>(samples) * MS_PER_SECOND /
                     MOSS_SFX_NATIVE_SAMPLE_RATE;
  realTimeFactor_ = audioDurationMs_ > 0.0
                        ? (totalTime_ * MS_PER_SECOND) / audioDurationMs_
                        : 0.0;
}

std::shared_ptr<tts_cpp::moss::SoundEffectEngine>
MossSoundEffectModel::snapshot() const {
  std::lock_guard lk(engineMu_);
  if (!engine_) {
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        "MossSoundEffectModel::generate: engine not loaded");
  }
  return engine_;
}

void MossSoundEffectModel::requireNotCancelled() const {
  if (!cancelRequested_.load(std::memory_order_relaxed))
    return;
  throw createTTSError(
      TTSErrorCode::SynthesisFailed, "generation cancelled before it started");
}

void MossSoundEffectModel::requireCompleted(
    const tts_cpp::moss::SoundEffectResult& result) const {
  if (!result.cancelled && !cancelRequested_.load(std::memory_order_relaxed))
    return;
  throw createTTSError(TTSErrorCode::SynthesisFailed, "generation cancelled");
}

tts_cpp::moss::SoundEffectResult MossSoundEffectModel::runEngine(
    tts_cpp::moss::SoundEffectEngine& engine, const AnyInput& input) const {
  try {
    return engine.generate(toRequest(config(), input), [this](int, int) {
      return !cancelRequested_.load(std::memory_order_relaxed);
    });
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("moss.soundEffect: ") + e.what());
  }
}

MossSoundEffectModel::Output
MossSoundEffectModel::generate(const AnyInput& input) {
  const auto engine = snapshot();
  requireNotCancelled();
  const auto t0 = std::chrono::steady_clock::now();
  auto result = runEngine(*engine, input);
  const auto t1 = std::chrono::steady_clock::now();
  requireCompleted(result);
  recordStats(
      std::chrono::duration<double>(t1 - t0).count(),
      static_cast<int64_t>(result.pcm.size()));
  return pcmFloatToInt16(result.pcm);
}

const MossSoundEffectModel::AnyInput&
MossSoundEffectModel::requireAnyInput(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (!anyInput) {
    throw StatusError(
        general_error::InvalidArgument,
        "MossSoundEffectModel::process: input must be AnyInput");
  }
  return *anyInput;
}

void MossSoundEffectModel::claimJob() {
  bool expected = false;
  if (jobInProgress_.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel))
    return;
  throw StatusError(
      general_error::InternalError,
      "MossSoundEffectModel::process: job already in progress");
}

std::any MossSoundEffectModel::process(const std::any& input) {
  const AnyInput& anyInput = requireAnyInput(input);
  claimJob();
  struct InProgressGuard {
    std::atomic_bool& flag;
    ~InProgressGuard() { flag.store(false, std::memory_order_release); }
  } guard{jobInProgress_};

  cancelRequested_.store(false, std::memory_order_relaxed);
  return std::any(generate(anyInput));
}

qvac_lib_inference_addon_cpp::RuntimeStats
MossSoundEffectModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("totalSamples", totalSamples_);
  stats.emplace_back("backendDevice", static_cast<int64_t>(backendDevice_));
  stats.emplace_back("backendId", static_cast<int64_t>(backendId_));
  stats.emplace_back("gpuUnsupported", static_cast<int64_t>(gpuUnsupported_));
  return stats;
}

} // namespace qvac::ttsggml::moss
