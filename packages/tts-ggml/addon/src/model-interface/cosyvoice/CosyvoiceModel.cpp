#include "model-interface/cosyvoice/CosyvoiceModel.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <tts-cpp/cosyvoice/engine.h>
#include <tts-cpp/lavasr/denoiser.h>
#include <tts-cpp/lavasr/enhancer.h>

#include "addon/TTSErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/BackendUtils.hpp"
#include "model-interface/EnhancerLoader.hpp"
#include "model-interface/OutputResampler.hpp"
#include "model-interface/PcmConversion.hpp"
#include "model-interface/StreamingEnhancer.hpp"

namespace qvac::ttsggml::cosyvoice {

namespace {

using qvac_errors::createTTSError;
using qvac_errors::StatusError;
using qvac_errors::tts_error::TTSErrorCode;
namespace general_error = qvac_errors::general_error;
using qvac::ttsggml::pcmFloatToInt16;

tts_cpp::cosyvoice::EngineOptions toEngineOptions(const CosyvoiceConfig& cfg) {
  tts_cpp::cosyvoice::EngineOptions opts;
  opts.model_dir = cfg.modelDir;
  opts.llm_gguf_path = cfg.llmModelPath;
  opts.flow_gguf_path = cfg.flowModelPath;
  opts.hift_gguf_path = cfg.hiftModelPath;
  opts.s3tok_gguf_path = cfg.s3tokModelPath;
  opts.campplus_gguf_path = cfg.campplusModelPath;
  opts.reference_audio = cfg.referenceAudio;
  opts.prompt_text = cfg.promptText;
  opts.voice = cfg.voice;
  opts.instruct_text = cfg.instruct;
  if (!cfg.language.empty())
    opts.language = cfg.language;
  if (cfg.seed.has_value())
    opts.seed = *cfg.seed;
  if (cfg.threads.has_value())
    opts.n_threads = *cfg.threads;
  if (cfg.nGpuLayers.has_value()) {
    opts.n_gpu_layers = *cfg.nGpuLayers;
  } else if (cfg.useGpu.has_value()) {
    opts.n_gpu_layers = *cfg.useGpu ? kOffloadAllGpuLayers : 0;
  }
  // NOTE: output_sample_rate is documented as reserved/ignored by the tts-cpp
  // CosyVoice engine, so we do NOT forward it here — the addon resamples the
  // batch output itself (see synthesize()).
  if (cfg.cfmSteps.has_value())
    opts.cfm_steps = *cfg.cfmSteps;
  if (cfg.streamChunkTokens.has_value())
    opts.stream_chunk_tokens = *cfg.streamChunkTokens;
  if (cfg.streamFirstChunkTokens.has_value())
    opts.stream_first_chunk_tokens = *cfg.streamFirstChunkTokens;
  if (cfg.streamLeftContextTokens.has_value())
    opts.stream_left_context_tokens = *cfg.streamLeftContextTokens;

  // Compose `cfg.backendsDir / BACKENDS_SUBDIR` before forwarding, mirroring
  // SupertonicModel::toEngineOptions so a host that passes
  // path.join(__dirname, 'prebuilds') gets the expected per-arch scan dir.
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

} // namespace

// The tts-cpp engine ignores output_sample_rate, so the addon resamples the
// batch output itself; unenhanced streaming is validated to the native rate
// instead. Must run before stats so sampleRate_/duration reflect the emitted
// rate.
void resampleBatchOutput(
    const CosyvoiceConfig& cfg, tts_cpp::cosyvoice::SynthesisResult& result) {
  if (cfg.outputSampleRate.has_value() && *cfg.outputSampleRate > 0 &&
      *cfg.outputSampleRate != result.sample_rate) {
    result.pcm = OutputResampler::resample(
        result.pcm, result.sample_rate, *cfg.outputSampleRate);
    result.sample_rate = *cfg.outputSampleRate;
  }
}

namespace {

// Both rates stay zero when no enhancer is loaded.
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

// Mirrors ChatterboxModel::makeStreamingEnhancer; keep the two in sync.
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
            enhancer->enhance(raw, kCosyvoiceNativeSampleRate);
        if (finalRate != workRate) {
          enhanced = OutputResampler::resample(enhanced, workRate, finalRate);
        }
        return enhanced;
      },
      kCosyvoiceNativeSampleRate,
      finalRate);
}

