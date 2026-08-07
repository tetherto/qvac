#include "model-interface/parler/ParlerModel.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <tts-cpp/lavasr/denoiser.h>
#include <tts-cpp/lavasr/enhancer.h>
#include <tts-cpp/parler/description.h>
#include <tts-cpp/parler/engine.h>

#include "addon/TTSErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/BackendUtils.hpp"
#include "model-interface/DenoiserLoader.hpp"
#include "model-interface/EnhancerLoader.hpp"
#include "model-interface/OutputResampler.hpp"
#include "model-interface/PcmConversion.hpp"
#include "model-interface/StreamingEnhancer.hpp"

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

std::shared_ptr<tts_cpp::parler::Engine> makeEngine(const ParlerConfig& cfg) {
  try {
    return std::make_shared<tts_cpp::parler::Engine>(toEngineOptions(cfg));
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        std::string("ParlerModel::load: ") + e.what());
  }
}

struct EngineBackend {
  std::string name;
  int device = kBackendDeviceNone;
  int id = kBackendIdNone;
  bool gpuUnsupported = false;
};

bool wantsGpu(const ParlerConfig& cfg) {
  return cfg.nGpuLayers.has_value() ? (*cfg.nGpuLayers != 0)
                                    : cfg.useGpu.value_or(false);
}

EngineBackend resolveEngineBackend(
    const tts_cpp::parler::Engine& engine, const ParlerConfig& cfg) {
  EngineBackend backend;
  backend.name = engine.backend_name();
  backend.device = backendDeviceCode(engine.backend_device());
  backend.id = backendIdFromName(backend.name);
  // Parler's engine has no gpu_unsupported() flag (unlike Supertonic); derive
  // it: GPU intent that resolved to the CPU device means the GPU was unusable.
  backend.gpuUnsupported = wantsGpu(cfg) && backend.device == kBackendDeviceCpu;
  return backend;
}

// Sample rates involved once the LavaSR enhancer is active: the engine emits
// its native 44.1 kHz, the enhancer resamples to `workRate` (48 kHz), and the
// streaming path finally emits at `streamFinalRate` (a caller-requested rate,
// else the work rate). All zero when no enhancer is loaded.
struct EnhancerRates {
  int workRate = 0;
  int streamFinalRate = 0;
};

EnhancerRates resolveEnhancerRates(
    const std::shared_ptr<tts_cpp::lavasr::Enhancer>& enhancer,
    const std::optional<int>& outputSampleRate) {
  if (!enhancer)
    return {};
  const int workRate = enhancer->output_sample_rate();
  const bool hasRequestedRate =
      outputSampleRate.has_value() && *outputSampleRate > 0;
  return {workRate, hasRequestedRate ? *outputSampleRate : workRate};
}

// Wraps the one-shot enhancer as a streaming stage: enhance at the engine's
// native rate, then resample to the streaming final rate when they differ.
// Resampling inside the enhance window (rather than per emitted chunk) is what
// keeps the requested output rate seam-free while streaming. StreamingEnhancer
// sizes its context and crossfade from the 44.1 kHz input it is given, so the
// margins cover the enhancer's receptive field in seconds rather than in
// Chatterbox-sized samples.
std::shared_ptr<StreamingEnhancer> makeStreamingEnhancer(
    const std::shared_ptr<tts_cpp::lavasr::Enhancer>& enhancer,
    const EnhancerRates& rates) {
  if (!enhancer)
    return nullptr;
  const int workRate = rates.workRate;
  const int finalRate = rates.streamFinalRate;
  return std::make_shared<StreamingEnhancer>(
      [enhancer, workRate, finalRate](const std::vector<float>& raw) {
        std::vector<float> enhanced =
            enhancer->enhance(raw, kParlerNativeSampleRate);
        if (finalRate != workRate) {
          enhanced = OutputResampler::resample(enhanced, workRate, finalRate);
        }
        return enhanced;
      },
      kParlerNativeSampleRate,
      finalRate);
}

// Per-chunk post-processing for the native streaming path: an optional
// seam-free LavaSR enhancement stage, emitting int16 PCM through the caller's
// callback. Kept as a functor so the engine can call it per chunk while the
// enhancement stage stays individually readable and testable.
struct StreamChunkPostProcessor {
  const ParlerModel::ChunkCallback& emit;
  std::shared_ptr<StreamingEnhancer> streamEnhancer;
  std::size_t& emittedSamples;

  std::vector<float>
  enhanceStage(const float* pcm, std::size_t samples, bool isLast) const {
    std::vector<float> audio = streamEnhancer->feed(pcm, samples);
    if (isLast) {
      const std::vector<float> tail = streamEnhancer->flush();
      audio.insert(audio.end(), tail.begin(), tail.end());
    }
    return audio;
  }

