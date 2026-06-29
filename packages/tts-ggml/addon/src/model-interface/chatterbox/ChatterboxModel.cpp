#include "model-interface/chatterbox/ChatterboxModel.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

#include <tts-cpp/chatterbox/engine.h>

#include "addon/TTSErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/BackendUtils.hpp"
#include "model-interface/chatterbox/TimeStretch.hpp"

namespace qvac::ttsggml::chatterbox {

namespace {

using qvac_errors::createTTSError;
using qvac_errors::StatusError;
using qvac_errors::tts_error::TTSErrorCode;
namespace general_error = qvac_errors::general_error;

// Default T3 context cap (EngineOptions::n_ctx) when the host doesn't pass
// `nCtx`.  tts-cpp's library default (0 = uncapped) takes the GGUF's own
// n_ctx, and the Turbo GGUF ships n_ctx=8196 — the F32 KV cache allocated
// up-front at that length is n_embd(1024) x n_layer(24) x n_ctx x 4 B x 2
// (K+V) ~= 1.6 GB, which is what pushed the iOS QVAC SDK test process to a
// ~3.1 GB peak footprint and into jetsam (QVAC-19557).  With the f16
// default KV dtype below, 4096 tokens (~160 s of generated audio per
// synthesize() call; T3 speech tokens run at 25 Hz) cost ~390 MB of KV —
// still well under f32@4096 (~780 MB) AND double the context.  (The prior
// q8_0 default was ~210 MB but aborts the multilingual Metal CONT path —
// see DEFAULT_KV_CACHE_TYPE below — so it is now opt-in; passing
// kvCacheType:"q8_0" restores the smaller footprint on backends that
// implement the op.)  Hosts that need longer single-call synthesis can
// raise the cap, or pass nCtx=0 to restore the uncapped behaviour.
constexpr int DEFAULT_N_CTX = 4096;

// Default T3 KV-cache dtype (EngineOptions::kv_cache_type).  f16 stores
// the cache at ~50% of f32 and is the safe cross-backend default: the
// multilingual model's Metal step graph issues a CONT on the KV cache,
// and the ggml-speech Metal backend only supports a q8_0-source CONT to
// f32/f16 (not q8_0->q8_0), so a q8_0 KV cache hard-aborts that path with
// GGML_ABORT("unsupported op 'CONT'").  q8_0 had been the default since
// 0.3.2 (QVAC-19557, iOS peak-memory) — it stores the cache at ~27% of
// f32 and decodes 20-30% faster on Metal — but it only works where the
// backend implements the q8_0 CONT (CPU, CUDA), so it is now opt-in via
// kvCacheType:"q8_0".  Upstream validation on real GGUFs
// (qvac-ext-lib-whisper.cpp#43): Turbo greedy token sequences are
// byte-identical across f32/f16/q8_0 on CPU and Metal.  Pass
// kvCacheType:"f32" for bit-exact parity with the pre-quantisation
// behaviour.
constexpr const char* DEFAULT_KV_CACHE_TYPE = "f16";

tts_cpp::chatterbox::EngineOptions toEngineOptions(const ChatterboxConfig& cfg) {
  tts_cpp::chatterbox::EngineOptions opts;
  opts.t3_gguf_path    = cfg.t3ModelPath;
  opts.s3gen_gguf_path = cfg.s3genModelPath;
  opts.reference_audio = cfg.referenceAudio;
  opts.voice_dir       = cfg.voiceDir;
  if (!cfg.language.empty()) opts.language = cfg.language;
  if (cfg.seed.has_value())    opts.seed         = *cfg.seed;
  if (cfg.threads.has_value()) opts.n_threads    = *cfg.threads;
  opts.n_ctx = cfg.nCtx.value_or(DEFAULT_N_CTX);
  opts.kv_cache_type =
      cfg.kvCacheType.empty() ? DEFAULT_KV_CACHE_TYPE : cfg.kvCacheType;
  if (cfg.nGpuLayers.has_value()) {
    opts.n_gpu_layers = *cfg.nGpuLayers;
  } else if (cfg.useGpu.has_value()) {
    // Explicit useGpu must produce an explicit n_gpu_layers so we don't
    // depend on the tts-cpp library default flipping out from under us
    // (see also: gpu-smoke.test.js asserts backendDevice from this).
    opts.n_gpu_layers = *cfg.useGpu ? 99 : 0;
  }
  if (cfg.streamChunkTokens.has_value())      opts.stream_chunk_tokens       = *cfg.streamChunkTokens;
  if (cfg.streamFirstChunkTokens.has_value()) opts.stream_first_chunk_tokens = *cfg.streamFirstChunkTokens;
  if (cfg.streamCfmSteps.has_value())         opts.stream_cfm_steps          = *cfg.streamCfmSteps;

  // Compose the actual backends-scan directory from the host-provided
  // prebuilds root plus the cmake-bare per-target subdir
  // (BACKENDS_SUBDIR, e.g. `android-arm64/qvac__tts-ggml`). Mirrors
  // the exact shape qvac/packages/transcription-parakeet uses in
  // ParakeetModel.cpp + qvac/packages/llm-llamacpp uses in
  // LlamaLazyInitializeBackend.cpp so a host that already passes
  // `path.join(__dirname, 'prebuilds')` gets identical resolution
  // semantics across the three addons. Empty `backendsDir` -> leave
  // `opts.backends_dir` empty so tts-cpp falls back to ggml's
  // compile-time default search path (`ggml_backend_load_all()`
  // rather than `..._from_path()`).
  if (!cfg.backendsDir.empty()) {
    std::filesystem::path backendsDirPath(cfg.backendsDir);
#ifdef BACKENDS_SUBDIR
    backendsDirPath =
        (backendsDirPath / std::filesystem::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
    opts.backends_dir = backendsDirPath.string();
  }
  // Forwarded as-is. Empty -> leave $GGML_OPENCL_CACHE_DIR alone
  // (the env-set-by-host path still wins). Only consumed on Android
  // by `tts_cpp::detail::set_opencl_cache_dir()`; other platforms
  // ignore it. Process-singleton scoped: a second Engine ctor with
  // a different value is silently ignored on the tts-cpp side
  // because ggml-opencl only reads the env var once at first init.
  opts.opencl_cache_dir = cfg.openclCacheDir;

  // Multilingual text preprocessing dictionaries.  Only consumed by the
  // multilingual T3 variant inside tts-cpp (Turbo ignores them); leave
  // the EngineOptions fields empty when the host didn't resolve a path
  // so tts-cpp keeps its character-level fallback.
  if (!cfg.mecabDictPath.empty())  opts.mecab_dict_path  = cfg.mecabDictPath;
  if (!cfg.cangjieTsvPath.empty()) opts.cangjie_tsv_path = cfg.cangjieTsvPath;
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

std::vector<int16_t> pcmFloatToInt16(const std::vector<float>& pcm) {
  return pcmFloatToInt16(pcm.data(), pcm.size());
}

// A speed of 1.0 (or close enough that the WSOLA hop rounds to identity) is
// a no-op — skip the time-stretch entirely so the default path is untouched.
bool speedActive(float speed) {
  return std::isfinite(speed) && std::abs(speed - 1.0f) > 1e-3f;
}

constexpr float MIN_SPEED = 0.25f;
constexpr float MAX_SPEED = 4.0f;

} // namespace

ChatterboxModel::ChatterboxModel(ChatterboxConfig config)
    : cfg_(std::move(config)) {
  validateConfig(cfg_);
  // Constructor deliberately does NOT call load(): GGUF parsing is the
  // multi-hundred-MB step (ggml_backend_alloc_ctx_tensors + voice-
  // conditioning bake) and used to stall the Bare event loop because
  // qvac_lib_inference_addon_cpp::JsInterface::createInstance is
  // synchronous.  AddonCpp::activate() (driven by the JsAsyncTask::run
  // wrapper in addon_js::activate) now calls
  // waitForLoadInitialization() on a worker thread, which delegates to
  // load() lazily.  Direct C++ callers (and the unit-test suite in
  // addon/tests/) can still invoke load() explicitly when they want
  // synchronous semantics.
}

ChatterboxModel::~ChatterboxModel() noexcept = default;

void ChatterboxModel::validateConfig(const ChatterboxConfig& cfg) {
  if (cfg.useGpu.has_value() && cfg.nGpuLayers.has_value()) {
    const bool wantsGpu = *cfg.useGpu;
    const int  layers   = *cfg.nGpuLayers;
    // `layers != 0` (rather than `layers > 0`) so a llama.cpp-style
    // sentinel like nGpuLayers=-1 ("offload all layers") is treated as
    // "wants GPU" and doesn't falsely pass through against useGPU:true.
    const bool layersWantGpu = layers != 0;
    if (wantsGpu != layersWantGpu) {
      throw StatusError(
          general_error::InvalidArgument,
          std::string("ChatterboxModel: useGPU=") +
              (wantsGpu ? "true" : "false") +
              " conflicts with nGpuLayers=" + std::to_string(layers) +
              ". Either drop one of the two, or make them agree "
              "(useGPU:true + nGpuLayers!=0, or useGPU:false + nGpuLayers=0).");
    }
  }
  if (cfg.nCtx.has_value() && *cfg.nCtx < 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "ChatterboxModel: nCtx must be >= 0 (0 = use the GGUF's full "
        "context, > 0 = cap the T3 context / KV-cache length), got " +
            std::to_string(*cfg.nCtx));
  }
  // speed is a post-synthesis time-stretch factor (1.0 = unchanged, < 1
  // slower, > 1 faster).  Bound it to a sane TTS range so a fat-fingered
  // value can't request an absurd stretch (and reject <= 0 / NaN, which the
  // WSOLA hop math can't represent).
  if (cfg.speed.has_value()) {
    const float s = *cfg.speed;
    if (!std::isfinite(s) || s < MIN_SPEED || s > MAX_SPEED) {
      throw StatusError(
          general_error::InvalidArgument,
          "ChatterboxModel: speed must be in [0.25, 4.0] (1.0 = unchanged, "
          "< 1 slower, > 1 faster), got " +
              std::to_string(s));
    }
  }
  // Reject unknown KV dtypes at construction instead of inheriting
  // tts-cpp's warn-and-fall-back-to-f32, which would silently change
  // the memory profile the caller asked for.
  if (!cfg.kvCacheType.empty() && cfg.kvCacheType != "f32" &&
      cfg.kvCacheType != "f16" && cfg.kvCacheType != "q8_0") {
    throw StatusError(
        general_error::InvalidArgument,
        "ChatterboxModel: kvCacheType must be one of f32|f16|q8_0, got '" +
            cfg.kvCacheType + "'");
  }
  if (cfg.t3ModelPath.empty()) {
    throw StatusError(general_error::InvalidArgument, "t3ModelPath is required");
  }
  if (cfg.s3genModelPath.empty()) {
    throw StatusError(general_error::InvalidArgument, "s3genModelPath is required");
  }
  if (!std::filesystem::exists(cfg.t3ModelPath)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "t3 model not found: " + cfg.t3ModelPath);
  }
  if (!std::filesystem::exists(cfg.s3genModelPath)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "s3gen model not found: " + cfg.s3genModelPath);
  }
  if (!cfg.referenceAudio.empty() &&
      !std::filesystem::exists(cfg.referenceAudio)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "reference audio not found: " + cfg.referenceAudio);
  }
  if (!cfg.voiceDir.empty()) {
    if (!std::filesystem::exists(cfg.voiceDir)) {
      throw createTTSError(TTSErrorCode::ModelFileNotFound, "voice dir not found: " + cfg.voiceDir);
    }
    if (!std::filesystem::is_directory(cfg.voiceDir)) {
      throw StatusError(
          general_error::InvalidArgument,
          "voiceDir path exists but is not a directory: " + cfg.voiceDir);
    }
  }
  // No JS-side allow-list of language codes: the active GGUF variant
  // (turbo English vs multilingual) determines what's supported, and
  // tts_cpp::chatterbox::Engine throws a clear runtime error when the
  // requested language doesn't match the loaded variant.  Forcing a
  // hard-coded "en"-only check here would leak the turbo-variant
  // assumption into the addon and silently reject the multilingual
  // GGUFs (chatterbox-t3-mtl + chatterbox-s3gen-mtl) the converter
  // pipeline already produces.
}

