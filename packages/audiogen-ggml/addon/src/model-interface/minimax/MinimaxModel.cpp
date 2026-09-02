#include "model-interface/minimax/MinimaxModel.hpp"

#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <utility>

#include "audiogen-cpp/minimax/engine.h"

namespace qvac::audiogenggml::minimax {

namespace {

constexpr float K_INT16_SCALE = 32767.0F;
constexpr float K_INT16_MINIMUM = -32768.0F;
constexpr float K_TARGET_PEAK = 0.9F;
constexpr float K_MINIMUM_NORMALIZATION_PEAK = 1e-3F;
constexpr int64_t K_BACKEND_DEVICE_CPU = 0;
constexpr int64_t K_BACKEND_DEVICE_GPU = 1;
constexpr int K_STEREO_CHANNELS = 2;
constexpr double K_MILLISECONDS_PER_SECOND = 1000.0;

// Mirrors tts-ggml's BackendUtils.hpp mapping (and AcestepModel.cpp) so the
// codes the engines report cannot drift apart. Metal registers as "MTL" on
// newer ggml.
int64_t backendIdFromName(const std::string& name) {
  if (name == "CPU")
    return 0;
  if (name.rfind("Metal", 0) == 0 || name.rfind("MTL", 0) == 0)
    return 1;
  if (name.rfind("CUDA", 0) == 0)
    return 2;
  if (name.rfind("Vulkan", 0) == 0)
    return 3;
  if (name.rfind("OpenCL", 0) == 0)
    return 4;
  return 99;
}

int64_t backendDeviceFromName(const std::string& name) {
  return name == "CPU" ? K_BACKEND_DEVICE_CPU : K_BACKEND_DEVICE_GPU;
}

// Wire codes for AudiogenStats.gpuFallbackReason. Mapped explicitly rather than
// cast from the enum so reordering it upstream cannot silently remap them.
int64_t gpuFallbackReasonCode(tts_cpp::GpuFallbackReason reason) {
  switch (reason) {
  case tts_cpp::GpuFallbackReason::none:
    return 0;
  case tts_cpp::GpuFallbackReason::not_requested:
    return 1;
  case tts_cpp::GpuFallbackReason::no_devices:
    return 2;
  case tts_cpp::GpuFallbackReason::init_failed:
    return 3;
  }
  return 99;
}

class CancellationReset {
public:
  explicit CancellationReset(std::atomic_bool& requested)
      : requested_(requested) {}

