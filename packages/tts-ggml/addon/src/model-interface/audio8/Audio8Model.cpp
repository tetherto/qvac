#include "model-interface/audio8/Audio8Model.hpp"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <tts-cpp/audio8/engine.h>

#include "addon/TTSErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/BackendUtils.hpp"
#include "model-interface/PcmConversion.hpp"

namespace qvac::ttsggml::audio8 {

namespace {

using qvac_errors::createTTSError;
using qvac_errors::StatusError;
using qvac_errors::tts_error::TTSErrorCode;
namespace general_error = qvac_errors::general_error;

constexpr int MIN_OUTPUT_SAMPLE_RATE = 8000;
constexpr int MAX_OUTPUT_SAMPLE_RATE = 192000;

void requireFile(const std::string& path, const char* what, TTSErrorCode code) {
  if (!std::filesystem::exists(path)) {
    throw createTTSError(code, std::string(what) + " not found: " + path);
  }
}

// NaN compares false against every bound, so the range checks below would wave
// it through to the sampler; infinities pass whichever bound they are not on
// the wrong side of.
void requireFinite(float value, const char* what) {
  if (!std::isfinite(value)) {
    throw StatusError(
        general_error::InvalidArgument,
        std::string(what) + " must be a finite number");
  }
}

std::filesystem::path resolveBackendsDir(const std::string& configured) {
  std::filesystem::path dir(configured);
#ifdef BACKENDS_SUBDIR
  dir = (dir / std::filesystem::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
  return dir;
}

tts_cpp::audio8::EngineOptions toEngineOptions(const Audio8Config& cfg) {
  tts_cpp::audio8::EngineOptions opts;
  opts.lm_gguf_path = cfg.lmModelPath;
  opts.codec_decoder_gguf_path = cfg.codecDecoderPath;
  opts.codec_encoder_gguf_path = cfg.codecEncoderPath;
  if (cfg.greedy.has_value())
    opts.greedy = *cfg.greedy;
  if (cfg.seed.has_value())
    opts.seed = *cfg.seed;
  if (cfg.threads.has_value())
    opts.n_threads = *cfg.threads;
  if (cfg.temperature.has_value())
    opts.temperature = *cfg.temperature;
  if (cfg.topK.has_value())
    opts.top_k = *cfg.topK;
  if (cfg.topP.has_value())
    opts.top_p = *cfg.topP;
  if (cfg.maxFrames.has_value())
    opts.max_frames = *cfg.maxFrames;
  if (cfg.outputSampleRate.has_value())
    opts.output_sample_rate = *cfg.outputSampleRate;
  // Mirrors ParlerModel::toEngineOptions: explicit nGpuLayers wins; else the
  // useGpu switch maps true->99 (offload all) / false->0 (CPU).
  if (cfg.nGpuLayers.has_value()) {
    opts.n_gpu_layers = *cfg.nGpuLayers;
  } else if (cfg.useGpu.has_value()) {
    opts.n_gpu_layers = *cfg.useGpu ? kOffloadAllGpuLayers : 0;
  }
  if (!cfg.backendsDir.empty()) {
    opts.backends_dir = resolveBackendsDir(cfg.backendsDir).string();
  }
  return opts;
}

void validateModelPaths(const Audio8Config& cfg) {
  if (cfg.lmModelPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument, "audio8LmPath is required");
  }
  if (cfg.codecDecoderPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument, "audio8CodecDecoderPath is required");
  }
  requireFile(
      cfg.lmModelPath,
      "audio8 language model",
      TTSErrorCode::ModelFileNotFound);
  requireFile(
      cfg.codecDecoderPath,
      "audio8 codec decoder",
      TTSErrorCode::ModelFileNotFound);
  if (!cfg.codecEncoderPath.empty()) {
    requireFile(
        cfg.codecEncoderPath,
        "audio8 codec encoder",
        TTSErrorCode::ModelFileNotFound);
  }
}

void validateSampling(const Audio8Config& cfg) {
  if (cfg.temperature.has_value()) {
    requireFinite(*cfg.temperature, "temperature");
    if (*cfg.temperature < 0.0f) {
      throw StatusError(
          general_error::InvalidArgument,
          "temperature must be >= 0 (0 = greedy)");
    }
  }
  if (cfg.topK.has_value() && *cfg.topK < 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "topK must be >= 0 (0 = no top-k cutoff)");
  }
  if (cfg.topP.has_value()) {
    requireFinite(*cfg.topP, "topP");
    if (*cfg.topP <= 0.0f || *cfg.topP > 1.0f) {
      throw StatusError(
          general_error::InvalidArgument, "topP must be in (0, 1]");
    }
  }
  if (cfg.maxFrames.has_value() && *cfg.maxFrames < 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "maxFrames must be >= 0 (0 = engine default)");
  }
  if (cfg.outputSampleRate.has_value() && *cfg.outputSampleRate != 0 &&
      (*cfg.outputSampleRate < MIN_OUTPUT_SAMPLE_RATE ||
       *cfg.outputSampleRate > MAX_OUTPUT_SAMPLE_RATE)) {
    throw StatusError(
        general_error::InvalidArgument,
        "outputSampleRate must be 0 or in [8000, 192000]");
  }
}