  void operator()(
      const float* pcm, std::size_t samples, int chunkIndex, bool isLast) {
    if (!streamEnhancer) {
      emittedSamples += samples;
      emit(pcmFloatToInt16(pcm, samples), chunkIndex, isLast);
      return;
    }
    const std::vector<float> audio = enhanceStage(pcm, samples, isLast);
    emittedSamples += audio.size();
    emit(pcmFloatToInt16(audio), chunkIndex, isLast);
  }
};

// LavaSR neural denoiser (batch path). Runs BEFORE the enhancer and preserves
// the sample rate. Streaming + denoiser is rejected in validateConfig, so this
// only applies here.
void applyBatchDenoiser(
    tts_cpp::parler::SynthesisResult& result,
    tts_cpp::lavasr::Denoiser& denoiser) {
  try {
    result.pcm = denoiser.denoise(result.pcm, result.sample_rate);
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("parler.lavasr-denoiser: ") + e.what());
  }
}

// The parler engine has no output-rate knob, so a requested rate is applied
// addon-side. Batch only: streaming resamples inside StreamingEnhancer (with
// the enhancer) or is validated to the native rate (without it).
void applyRequestedOutputRate(
    tts_cpp::parler::SynthesisResult& result,
    const std::optional<int>& outputSampleRate) {
  if (!outputSampleRate.has_value() || *outputSampleRate <= 0 ||
      *outputSampleRate == result.sample_rate) {
    return;
  }
  result.pcm = OutputResampler::resample(
      result.pcm, result.sample_rate, *outputSampleRate);
  result.sample_rate = *outputSampleRate;
}

// LavaSR neural bandwidth extension (batch path). Enhances the whole utterance
// at once (the streaming path enhances per chunk instead), updating
// result.sample_rate to the enhancer's 48 kHz output, then honours a requested
// outputSampleRate.
void applyBatchEnhancer(
    tts_cpp::parler::SynthesisResult& result,
    tts_cpp::lavasr::Enhancer& enhancer,
    const std::optional<int>& outputSampleRate) {
  try {
    result.pcm = enhancer.enhance(result.pcm, result.sample_rate);
    result.sample_rate = enhancer.output_sample_rate();
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("parler.lavasr: ") + e.what());
  }
  applyRequestedOutputRate(result, outputSampleRate);
}

// Batch post-processing chain: denoise (rate-preserving), then enhance (which
// also applies a requested output rate); without an enhancer the requested rate
// is applied directly.
void applyBatchPostProcessing(
    tts_cpp::parler::SynthesisResult& result,
    const std::shared_ptr<tts_cpp::lavasr::Denoiser>& denoiser,
    const std::shared_ptr<tts_cpp::lavasr::Enhancer>& enhancer,
    const std::optional<int>& outputSampleRate) {
  if (denoiser)
    applyBatchDenoiser(result, *denoiser);
  if (enhancer) {
    applyBatchEnhancer(result, *enhancer, outputSampleRate);
    return;
  }
  applyRequestedOutputRate(result, outputSampleRate);
}

tts_cpp::parler::SynthesisResult runStreamingSynthesis(
    tts_cpp::parler::Engine& engine, const std::string& text,
    const std::string& description,
    const ParlerModel::ChunkCallback& chunkCallback,
    const std::shared_ptr<tts_cpp::lavasr::Enhancer>& enhancer,
    const EnhancerRates& rates, std::size_t& emittedSamples) {
  try {
    StreamChunkPostProcessor postProcessor{
        chunkCallback, makeStreamingEnhancer(enhancer, rates), emittedSamples};
    return engine.synthesize(text, description, std::move(postProcessor));
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("parler.synthesize: ") + e.what());
  }
}

