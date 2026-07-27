#include "model-interface/parler/ParlerModel.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <tts-cpp/parler/description.h>
#include <tts-cpp/parler/engine.h>

#include "addon/TTSErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/BackendUtils.hpp"
#include "model-interface/OutputResampler.hpp"

namespace qvac::ttsggml::parler {

namespace {

using qvac_errors::createTTSError;
using qvac_errors::StatusError;
using qvac_errors::tts_error::TTSErrorCode;
namespace general_error = qvac_errors::general_error;

bool hasTemplateField(const ParlerDescriptionFields& d) {
  return !d.voice.empty() || !d.emotion.empty() || !d.pitch.empty() ||
         !d.pace.empty() || !d.expressivity.empty() || !d.noise.empty() ||
         !d.reverb.empty() || !d.quality.empty();
}

tts_cpp::parler::DescriptionSpec toSpec(const ParlerDescriptionFields& d) {
  tts_cpp::parler::DescriptionSpec spec;
  spec.voice = d.voice;
  spec.emotion = d.emotion;
  spec.pitch = d.pitch;
  spec.pace = d.pace;
  spec.expressivity = d.expressivity;
  spec.noise = d.noise;
  spec.reverb = d.reverb;
  spec.quality = d.quality;
  return spec;
}

tts_cpp::parler::EngineOptions toEngineOptions(const ParlerConfig& cfg) {
  tts_cpp::parler::EngineOptions opts;
  opts.model_gguf_path = cfg.modelGgufPath;
  opts.default_description = ParlerModel::resolveDescription(cfg.desc);
  if (cfg.seed.has_value())
    opts.seed = *cfg.seed;
  if (cfg.threads.has_value())
    opts.n_threads = *cfg.threads;
  // GPU offload (mirrors SupertonicModel::toEngineOptions): explicit nGpuLayers
  // wins; else the useGpu switch maps true->99 (offload all) / false->0 (CPU).
  if (cfg.nGpuLayers.has_value()) {
    opts.n_gpu_layers = *cfg.nGpuLayers;
  } else if (cfg.useGpu.has_value()) {
    opts.n_gpu_layers = *cfg.useGpu ? kOffloadAllGpuLayers : 0;
  }
  if (cfg.temperature.has_value())
    opts.temperature = *cfg.temperature;
  if (cfg.topK.has_value())
    opts.top_k = *cfg.topK;
  if (cfg.topP.has_value())
    opts.top_p = *cfg.topP;
  if (cfg.maxFrames.has_value())
    opts.max_frames = *cfg.maxFrames;
  if (cfg.minNewTokens.has_value())
    opts.min_new_tokens = *cfg.minNewTokens;
  if (cfg.normalizeNumbers.has_value())
    opts.normalize_numbers = *cfg.normalizeNumbers;
  if (cfg.streamChunkTokens.has_value())
    opts.stream_chunk_frames = *cfg.streamChunkTokens;
  if (cfg.streamFirstChunkTokens.has_value())
    opts.stream_first_chunk_frames = *cfg.streamFirstChunkTokens;

  // Mirrors SupertonicModel::toEngineOptions: compose
  // `cfg.backendsDir / BACKENDS_SUBDIR` before forwarding.
  if (!cfg.backendsDir.empty()) {
    std::filesystem::path backendsDirPath(cfg.backendsDir);
#ifdef BACKENDS_SUBDIR
    backendsDirPath = (backendsDirPath / std::filesystem::path(BACKENDS_SUBDIR))
                          .lexically_normal();
#endif
    opts.backends_dir = backendsDirPath.string();
  }
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

} // namespace

ParlerModel::ParlerModel(ParlerConfig config) : cfg_(std::move(config)) {
  validateConfig(cfg_);
  // load() is deferred to waitForLoadInitialization(); see ChatterboxModel.
}

ParlerModel::~ParlerModel() noexcept = default;

std::string
ParlerModel::resolveDescription(const ParlerDescriptionFields& desc) {
  if (!desc.description.empty()) {
    if (hasTemplateField(desc)) {
      throw StatusError(
          general_error::InvalidArgument,
          "description is mutually exclusive with the voice/emotion/pitch/"
          "pace/expressivity/noise/reverb/quality template options");
    }
    return desc.description;
  }
  try {
    return tts_cpp::parler::build_description(toSpec(desc));
  } catch (const std::invalid_argument& e) {
    throw StatusError(general_error::InvalidArgument, e.what());
  }
}

void ParlerModel::validateConfig(const ParlerConfig& cfg) {
  if (cfg.modelGgufPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument, "parlerModelPath is required");
  }
  if (!std::filesystem::exists(cfg.modelGgufPath)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "parler model not found: " + cfg.modelGgufPath);
  }
  // Same-level description/template conflict + template value validation.
  (void)resolveDescription(cfg.desc);
  if (cfg.temperature.has_value() && *cfg.temperature < 0.0f) {
    throw StatusError(
        general_error::InvalidArgument,
        "temperature must be >= 0 (0 = model default)");
  }
  if (cfg.topK.has_value() && *cfg.topK < 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "topK must be >= 0 (0 = model default)");
  }
  if (cfg.topP.has_value() && (*cfg.topP <= 0.0f || *cfg.topP > 1.0f)) {
    throw StatusError(general_error::InvalidArgument, "topP must be in (0, 1]");
  }
  // ~86 decoder steps/s: a cap under 10 cannot fit even the delay-pattern
  // warmup, so reject it instead of synthesizing silence.
  if (cfg.maxFrames.has_value() &&
      (*cfg.maxFrames < 0 || (*cfg.maxFrames > 0 && *cfg.maxFrames <= 9))) {
    throw StatusError(
        general_error::InvalidArgument,
        "maxFrames must be 0 (model default) or > 9");
  }
  if (cfg.minNewTokens.has_value() && *cfg.minNewTokens < -1) {
    throw StatusError(
        general_error::InvalidArgument,
        "minNewTokens must be >= -1 (-1 = model default)");
  }
  if (cfg.outputSampleRate.has_value() && *cfg.outputSampleRate != 0 &&
      (*cfg.outputSampleRate < 8000 || *cfg.outputSampleRate > 192000)) {
    throw StatusError(
        general_error::InvalidArgument,
        "outputSampleRate must be 0 or in [8000, 192000]");
  }
  if (cfg.streamChunkTokens.has_value() && *cfg.streamChunkTokens < 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "streamChunkTokens must be >= 0 (0 = non-streaming)");
  }
  if (cfg.streamFirstChunkTokens.has_value() &&
      *cfg.streamFirstChunkTokens < 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "streamFirstChunkTokens must be >= 0 (0 = same as streamChunkTokens)");
  }
  // Native streaming emits at the engine's 44100 Hz; addon-side per-chunk
  // resampling would break seams, so reject a non-native rate while streaming.
  if (cfg.streamChunkTokens.value_or(0) > 0 &&
      cfg.outputSampleRate.has_value() && *cfg.outputSampleRate != 0 &&
      *cfg.outputSampleRate != 44100) {
    throw StatusError(
        general_error::InvalidArgument,
        "Parler native streaming emits at 44100 Hz; drop outputSampleRate or "
        "disable streaming (streamChunkTokens) for resampled batch output.");
  }
  // Defense-in-depth (JS runs the same check first): reject useGPU/nGpuLayers
  // conflicts so callers can't silently get the opposite backend they asked
  // for.
  if (cfg.useGpu.has_value() && cfg.nGpuLayers.has_value()) {
    const bool wantsGpuFlag = *cfg.useGpu;
    const int layers = *cfg.nGpuLayers;
    const bool layersWantGpu = layers != 0;
    if (wantsGpuFlag != layersWantGpu) {
      throw StatusError(
          general_error::InvalidArgument,
          std::string("ParlerModel: useGPU=") +
              (wantsGpuFlag ? "true" : "false") +
              " conflicts with nGpuLayers=" + std::to_string(layers) +
              ". Either drop one of the two, or make them agree "
              "(useGPU:true + nGpuLayers!=0, or useGPU:false + nGpuLayers=0).");
    }
  }
}