// Defense-in-depth (JS runs the same check first): reject useGPU/nGpuLayers
// conflicts so callers can't silently get the opposite backend they asked for.
void validateGpuIntent(const Audio8Config& cfg) {
  if (!cfg.useGpu.has_value() || !cfg.nGpuLayers.has_value())
    return;
  const bool wantsGpuFlag = *cfg.useGpu;
  const int layers = *cfg.nGpuLayers;
  if (wantsGpuFlag == (layers != 0))
    return;
  throw StatusError(
      general_error::InvalidArgument,
      std::string("Audio8Model: useGPU=") + (wantsGpuFlag ? "true" : "false") +
          " conflicts with nGpuLayers=" + std::to_string(layers) +
          ". Either drop one of the two, or make them agree "
          "(useGPU:true + nGpuLayers!=0, or useGPU:false + nGpuLayers=0).");
}

} // namespace

Audio8Model::Audio8Model(Audio8Config config) : cfg_(std::move(config)) {
  validateConfig(cfg_);
  // load() is deferred to waitForLoadInitialization(); see ChatterboxModel.
}

Audio8Model::~Audio8Model() noexcept = default;

void Audio8Model::validateConfig(const Audio8Config& cfg) {
  validateModelPaths(cfg);
  validateVoice(cfg.referenceAudio, cfg.referenceText, cfg.codecEncoderPath);
  validateSampling(cfg);
  validateGpuIntent(cfg);
}

void Audio8Model::validateVoice(
    const std::string& audio, const std::string& text,
    const std::string& encoderPath) {
  if (audio.empty() && text.empty())
    return;
  if (audio.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "referenceText needs a referenceAudio to transcribe");
  }
  if (encoderPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "voice cloning needs audio8CodecEncoderPath, which was not configured");
  }
  // The model conditions on the transcript as the turn the reference answers,
  // so a missing one degrades the clone silently. Reject instead.
  if (text.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "referenceAudio needs a referenceText saying what the recording says");
  }
  requireFile(audio, "audio8 reference audio", TTSErrorCode::ModelFileNotFound);
}

void Audio8Model::setConfig(Audio8Config config) {
  validateConfig(config);
  std::lock_guard lk(engineMu_);
  cfg_ = std::move(config);
}

void Audio8Model::reloadWith(Audio8Config config) {
  validateConfig(config);
  std::lock_guard lk(engineMu_);
  requireSameEmittedRate(cfg_, config, sampleRate_);
  cfg_ = std::move(config);
  unloadLocked();
  loadLocked();
}

void Audio8Model::requireSameEmittedRate(
    const Audio8Config& current, const Audio8Config& next, int nativeRate) {
  const int rate = emittedSampleRate(current, nativeRate);
  if (emittedSampleRate(next, nativeRate) == rate)
    return;
  throw StatusError(
      general_error::InvalidArgument,
      "reload cannot change the audio8 output sample rate (currently " +
          std::to_string(rate) +
          " Hz); destroy the instance and create a new one instead.");
}

void Audio8Model::load() {
  std::lock_guard lk(engineMu_);
  loadLocked();
}

void Audio8Model::unload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
}

void Audio8Model::reload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
  loadLocked();
}

void Audio8Model::loadLocked() {
  if (engine_)
    return;

  try {
    engine_ = std::make_shared<tts_cpp::audio8::Engine>(toEngineOptions(cfg_));
  } catch (const std::exception& e) {
    engine_.reset();
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        std::string("Audio8Model::load: ") + e.what());
  }

  sampleRate_ = engine_->sample_rate();
  backendName_ = engine_->backend_name();
  backendDevice_ = backendDeviceCode(engine_->backend_device());
  backendId_ = backendIdFromName(backendName_);
  // The engine is CPU-only today, so GPU intent always resolves to the CPU
  // device; report it the way ParlerModel derives the same signal.
  const bool wantsGpu = cfg_.nGpuLayers.has_value()
                            ? (*cfg_.nGpuLayers != 0)
                            : cfg_.useGpu.value_or(false);
  gpuUnsupported_ = wantsGpu && backendDevice_ == kBackendDeviceCpu;
}