  ~CancellationReset() { requested_.store(false); }

private:
  std::atomic_bool& requested_;
};

int16_t f32ToI16(float sample) {
  float value = sample * K_INT16_SCALE;
  value = std::fmin(value, K_INT16_SCALE);
  value = std::fmax(value, K_INT16_MINIMUM);
  return static_cast<int16_t>(std::lrint(value));
}

float peakAmplitude(const std::vector<float>& pcm) {
  float peak = 0.0F;
  for (const float sample : pcm) {
    if (!std::isfinite(sample)) {
      throw std::runtime_error("MinimaxModel: engine returned non-finite PCM");
    }
    peak = std::fmax(peak, std::fabs(sample));
  }
  return peak;
}

float normalizationGain(const std::vector<float>& pcm) {
  const float peak = peakAmplitude(pcm);
  return peak > K_MINIMUM_NORMALIZATION_PEAK ? K_TARGET_PEAK / peak : 1.0F;
}

MinimaxModel::Output convertPcm(const std::vector<float>& pcm) {
  const float gain = normalizationGain(pcm);
  MinimaxModel::Output output;
  output.reserve(pcm.size());
  for (const float sample : pcm) {
    output.push_back(f32ToI16(sample * gain));
  }
  return output;
}

std::string resolveBackendsDir(const std::string& root) {
  if (root.empty())
    return {};
  std::filesystem::path path(root);
#ifdef BACKENDS_SUBDIR
  path = (path / std::filesystem::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
  return path.string();
}

} // namespace

MinimaxModel::MinimaxModel(MinimaxConfig config) : config_(std::move(config)) {
  validateConfig(config_);
}

MinimaxModel::~MinimaxModel() noexcept {
  try {
    std::lock_guard operationLock(operationMutex_);
    std::lock_guard lock(engineMutex_);
    unloadLocked();
  } catch (...) {
  }
}

void MinimaxModel::validateConfig(const MinimaxConfig& config) {
  const bool hasDirectory = !config.modelDir.empty();
  const bool hasPair =
      !config.lmModelPath.empty() && !config.synthModelPath.empty();
  if (!hasDirectory && !hasPair) {
    throw std::invalid_argument(
        "MinimaxModel: set `modelDir` or both MiniMax GGUF paths (lm/synth)");
  }
}

void MinimaxModel::load() {
  std::lock_guard operationLock(operationMutex_);
  std::lock_guard lock(engineMutex_);
  loadLocked();
}

void MinimaxModel::loadLocked() {
  if (engine_)
    return;
  tts_cpp::minimax::EngineOptions options;
  options.model_dir = config_.modelDir;
  options.lm_model_path = config_.lmModelPath;
  options.synth_model_path = config_.synthModelPath;
  options.n_threads = config_.threads;
  // "auto" keeps the addon's useGPU contract: take a GPU when one is usable,
  // otherwise fall back to CPU (the engine's "gpu" would fail creation
  // instead). runtimeStats reports the backend actually in use.
  options.device = config_.useGpu ? "auto" : "cpu";
  options.backends_dir = resolveBackendsDir(config_.backendsDir);
  engine_ = tts_cpp::minimax::Engine::create(options);
  if (!engine_) {
    throw std::runtime_error("MinimaxModel: failed to create MiniMax engine");
  }
  backendName_ = engine_->backend_name();
  gpuFallbackReason_ = engine_->gpu_fallback_reason();
  sampleRate_ = engine_->sample_rate();
  channels_ = K_STEREO_CHANNELS;
}

void MinimaxModel::unload() {
  std::lock_guard operationLock(operationMutex_);
  std::lock_guard lock(engineMutex_);
  unloadLocked();
}

void MinimaxModel::unloadLocked() { engine_.reset(); }

void MinimaxModel::reload(MinimaxConfig config) {
  validateConfig(config);
  std::lock_guard operationLock(operationMutex_);
  std::lock_guard lock(engineMutex_);
  unloadLocked();
  config_ = std::move(config);
  loadLocked();
}

void MinimaxModel::cancel() const {
  cancelRequested_.store(true);
  std::lock_guard lock(engineMutex_);
  if (engine_)
    engine_->cancel();
}

std::any MinimaxModel::process(const std::any& input) {
  return std::any(generate(std::any_cast<const AnyInput&>(input)));
}

MinimaxModel::Output MinimaxModel::generate(const AnyInput& input) {
  std::lock_guard operationLock(operationMutex_);
  CancellationReset cancellationReset(cancelRequested_);
  if (cancelRequested_.load()) {
    throw std::runtime_error("MiniMax generation cancelled");
  }
  const auto start = std::chrono::steady_clock::now();
  std::shared_ptr<tts_cpp::minimax::Engine> engine;
  {
    std::lock_guard lock(engineMutex_);
    if (!engine_)
      loadLocked();
    engine = engine_;
  }

  tts_cpp::minimax::GenerateParams params;
  params.caption = input.caption;
  params.lyrics = input.lyrics;
  params.max_frames = input.maxFrames;
  params.seed = input.seed;
  params.inference_steps = input.inferenceSteps;
  params.cfg_scale = input.cfgScale;

  auto progress =
      [this](const std::string& stage, int64_t step, int64_t total) -> bool {
    if (progressSink_)
      progressSink_(AudioGenProgress{stage, step, total});
    return !cancelRequested_.load();
  };
  const auto result = engine->generate(params, progress);
  if (cancelRequested_.load()) {
    throw std::runtime_error("MiniMax generation cancelled");
  }
  Output pcm = convertPcm(result.pcm);
  const auto finish = std::chrono::steady_clock::now();

  totalTimeMs_ =
      std::chrono::duration<double, std::milli>(finish - start).count();
  totalSamples_ = static_cast<int64_t>(pcm.size());
  sampleRate_ = result.sample_rate;
  channels_ = result.channels;
  audioDurationMs_ = sampleRate_ > 0 && channels_ > 0
                         ? static_cast<double>(totalSamples_) / channels_ /
                               sampleRate_ * K_MILLISECONDS_PER_SECOND
                         : 0.0;
  realTimeFactor_ =
      audioDurationMs_ > 0.0 ? totalTimeMs_ / audioDurationMs_ : 0.0;
  return pcm;
}

qvac_lib_inference_addon_cpp::RuntimeStats MinimaxModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTimeMs", totalTimeMs_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("backendDevice", backendDeviceFromName(backendName_));
  stats.emplace_back("backendId", backendIdFromName(backendName_));
  stats.emplace_back(
      "gpuFallbackReason", gpuFallbackReasonCode(gpuFallbackReason_));
  return stats;
}

} // namespace qvac::audiogenggml::minimax