void ParlerModel::setConfig(ParlerConfig config) {
  validateConfig(config);
  cfg_ = std::move(config);
}

void ParlerModel::load() {
  std::lock_guard lk(engineMu_);
  loadLocked();
}

void ParlerModel::unload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
}

void ParlerModel::reload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
  loadLocked();
}

void ParlerModel::loadLocked() {
  if (engine_)
    return;

  try {
    engine_ = std::make_shared<tts_cpp::parler::Engine>(toEngineOptions(cfg_));
  } catch (const std::exception& e) {
    engine_.reset();
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        std::string("ParlerModel::load: ") + e.what());
  }

  backendName_ = engine_->backend_name();
  backendDevice_ = backendDeviceCode(engine_->backend_device());
  backendId_ = backendIdFromName(backendName_);
  // Parler's engine has no gpu_unsupported() flag (unlike Supertonic); derive
  // it: GPU intent that resolved to the CPU device means the GPU was unusable.
  const bool wantsGpu = cfg_.nGpuLayers.has_value()
                            ? (*cfg_.nGpuLayers != 0)
                            : cfg_.useGpu.value_or(false);
  gpuUnsupported_ = wantsGpu && backendDevice_ == kBackendDeviceCpu;
}

void ParlerModel::unloadLocked() { engine_.reset(); }

void ParlerModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
  std::shared_ptr<tts_cpp::parler::Engine> e;
  {
    std::lock_guard lk(engineMu_);
    e = engine_;
  }
  if (e)
    e->cancel();
}