std::shared_ptr<tts_cpp::lavasr::Denoiser>
loadDenoiser(const std::string& ggufPath, const std::string& errorContext) {
  if (ggufPath.empty())
    return nullptr;
  try {
    return tts_cpp::lavasr::Denoiser::load(ggufPath);
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::InitializationFailed, errorContext + e.what());
  }
}

// Rate-preserving. validateConfig rejects denoiser + streaming, so this only
// ever runs on the batch path.
void applyBatchDenoiser(
    tts_cpp::cosyvoice::SynthesisResult& result,
    tts_cpp::lavasr::Denoiser& denoiser) {
  try {
    result.pcm = denoiser.denoise(result.pcm, result.sample_rate);
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("cosyvoice.lavasr-denoiser: ") + e.what());
  }
}

void applyBatchEnhancer(
    tts_cpp::cosyvoice::SynthesisResult& result,
    tts_cpp::lavasr::Enhancer& enhancer) {
  try {
    result.pcm = enhancer.enhance(result.pcm, result.sample_rate);
    result.sample_rate = enhancer.output_sample_rate();
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("cosyvoice.lavasr: ") + e.what());
  }
}

// resampleBatchOutput is unconditional because it closes both the enhanced and
// the unenhanced case: applyBatchEnhancer leaves result.sample_rate at 48 kHz,
// which still has to be reconciled with any requested outputSampleRate.
void applyBatchPostProcessing(
    const CosyvoiceConfig& cfg, tts_cpp::cosyvoice::SynthesisResult& result,
    const std::shared_ptr<tts_cpp::lavasr::Denoiser>& denoiser,
    const std::shared_ptr<tts_cpp::lavasr::Enhancer>& enhancer) {
  if (denoiser)
    applyBatchDenoiser(result, *denoiser);
  if (enhancer)
    applyBatchEnhancer(result, *enhancer);
  resampleBatchOutput(cfg, result);
}

// The reference members borrow synthesize()'s locals, so an instance must not
// outlive the engine->synthesize() call it is handed to.
struct StreamChunkPostProcessor {
  const CosyvoiceModel::ChunkCallback& emit;
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
    std::vector<float> audio = enhanceStage(pcm, samples, isLast);
    emittedSamples += audio.size();
    emit(pcmFloatToInt16(audio), chunkIndex, isLast);
  }
};

void validateModelPaths(const CosyvoiceConfig& cfg) {
  if (cfg.modelDir.empty() && cfg.llmModelPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "cosyvoiceModelDir (or cosyvoiceLlmModelPath) is required");
  }
  if (!cfg.modelDir.empty() && !std::filesystem::is_directory(cfg.modelDir)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "cosyvoice model dir not found: " + cfg.modelDir);
  }
  if (!cfg.llmModelPath.empty() && !std::filesystem::exists(cfg.llmModelPath)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "cosyvoice llm model not found: " + cfg.llmModelPath);
  }
  if (!cfg.flowModelPath.empty() &&
      !std::filesystem::exists(cfg.flowModelPath)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "cosyvoice flow model not found: " + cfg.flowModelPath);
  }
  if (!cfg.hiftModelPath.empty() &&
      !std::filesystem::exists(cfg.hiftModelPath)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "cosyvoice hift model not found: " + cfg.hiftModelPath);
  }
  if (!cfg.s3tokModelPath.empty() &&
      !std::filesystem::exists(cfg.s3tokModelPath)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "cosyvoice s3tok model not found: " + cfg.s3tokModelPath);
  }
  if (!cfg.campplusModelPath.empty() &&
      !std::filesystem::exists(cfg.campplusModelPath)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "cosyvoice campplus model not found: " + cfg.campplusModelPath);
  }
  if (!cfg.referenceAudio.empty() &&
      !std::filesystem::exists(cfg.referenceAudio)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        "reference audio not found: " + cfg.referenceAudio);
  }
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
}