void Audio8Model::unloadLocked() { engine_.reset(); }

void Audio8Model::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
  std::shared_ptr<tts_cpp::audio8::Engine> e;
  {
    std::lock_guard lk(engineMu_);
    e = engine_;
  }
  if (e)
    e->cancel();
}

// A per-call recording replaces both halves -- it cannot inherit a transcript
// that describes a different recording -- while a per-call transcript alone
// corrects the configured one.
Audio8Model::VoiceOverride
Audio8Model::mergeVoice(const Audio8Config& cfg, const VoiceOverride& perCall) {
  VoiceOverride voice{cfg.referenceAudio, cfg.referenceText};
  if (!perCall.referenceAudio.empty()) {
    voice.referenceAudio = perCall.referenceAudio;
    voice.referenceText = perCall.referenceText;
  }
  if (!perCall.referenceText.empty()) {
    voice.referenceText = perCall.referenceText;
  }
  validateVoice(
      voice.referenceAudio, voice.referenceText, cfg.codecEncoderPath);
  return voice;
}

Audio8Model::VoiceOverride
Audio8Model::resolveVoice(const VoiceOverride& perCall) const {
  return mergeVoice(config(), perCall);
}

Audio8Model::Output Audio8Model::synthesize(const AnyInput& input) {
  // Engine and configuration are taken together, so a reload landing mid-job
  // cannot pair one call's voice with the other call's engine.
  std::shared_ptr<tts_cpp::audio8::Engine> engine;
  Audio8Config cfg;
  {
    std::lock_guard lk(engineMu_);
    engine = engine_;
    cfg = cfg_;
  }
  if (!engine) {
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        "Audio8Model::synthesize: engine not loaded");
  }
  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed, "synthesis cancelled before it started");
  }

  const VoiceOverride voice = mergeVoice(cfg, input.voice);

  const auto t0 = std::chrono::steady_clock::now();
  tts_cpp::audio8::SynthesisResult result;
  try {
    // The engine caches the codes for the most recent voice prompt, so
    // repeating the same reference across calls skips the codec encoder.
    result = voice.referenceAudio.empty()
                 ? engine->synthesize(input.text)
                 : engine->synthesize(
                       input.text,
                       tts_cpp::audio8::load_voice_prompt(
                           voice.referenceAudio, voice.referenceText));
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("audio8.synthesize: ") + e.what());
  }
  const auto t1 = std::chrono::steady_clock::now();

  sampleRate_ = result.sample_rate;
  generatedFrames_ = result.frames;
  totalSamples_ = static_cast<int64_t>(result.pcm.size());
  audioDurationMs_ = static_cast<double>(result.duration_s) * 1000.0;
  totalTime_ = std::chrono::duration<double>(t1 - t0).count();
  realTimeFactor_ =
      audioDurationMs_ > 0.0 ? (totalTime_ * 1000.0) / audioDurationMs_ : 0.0;
  tokensPerSecond_ = totalTime_ > 0.0
                         ? static_cast<double>(generatedFrames_) / totalTime_
                         : 0.0;

  return pcmFloatToInt16(result.pcm);
}

std::any Audio8Model::process(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (!anyInput) {
    throw StatusError(
        general_error::InvalidArgument,
        "Audio8Model::process: input must be AnyInput");
  }

  bool expected = false;
  if (!jobInProgress_.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel)) {
    throw StatusError(
        general_error::InternalError,
        "Audio8Model::process: job already in progress");
  }
  struct InProgressGuard {
    std::atomic_bool& flag;
    ~InProgressGuard() { flag.store(false, std::memory_order_release); }
  } guard{jobInProgress_};

  cancelRequested_.store(false, std::memory_order_relaxed);
  return std::any(synthesize(*anyInput));
}

qvac_lib_inference_addon_cpp::RuntimeStats Audio8Model::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("tokensPerSecond", tokensPerSecond_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("totalSamples", totalSamples_);
  stats.emplace_back("generatedFrames", static_cast<int64_t>(generatedFrames_));
  stats.emplace_back("backendDevice", static_cast<int64_t>(backendDevice_));
  stats.emplace_back("backendId", static_cast<int64_t>(backendId_));
  stats.emplace_back("gpuUnsupported", static_cast<int64_t>(gpuUnsupported_));
  return stats;
}

} // namespace qvac::ttsggml::audio8