void ChatterboxModel::load() {
  std::lock_guard lk(engineMu_);
  loadLocked();
}

void ChatterboxModel::unload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
}

void ChatterboxModel::reload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
  loadLocked();
}

void ChatterboxModel::loadLocked() {
  if (engine_) return;

  try {
    engine_ = std::make_shared<tts_cpp::chatterbox::Engine>(toEngineOptions(cfg_));
  } catch (const std::exception& e) {
    engine_.reset();
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        std::string("ChatterboxModel::load: ") + e.what());
  }

  backendName_   = engine_->backend_name();
  backendDevice_ = backendDeviceCode(engine_->backend_device());
  backendId_     = backendIdFromName(backendName_);

  // tts-cpp now admits Chatterbox onto ARM Mali/Immortalis Vulkan
  // (allow_arm_mali=true). gpuUnsupported_ stays as defensive observability: it
  // flags a "GPU present but unused" case if any engine falls back to CPU,
  // OR-ed (not replacing) the engine flag.
  const bool wantsGpu = cfg_.nGpuLayers.has_value()
                            ? (*cfg_.nGpuLayers != 0)
                            : cfg_.useGpu.value_or(false);
  gpuUnsupported_ =
      engine_->gpu_unsupported() ||
      (wantsGpu && backendDevice_ == 0 && androidOffAllowlistGpuPresent());
}