void validateSynthesisRanges(const CosyvoiceConfig& cfg) {
  if (cfg.cfmSteps.has_value() && *cfg.cfmSteps < 0) {
    throw StatusError(general_error::InvalidArgument, "cfmSteps must be >= 0");
  }
  if (cfg.outputSampleRate.has_value() && *cfg.outputSampleRate != 0 &&
      (*cfg.outputSampleRate < 8000 || *cfg.outputSampleRate > 192000)) {
    throw StatusError(
        general_error::InvalidArgument,
        "outputSampleRate must be 0 or in [8000, 192000]");
  }
}

void validateStreamTokens(const CosyvoiceConfig& cfg) {
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
  if (cfg.streamLeftContextTokens.has_value() &&
      *cfg.streamLeftContextTokens < 0) {
    throw StatusError(
        general_error::InvalidArgument, "streamLeftContextTokens must be >= 0");
  }
}

// AddonJs always installs a chunkCallback for CosyVoice, so streaming ==
// streamChunkTokens>0 at construction.
bool streamsNativeChunks(const CosyvoiceConfig& cfg) {
  return cfg.streamChunkTokens.value_or(0) > 0;
}

void validateStreamingCompatibility(const CosyvoiceConfig& cfg) {
  // CosyVoice emits its native 24 kHz per chunk while streaming; naive
  // addon-side per-chunk resampling would break the seams, so reject a
  // non-native output rate while streaming (batch output is resampled
  // instead). The LavaSR enhancer is the exception: StreamingEnhancer already
  // reprocesses an overlapping window and crossfades the seams, so it folds the
  // requested rate into that seam-free stage.
  if (streamsNativeChunks(cfg) && cfg.enhancerGgufPath.empty() &&
      cfg.outputSampleRate.has_value() && *cfg.outputSampleRate != 0 &&
      *cfg.outputSampleRate != kCosyvoiceNativeSampleRate) {
    throw StatusError(
        general_error::InvalidArgument,
        "CosyVoice native streaming emits at 24000 Hz; drop outputSampleRate, "
        "enable the LavaSR enhancer (which resamples seam-free), or disable "
        "streaming (streamChunkTokens) for resampled batch output.");
  }
  // tts-cpp only exposes a one-shot denoise(), so streaming would silently drop
  // denoising; a stateful streaming denoiser is the follow-up. index.js rejects
  // this first, so reaching here means the addon was driven directly.
  if (!cfg.denoiserGgufPath.empty() && streamsNativeChunks(cfg)) {
    throw StatusError(
        general_error::InvalidArgument,
        "CosyvoiceModel: the LavaSR denoiser is not yet supported with native "
        "chunk streaming (streamChunkTokens > 0). Use batch synthesis, or drop "
        "the denoiser for streaming (streaming denoise is a planned "
        "follow-up).");
  }
}

// useGPU / nGpuLayers conflict check — mirrors the sibling engines so the
// option surface behaves identically even though iteration 1 runs CPU-only.
void validateGpuIntent(const CosyvoiceConfig& cfg) {
  if (!cfg.useGpu.has_value() || !cfg.nGpuLayers.has_value())
    return;
  const bool wantsGpuFlag = *cfg.useGpu;
  const int layers = *cfg.nGpuLayers;
  if (wantsGpuFlag == (layers != 0))
    return;
  throw StatusError(
      general_error::InvalidArgument,
      std::string("CosyvoiceModel: useGPU=") +
          (wantsGpuFlag ? "true" : "false") +
          " conflicts with nGpuLayers=" + std::to_string(layers) +
          ". Either drop one of the two, or make them agree "
          "(useGPU:true + nGpuLayers!=0, or useGPU:false + nGpuLayers=0).");
}

} // namespace

