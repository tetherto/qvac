#include "model-interface/supertonic/SupertonicModel.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

#include <tts-cpp/supertonic/engine.h>

#include "addon/TTSErrors.hpp"
#include "model-interface/BackendUtils.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "inference-addon-cpp/Logger.hpp"

namespace qvac::ttsggml::supertonic {

namespace {

using qvac_errors::createTTSError;
using qvac_errors::StatusError;
using qvac_errors::tts_error::TTSErrorCode;
namespace general_error = qvac_errors::general_error;
namespace logger = qvac_lib_inference_addon_cpp::logger;

tts_cpp::supertonic::EngineOptions toEngineOptions(const SupertonicConfig& cfg) {
  tts_cpp::supertonic::EngineOptions opts;
  opts.model_gguf_path = cfg.modelGgufPath;
  opts.voice           = cfg.voice;
  if (!cfg.language.empty()) opts.language = cfg.language;
  if (cfg.steps.has_value())   opts.steps = *cfg.steps;
  if (cfg.speed.has_value())   opts.speed = *cfg.speed;
  if (cfg.seed.has_value())    opts.seed  = *cfg.seed;
  if (cfg.threads.has_value()) opts.n_threads = *cfg.threads;
  if (cfg.nGpuLayers.has_value()) {
    opts.n_gpu_layers = *cfg.nGpuLayers;
  } else if (cfg.useGpu.has_value()) {
    opts.n_gpu_layers = *cfg.useGpu ? 99 : 0;
  }
  opts.noise_npy_path = cfg.noiseNpyPath;

  // Mirrors ChatterboxModel::toEngineOptions; see that file for the
  // detailed rationale. Compose `cfg.backendsDir / BACKENDS_SUBDIR`
  // before forwarding so a host that already passes
  // `path.join(__dirname, 'prebuilds')` (the qvac
  // llm-llamacpp / transcription-parakeet convention) gets the
  // expected `<bare-target>/qvac__tts-ggml/` scan dir without
  // knowing the per-arch shape.
  if (!cfg.backendsDir.empty()) {
    std::filesystem::path backendsDirPath(cfg.backendsDir);
#ifdef BACKENDS_SUBDIR
    backendsDirPath =
        (backendsDirPath / std::filesystem::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
    opts.backends_dir = backendsDirPath.string();
  }
  opts.opencl_cache_dir = cfg.openclCacheDir;
  return opts;
}

std::vector<int16_t> pcmFloatToInt16(const float* pcm, size_t samples) {
  std::vector<int16_t> out;
  out.resize(samples);
  for (size_t i = 0; i < samples; ++i) {
    float s = std::clamp(pcm[i], -1.0f, 1.0f);
    out[i] = static_cast<int16_t>(std::lround(s * 32767.0f));
  }
  return out;
}

}

SupertonicModel::SupertonicModel(SupertonicConfig config)
    : cfg_(std::move(config)) {
  validateConfig(cfg_);
  // See ChatterboxModel ctor: load() is deferred to
  // waitForLoadInitialization() so the GGUF parse runs off the JS event
  // loop via JsAsyncTask::run-driven addon.activate().
}

SupertonicModel::~SupertonicModel() noexcept = default;

void SupertonicModel::validateConfig(const SupertonicConfig& cfg) {
  if (cfg.modelGgufPath.empty()) {
    throw StatusError(general_error::InvalidArgument,
                      "supertonicModelPath is required");
  }
  if (!std::filesystem::exists(cfg.modelGgufPath)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound,
                         "supertonic model not found: " + cfg.modelGgufPath);
  }
  if (cfg.steps.has_value() && *cfg.steps < 0) {
    throw StatusError(general_error::InvalidArgument,
                      "steps must be >= 0");
  }
  if (cfg.speed.has_value() && *cfg.speed < 0.0f) {
    throw StatusError(general_error::InvalidArgument,
                      "speed must be >= 0");
  }
  if (!cfg.noiseNpyPath.empty() &&
      !std::filesystem::exists(cfg.noiseNpyPath)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound,
                         "noise npy not found: " + cfg.noiseNpyPath);
  }
  // Defense-in-depth: the JS layer (index.js::_validateConfig) runs the
  // same conflict check before this method is reached, so direct C++
  // callers are the only ones who can actually trip this branch.
  // Mirror the Chatterbox suffix verbatim so users see an identical
  // hint regardless of which engine they instantiated.  `layers != 0`
  // matches llama.cpp's "-1 = offload all" sentinel convention.
  if (cfg.useGpu.has_value() && cfg.nGpuLayers.has_value()) {
    const bool wantsGpuFlag   = *cfg.useGpu;
    const int  layers         = *cfg.nGpuLayers;
    const bool layersWantGpu  = layers != 0;
    if (wantsGpuFlag != layersWantGpu) {
      throw StatusError(
          general_error::InvalidArgument,
          std::string("SupertonicModel: useGPU=") +
              (wantsGpuFlag ? "true" : "false") +
              " conflicts with nGpuLayers=" + std::to_string(layers) +
              ". Either drop one of the two, or make them agree "
              "(useGPU:true + nGpuLayers!=0, or useGPU:false + nGpuLayers=0).");
    }
  }
  // GPU execution is supported as of tts-cpp@2026-06-05 (QVAC-18605
  // Supertonic Vulkan/Metal optimisations + QVAC-19254 sched/cpu_backend
  // refactor for Adreno OpenCL).  Backend selection follows tts-cpp's
  // init_gpu_backend tier policy: Adreno 700+ -> OpenCL, otherwise
  // Vulkan/Metal/CUDA via the registry walk, otherwise CPU.  Caller
  // intent (useGPU / nGpuLayers) is honoured.
}