void ChatterboxModel::unloadLocked() {
  engine_.reset();
}

void ChatterboxModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
  // Grab a local copy of engine_ under the lock so we can invoke
  // cancel() safely even if another thread calls unload()/reload() in
  // parallel.  The Engine itself is responsible for making cancel()
  // thread-safe against its in-flight synthesize().
  std::shared_ptr<tts_cpp::chatterbox::Engine> e;
  {
    std::lock_guard lk(engineMu_);
    e = engine_;
  }
  if (e) e->cancel();
}

ChatterboxModel::SynthesizeResult ChatterboxModel::synthesize(
    const std::string& text, const ChunkCallback& chunkCallback) {
  // Capture the engine under the lock; keep it alive for the duration
  // of synthesize() via the local `engine` shared_ptr even if reload()
  // concurrently swaps a new one in.  Reload's new engine takes effect
  // on the NEXT synthesize call.
  std::shared_ptr<tts_cpp::chatterbox::Engine> engine;
  {
    std::lock_guard lk(engineMu_);
    engine = engine_;
  }
  if (!engine) {
    throw createTTSError(TTSErrorCode::ModelNotLoaded,
                         "ChatterboxModel::synthesize: engine not loaded");
  }
  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw createTTSError(TTSErrorCode::SynthesisFailed,
                         "synthesis cancelled before it started");
  }

  // Snapshot the streaming decision against the engine we're actually
  // about to call, BEFORE process() needs it.  Reading engine_ /
  // engine->options() outside the lock from process() would race with
  // reload() swapping a new engine in; pinning the decision here keeps
  // the read tied to the local `engine` shared_ptr for the call's
  // lifetime.
  const bool wasStreaming =
      static_cast<bool>(chunkCallback) &&
      engine->options().stream_chunk_tokens > 0;

  // Speaking-rate control.  Chatterbox's engine has no native rate knob, so
  // we post-process the 24 kHz PCM with a pitch-preserving WSOLA stretch
  // (see TimeStretch.hpp / ChatterboxConfig::speed).  In streaming mode a
  // single stretcher instance threads the overlap-add state across chunks so
  // the concatenated output has no per-chunk seams.
  // Unset -> 1.0 (no rate change), preserving the raw model output for
  // backward compatibility; callers opt in by passing an explicit speed.
  const float speed = cfg_.speed.value_or(1.0f);
  const bool stretch = speedActive(speed);

  const auto tStart = std::chrono::steady_clock::now();

  // Streaming publishes its (already-stretched) audio per chunk via
  // chunkCallback; sum the emitted samples here so the stats below use the
  // real output length without re-stretching result.pcm.  The callback runs
  // synchronously on this thread, so a plain counter is safe.
  std::size_t streamedSamples = 0;

  tts_cpp::chatterbox::SynthesisResult result;
  try {
    if (wasStreaming) {
      auto stretcher =
          stretch ? std::make_shared<WsolaTimeStretch>(speed) : nullptr;
      result = engine->synthesize(
          text,
          [&chunkCallback, stretcher, &streamedSamples](
              const float* pcm,
              std::size_t samples,
              int chunkIndex,
              bool isLast) {
            if (!stretcher) {
              streamedSamples += samples;
              chunkCallback(pcmFloatToInt16(pcm, samples), chunkIndex, isLast);
              return;
            }
            std::vector<float> out = stretcher->feed(pcm, samples);
            if (isLast) {
              std::vector<float> tail = stretcher->flush();
              out.insert(out.end(), tail.begin(), tail.end());
            }
            streamedSamples += out.size();
            chunkCallback(pcmFloatToInt16(out), chunkIndex, isLast);
          });
    } else {
      result = engine->synthesize(text);
    }
  } catch (const std::exception& e) {
    throw createTTSError(TTSErrorCode::SynthesisFailed,
                         std::string("engine.synthesize: ") + e.what());
  }

  // Batch: build the PCM we return (stretched in-place if a speed is active).
  // Streaming: the chunks were already published, so there is nothing to
  // return — take the sample count straight from what the callback emitted
  // rather than re-running a full-utterance WSOLA over result.pcm.
  std::vector<int16_t> pcm;
  std::size_t outSamples;
  if (wasStreaming) {
    outSamples = streamedSamples;
  } else {
    pcm = stretch ? pcmFloatToInt16(WsolaTimeStretch::apply(result.pcm, speed))
                  : pcmFloatToInt16(result.pcm);
    outSamples = pcm.size();
  }

  const auto tEnd = std::chrono::steady_clock::now();
  const double elapsedSec =
      std::chrono::duration<double>(tEnd - tStart).count();

  totalTime_ = elapsedSec;
  totalSamples_ = static_cast<int64_t>(outSamples);
  audioDurationMs_ = result.sample_rate > 0
                         ? (static_cast<double>(outSamples) * 1000.0 /
                            static_cast<double>(result.sample_rate))
                         : 0.0;
  realTimeFactor_ =
      audioDurationMs_ > 0 ? (elapsedSec * 1000.0) / audioDurationMs_ : 0.0;
  textLength_ = text.size();
  tokensPerSecond_ =
      elapsedSec > 0 ? static_cast<double>(textLength_) / elapsedSec : 0.0;

  return {std::move(pcm), wasStreaming};
}