ParlerModel::SynthResult ParlerModel::synthesize(const AnyInput& input) {
  std::shared_ptr<tts_cpp::parler::Engine> engine;
  {
    std::lock_guard lk(engineMu_);
    engine = engine_;
  }
  if (!engine) {
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        "ParlerModel::synthesize: engine not loaded");
  }
  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed, "synthesis cancelled before it started");
  }

  // Pin the streaming decision to the engine we actually call (its immutable
  // options), so a concurrent reload() swapping engine_ can't change it.
  const bool wasStreaming = static_cast<bool>(input.chunkCallback) &&
                            engine->options().stream_chunk_frames > 0;

  // Per-call description resolution: explicit text wins for this call;
  // template fields merge over the constructor-level template fields.
  // A constructor-level free-text description cannot be merged with
  // per-call template fields — that combination is rejected.
  std::string description;
  if (!input.desc.description.empty()) {
    description = resolveDescription(input.desc);
  } else if (hasTemplateField(input.desc)) {
    if (!cfg_.desc.description.empty()) {
      throw StatusError(
          general_error::InvalidArgument,
          "per-call template options (voice/emotion/...) cannot be combined "
          "with a constructor-level description; pass a per-call description "
          "instead");
    }
    ParlerDescriptionFields merged = cfg_.desc;
    if (!input.desc.voice.empty())
      merged.voice = input.desc.voice;
    if (!input.desc.emotion.empty())
      merged.emotion = input.desc.emotion;
    if (!input.desc.pitch.empty())
      merged.pitch = input.desc.pitch;
    if (!input.desc.pace.empty())
      merged.pace = input.desc.pace;
    if (!input.desc.expressivity.empty())
      merged.expressivity = input.desc.expressivity;
    if (!input.desc.noise.empty())
      merged.noise = input.desc.noise;
    if (!input.desc.reverb.empty())
      merged.reverb = input.desc.reverb;
    if (!input.desc.quality.empty())
      merged.quality = input.desc.quality;
    description = resolveDescription(merged);
  }

  textLength_ = input.text.size();

  const auto t0 = std::chrono::steady_clock::now();
  tts_cpp::parler::SynthesisResult result;
  try {
    if (wasStreaming) {
      // Streaming needs an explicit description; an empty per-call value
      // resolves to the constructor default (== engine.default_description).
      const std::string streamDesc =
          description.empty() ? resolveDescription(cfg_.desc) : description;
      result = engine->synthesize(
          input.text,
          streamDesc,
          [&input](const float* pcm, std::size_t n, int idx, bool isLast) {
            input.chunkCallback(pcmFloatToInt16(pcm, n), idx, isLast);
          });
    } else {
      result = description.empty()
                   ? engine->synthesize(input.text)
                   : engine->synthesize(input.text, description);
    }
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("parler.synthesize: ") + e.what());
  }

  // The parler engine has no output-rate knob; resample addon-side (batch only
  // — streaming is validated to native rate, and per-chunk resampling would
  // seam).
  if (!wasStreaming && cfg_.outputSampleRate.has_value() &&
      *cfg_.outputSampleRate > 0 &&
      *cfg_.outputSampleRate != result.sample_rate) {
    result.pcm = OutputResampler::resample(
        result.pcm, result.sample_rate, *cfg_.outputSampleRate);
    result.sample_rate = *cfg_.outputSampleRate;
  }

  const auto t1 = std::chrono::steady_clock::now();

  sampleRate_ = result.sample_rate;
  totalSamples_ = static_cast<int64_t>(result.pcm.size());
  audioDurationMs_ = sampleRate_ > 0
                         ? (static_cast<double>(totalSamples_) * 1000.0 /
                            static_cast<double>(sampleRate_))
                         : 0.0;
  totalTime_ = std::chrono::duration<double>(t1 - t0).count();
  realTimeFactor_ =
      audioDurationMs_ > 0.0 ? (totalTime_ * 1000.0) / audioDurationMs_ : 0.0;
  tokensPerSecond_ =
      totalTime_ > 0.0 ? static_cast<double>(textLength_) / totalTime_ : 0.0;

  if (wasStreaming) {
    return {Output{}, true}; // chunks already emitted via chunkCallback
  }
  return {pcmFloatToInt16(result.pcm.data(), result.pcm.size()), false};
}

std::any ParlerModel::process(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (!anyInput) {
    throw StatusError(
        general_error::InvalidArgument,
        "ParlerModel::process: input must be AnyInput");
  }

  bool expected = false;
  if (!jobInProgress_.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel)) {
    throw StatusError(
        general_error::InternalError,
        "ParlerModel::process: job already in progress");
  }
  struct InProgressGuard {
    std::atomic_bool& flag;
    ~InProgressGuard() { flag.store(false, std::memory_order_release); }
  } guard{jobInProgress_};

  cancelRequested_.store(false, std::memory_order_relaxed);
  SynthResult out = synthesize(*anyInput);
  // Streaming published its chunks via chunkCallback -> OutputQueue; returning
  // the concatenated PCM here would duplicate as a final outputArray event.
  if (out.wasStreaming) {
    return std::any{};
  }
  return std::any(std::move(out.pcm));
}

qvac_lib_inference_addon_cpp::RuntimeStats ParlerModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("tokensPerSecond", tokensPerSecond_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("totalSamples", totalSamples_);
  stats.emplace_back("backendDevice", static_cast<int64_t>(backendDevice_));
  stats.emplace_back("backendId", static_cast<int64_t>(backendId_));
  stats.emplace_back("gpuUnsupported", static_cast<int64_t>(gpuUnsupported_));
  return stats;
}

} // namespace qvac::ttsggml::parler