CosyvoiceModel::CosyvoiceModel(CosyvoiceConfig config)
    : cfg_(std::move(config)) {
  validateConfig(cfg_);
  // load() is deferred to waitForLoadInitialization() so any heavy model
  // parse runs off the JS event loop via JsAsyncTask::run-driven activate().
}

CosyvoiceModel::~CosyvoiceModel() noexcept = default;

void CosyvoiceModel::validateConfig(const CosyvoiceConfig& cfg) {
  validateModelPaths(cfg);
  validateSynthesisRanges(cfg);
  validateStreamTokens(cfg);
  validateStreamingCompatibility(cfg);
  validateGpuIntent(cfg);
}

void CosyvoiceModel::setConfig(CosyvoiceConfig config) {
  validateConfig(config);
  cfg_ = std::move(config);
}

bool streamingRequested(const CosyvoiceConfig& cfg, bool hasChunkCallback) {
  return cfg.streamChunkTokens.value_or(0) > 0 && hasChunkCallback;
}

EmittedAudio resolveEmittedAudio(
    bool streaming, bool enhanced, int streamFinalRate,
    std::size_t streamedSamples, std::size_t batchSamples, int batchRate) {
  if (!streaming)
    return {batchSamples, batchRate};
  return {streamedSamples, enhanced ? streamFinalRate : batchRate};
}

void CosyvoiceModel::load() {
  std::lock_guard lk(engineMu_);
  loadLocked();
}

void CosyvoiceModel::unload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
}

void CosyvoiceModel::reload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
  loadLocked();
}

void CosyvoiceModel::loadLocked() {
  if (engine_)
    return;

  try {
    engine_ =
        std::make_shared<tts_cpp::cosyvoice::Engine>(toEngineOptions(cfg_));
  } catch (const std::exception& e) {
    engine_.reset();
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        std::string("CosyvoiceModel::load: ") + e.what());
  }

  backendName_ = engine_->backend_name();
  backendDevice_ = backendDeviceCode(engine_->backend_device());
  backendId_ = backendIdFromName(backendName_);
  gpuUnsupported_ = engine_->gpu_unsupported();

  // A half-loaded model must not look loaded: isLoaded() only reads engine_, so
  // leaving it set after a post-processing failure would make the next load()
  // a no-op and emit silently unenhanced audio.
  try {
    loadPostProcessingLocked();
  } catch (...) {
    unloadLocked();
    throw;
  }
}

void CosyvoiceModel::loadPostProcessingLocked() {
  // Pass the engine's *resolved* device, not the requested switch: if the
  // engine fell back to CPU, keep the enhancer on CPU too instead of forcing it
  // onto the GPU.
  LoadedEnhancer loaded = loadEnhancer(
      cfg_.enhancerGgufPath,
      backendDevice_ == kBackendDeviceGpu,
      "CosyvoiceModel::load: lavasr enhancer: ");
  enhancer_ = std::move(loaded.enhancer);
  enhancerBackendDevice_ = loaded.backendDevice;
  enhancerBackendId_ = loaded.backendId;

  denoiser_ = loadDenoiser(
      cfg_.denoiserGgufPath, "CosyvoiceModel::load: lavasr denoiser: ");
}

void CosyvoiceModel::unloadLocked() {
  engine_.reset();
  enhancer_.reset();
  denoiser_.reset();
  enhancerBackendDevice_ = -1;
  enhancerBackendId_ = -1;
}

void CosyvoiceModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
  std::shared_ptr<tts_cpp::cosyvoice::Engine> e;
  {
    std::lock_guard lk(engineMu_);
    e = engine_;
  }
  if (e)
    e->cancel();
}