tts_cpp::parler::SynthesisResult runBatchSynthesis(
    tts_cpp::parler::Engine& engine, const std::string& text,
    const std::string& description) {
  try {
    return description.empty() ? engine.synthesize(text)
                               : engine.synthesize(text, description);
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("parler.synthesize: ") + e.what());
  }
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
  if (!cfg.enhancerGgufPath.empty() &&
      !std::filesystem::exists(cfg.enhancerGgufPath)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "lavasr enhancer GGUF not found: " + cfg.enhancerGgufPath);
  }
  if (!cfg.denoiserGgufPath.empty() &&
      !std::filesystem::exists(cfg.denoiserGgufPath)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "lavasr denoiser GGUF not found: " + cfg.denoiserGgufPath);
  }
  // LavaSR denoiser + native chunk streaming is not supported yet: the UL-UNAS
  // denoiser is causal but tts-cpp only exposes a one-shot denoise(), so a
  // stateful streaming denoiser (à la StreamingEnhancer) is the follow-up.
  // Reject the combo up front rather than silently dropping denoising on the
  // streaming path. Defense-in-depth: index.js rejects it before we get here.
  if (!cfg.denoiserGgufPath.empty() && cfg.streamChunkTokens.value_or(0) > 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "ParlerModel: the LavaSR denoiser is not yet supported with native "
        "chunk streaming (streamChunkTokens > 0). Use batch synthesis, or drop "
        "the denoiser for streaming (streaming denoise is a planned "
        "follow-up).");
  }
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
  // The LavaSR enhancer lifts that restriction: StreamingEnhancer resamples
  // inside its overlap-reprocess windows, so the seams survive.
  if (cfg.streamChunkTokens.value_or(0) > 0 && cfg.enhancerGgufPath.empty() &&
      cfg.outputSampleRate.has_value() && *cfg.outputSampleRate != 0 &&
      *cfg.outputSampleRate != kParlerNativeSampleRate) {
    throw StatusError(
        general_error::InvalidArgument,
        "Parler native streaming emits at 44100 Hz; drop outputSampleRate, "
        "enable the LavaSR enhancer (which resamples seam-free), or disable "
        "streaming (streamChunkTokens) for resampled batch output.");
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

  // Every stage is built into a local before any member is assigned: a throw
  // from the enhancer or denoiser would otherwise leave engine_ set, and the
  // early return above would then report a retry as already loaded while the
  // requested post-processing stage was missing.
  auto engine = makeEngine(cfg_);
  const EngineBackend backend = resolveEngineBackend(*engine, cfg_);
  // The enhancer follows the engine's *resolved* device rather than the
  // requested switch, so an engine that fell back to CPU keeps the enhancer on
  // CPU instead of forcing it onto the GPU alone.
  LoadedEnhancer enhancer = loadEnhancer(
      cfg_.enhancerGgufPath,
      backend.device == kBackendDeviceGpu,
      "ParlerModel::load: lavasr enhancer: ");
  auto denoiser = loadDenoiser(
      cfg_.denoiserGgufPath, "ParlerModel::load: lavasr denoiser: ");

  engine_ = std::move(engine);
  backendName_ = backend.name;
  backendDevice_ = backend.device;
  backendId_ = backend.id;
  gpuUnsupported_ = backend.gpuUnsupported;
  enhancer_ = std::move(enhancer.enhancer);
  enhancerBackendDevice_ = enhancer.backendDevice;
  enhancerBackendId_ = enhancer.backendId;
  denoiser_ = std::move(denoiser);
}

void ParlerModel::unloadLocked() {
  engine_.reset();
  enhancer_.reset();
  denoiser_.reset();
}

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
  // Capture the engine (and enhancer/denoiser) under the lock and keep them
  // alive via these locals for the whole call, even if reload() swaps new ones
  // in concurrently -- the replacements take effect on the NEXT synthesize.
  std::shared_ptr<tts_cpp::parler::Engine> engine;
  std::shared_ptr<tts_cpp::lavasr::Enhancer> enhancer;
  std::shared_ptr<tts_cpp::lavasr::Denoiser> denoiser;
  {
    std::lock_guard lk(engineMu_);
    engine = engine_;
    enhancer = enhancer_;
    denoiser = denoiser_;
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

  const EnhancerRates rates =
      resolveEnhancerRates(enhancer, cfg_.outputSampleRate);

  const auto t0 = std::chrono::steady_clock::now();
  // The streaming callback runs synchronously on this thread, so this plain
  // counter safely tallies the emitted sample count for the stats below.
  std::size_t streamedSamples = 0;
  tts_cpp::parler::SynthesisResult result;
  if (wasStreaming) {
    // Streaming needs an explicit description; an empty per-call value
    // resolves to the constructor default (== engine.default_description).
    const std::string streamDesc =
        description.empty() ? resolveDescription(cfg_.desc) : description;
    result = runStreamingSynthesis(
        *engine,
        input.text,
        streamDesc,
        input.chunkCallback,
        enhancer,
        rates,
        streamedSamples);
  } else {
    result = runBatchSynthesis(*engine, input.text, description);
    applyBatchPostProcessing(result, denoiser, enhancer, cfg_.outputSampleRate);
  }

  const auto t1 = std::chrono::steady_clock::now();

  // While streaming, chunks are emitted at streamFinalRate (the enhancer path)
  // or at the engine's native rate; result.sample_rate stays native either way.
  // On the batch path it already reflects denoise/enhance/resample.
  sampleRate_ =
      (wasStreaming && enhancer) ? rates.streamFinalRate : result.sample_rate;
  totalSamples_ = wasStreaming ? static_cast<int64_t>(streamedSamples)
                               : static_cast<int64_t>(result.pcm.size());
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
  stats.emplace_back(
      "enhancerBackendDevice", static_cast<int64_t>(enhancerBackendDevice_));
  stats.emplace_back(
      "enhancerBackendId", static_cast<int64_t>(enhancerBackendId_));
  return stats;
}

} // namespace qvac::ttsggml::parler