std::any ChatterboxModel::process(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (anyInput == nullptr) {
    throw StatusError(
        general_error::InvalidArgument,
        "ChatterboxModel::process: expected AnyInput (text + chunkCallback)");
  }
  if (anyInput->text.empty()) {
    throw StatusError(
        general_error::InvalidArgument, "ChatterboxModel::process: empty text");
  }

  // Serialize concurrent process() calls.  The outer JobRunner already
  // queues jobs sequentially, but a direct C++ caller (or a future
  // pipeline that bypasses JobRunner) could still overlap — fail fast
  // with a clear error instead of data-racing on engine_ state.
  bool expected = false;
  if (!jobInProgress_.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel)) {
    throw StatusError(
        general_error::InvalidArgument,
        "ChatterboxModel::process: another synthesis job is already in progress");
  }
  struct InProgressGuard {
    std::atomic_bool& flag;
    ~InProgressGuard() { flag.store(false, std::memory_order_release); }
  } guard{jobInProgress_};

  cancelRequested_.store(false, std::memory_order_relaxed);
  auto result = synthesize(anyInput->text, anyInput->chunkCallback);
  // Streaming mode: chunks have already been published via chunkCallback
  // → OutputQueue.  Returning the concatenated PCM here would cause a
  // duplicate final `outputArray` event after all the chunks.  Return an
  // empty std::any so no output handler matches — JobRunner still emits
  // JobEnded with runtimeStats on its own.  We trust the wasStreaming
  // bit captured under the engine lock inside synthesize() rather than
  // re-reading engine_ here (which would race with a concurrent
  // reload()).
  if (result.wasStreaming) return {};
  return std::any(std::move(result.pcm));
}

tts_cpp::chatterbox::EngineOptions engineOptionsForTests(
    const ChatterboxConfig& cfg) {
  return toEngineOptions(cfg);
}

qvac_lib_inference_addon_cpp::RuntimeStats ChatterboxModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("tokensPerSecond", tokensPerSecond_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("totalSamples", totalSamples_);
  stats.emplace_back("backendDevice", static_cast<int64_t>(backendDevice_));
  stats.emplace_back("backendId",     static_cast<int64_t>(backendId_));
  stats.emplace_back("gpuUnsupported", static_cast<int64_t>(gpuUnsupported_));
  return stats;
}

} // namespace qvac::ttsggml::chatterbox