CosyvoiceModel::SynthResult CosyvoiceModel::synthesize(
    const std::string& text, const ChunkCallback& onChunk) {
  // Keep the engine (and enhancer/denoiser) alive for the whole call even if
  // reload() swaps new ones in concurrently — the replacements take effect on
  // the NEXT synthesize.
  std::shared_ptr<tts_cpp::cosyvoice::Engine> engine;
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
        "CosyvoiceModel::synthesize: engine not loaded");
  }
  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed, "synthesis cancelled before it started");
  }

  textLength_ = text.size();

  const bool streaming = streamingRequested(cfg_, static_cast<bool>(onChunk));
  const EnhancerRates rates =
      resolveEnhancerRates(enhancer, cfg_.outputSampleRate);

  // The streaming callback runs synchronously on this thread, so this plain
  // counter safely tallies the emitted sample count for the stats below.
  std::size_t streamedSamples = 0;

  const auto t0 = std::chrono::steady_clock::now();
  tts_cpp::cosyvoice::SynthesisResult result;
  try {
    if (streaming) {
      result = engine->synthesize(
          text,
          StreamChunkPostProcessor{
              onChunk,
              makeStreamingEnhancer(enhancer, rates),
              streamedSamples});
    } else {
      result = engine->synthesize(text);
    }
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("cosyvoice.synthesize: ") + e.what());
  }

  if (!streaming) {
    applyBatchPostProcessing(cfg_, result, denoiser, enhancer);
  }
  const auto t1 = std::chrono::steady_clock::now();

  const EmittedAudio emitted = resolveEmittedAudio(
      streaming,
      static_cast<bool>(enhancer),
      rates.streamFinalRate,
      streamedSamples,
      result.pcm.size(),
      result.sample_rate);
  recordSynthesisStats(
      emitted.samples, emitted.sampleRate, result.duration_s, t0, t1);

  if (streaming) {
    return {Output{}, true}; // chunks already emitted via onChunk
  }
  return {pcmFloatToInt16(result.pcm.data(), result.pcm.size()), false};
}

void CosyvoiceModel::recordSynthesisStats(
    std::size_t outSamples, int emittedRate, float durationS,
    std::chrono::steady_clock::time_point t0,
    std::chrono::steady_clock::time_point t1) {
  sampleRate_ = emittedRate;
  totalSamples_ = static_cast<int64_t>(outSamples);
  audioDurationMs_ =
      durationS > 0.0f
          ? durationS * 1000.0
          : (sampleRate_ > 0 ? (static_cast<double>(totalSamples_) * 1000.0 /
                                static_cast<double>(sampleRate_))
                             : 0.0);
  totalTime_ = std::chrono::duration<double>(t1 - t0).count();
  realTimeFactor_ =
      audioDurationMs_ > 0.0 ? (totalTime_ * 1000.0) / audioDurationMs_ : 0.0;
  tokensPerSecond_ =
      totalTime_ > 0.0 ? static_cast<double>(textLength_) / totalTime_ : 0.0;
}

std::any CosyvoiceModel::process(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (!anyInput) {
    throw StatusError(
        general_error::InvalidArgument,
        "CosyvoiceModel::process: input must be AnyInput");
  }

  bool expected = false;
  if (!jobInProgress_.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel)) {
    throw StatusError(
        general_error::InternalError,
        "CosyvoiceModel::process: job already in progress");
  }
  struct InProgressGuard {
    std::atomic_bool& flag;
    ~InProgressGuard() { flag.store(false, std::memory_order_release); }
  } guard{jobInProgress_};

  cancelRequested_.store(false, std::memory_order_relaxed);
  SynthResult out = synthesize(anyInput->text, anyInput->chunkCallback);
  // Streaming already published its chunks via chunkCallback -> OutputQueue;
  // returning the concatenated PCM here would duplicate as a final outputArray
  // event (matches ParlerModel::process).
  if (out.wasStreaming) {
    return std::any{};
  }
  return std::any(std::move(out.pcm));
}

qvac_lib_inference_addon_cpp::RuntimeStats
CosyvoiceModel::runtimeStats() const {
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

} // namespace qvac::ttsggml::cosyvoice