void SupertonicModel::load() {
  std::lock_guard lk(engineMu_);
  loadLocked();
}

void SupertonicModel::unload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
}

void SupertonicModel::reload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
  loadLocked();
}

void SupertonicModel::loadLocked() {
  if (engine_) return;

  // Android GPU policy is delegated to tts-cpp's init_gpu_backend tier
  // policy as of QVAC-19254: it allowlists Qualcomm Adreno (OpenCL on
  // Adreno 700+, falls through to Vulkan / CPU on other tiers) and
  // skips Mali / non-Adreno GPUs that would abort ggml_backend_graph_
  // compute.  No extra force-off at this boundary; consumers asking
  // for useGPU=true on Android will get Adreno-OpenCL when available
  // and CPU otherwise.

  try {
    engine_ = std::make_shared<tts_cpp::supertonic::Engine>(toEngineOptions(cfg_));
  } catch (const std::exception& e) {
    engine_.reset();
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        std::string("SupertonicModel::load: ") + e.what());
  }

  backendName_   = engine_->backend_name();
  backendDevice_ = backendDeviceCode(engine_->backend_device());
  backendId_     = backendIdFromName(backendName_);
}

void SupertonicModel::unloadLocked() {
  engine_.reset();
}

void SupertonicModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
  std::shared_ptr<tts_cpp::supertonic::Engine> e;
  {
    std::lock_guard lk(engineMu_);
    e = engine_;
  }
  if (e) e->cancel();
}

SupertonicModel::Output SupertonicModel::synthesize(const std::string& text) {
  std::shared_ptr<tts_cpp::supertonic::Engine> engine;
  {
    std::lock_guard lk(engineMu_);
    engine = engine_;
  }
  if (!engine) {
    throw createTTSError(TTSErrorCode::InitializationFailed,
                         "SupertonicModel::synthesize: engine not loaded");
  }
  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw createTTSError(TTSErrorCode::SynthesisFailed,
                         "synthesis cancelled before it started");
  }

  textLength_ = text.size();

  const auto t0 = std::chrono::steady_clock::now();
  tts_cpp::supertonic::SynthesisResult result;
  try {
    result = engine->synthesize(text);
  } catch (const std::exception& e) {
    throw createTTSError(TTSErrorCode::SynthesisFailed,
                         std::string("supertonic.synthesize: ") + e.what());
  }
  const auto t1 = std::chrono::steady_clock::now();

  sampleRate_ = result.sample_rate;
  totalSamples_ = static_cast<int64_t>(result.pcm.size());
  audioDurationMs_ = result.duration_s > 0.0f
      ? result.duration_s * 1000.0
      : (sampleRate_ > 0 ? (static_cast<double>(totalSamples_) * 1000.0 /
                            static_cast<double>(sampleRate_))
                         : 0.0);
  totalTime_ = std::chrono::duration<double>(t1 - t0).count();
  realTimeFactor_ = audioDurationMs_ > 0.0
      ? (totalTime_ * 1000.0) / audioDurationMs_
      : 0.0;
  tokensPerSecond_ = totalTime_ > 0.0
      ? static_cast<double>(textLength_) / totalTime_
      : 0.0;

  return pcmFloatToInt16(result.pcm.data(), result.pcm.size());
}

std::any SupertonicModel::process(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (!anyInput) {
    throw StatusError(general_error::InvalidArgument,
                      "SupertonicModel::process: input must be AnyInput");
  }

  bool expected = false;
  if (!jobInProgress_.compare_exchange_strong(expected, true,
                                              std::memory_order_acq_rel)) {
    throw StatusError(general_error::InternalError,
                      "SupertonicModel::process: job already in progress");
  }
  struct InProgressGuard {
    std::atomic_bool& flag;
    ~InProgressGuard() { flag.store(false, std::memory_order_release); }
  } guard{jobInProgress_};

  cancelRequested_.store(false, std::memory_order_relaxed);
  return std::any(synthesize(anyInput->text));
}

qvac_lib_inference_addon_cpp::RuntimeStats SupertonicModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("tokensPerSecond", tokensPerSecond_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("totalSamples", totalSamples_);
  stats.emplace_back("backendDevice", static_cast<int64_t>(backendDevice_));
  stats.emplace_back("backendId",     static_cast<int64_t>(backendId_));
  return stats;
}

}
