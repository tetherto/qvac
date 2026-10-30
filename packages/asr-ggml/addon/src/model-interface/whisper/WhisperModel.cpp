#include "WhisperModel.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <mutex>
#include <ranges>
#include <system_error>
#include <thread>
#include <utility>

#include <ggml-backend.h>

#include "WhisperConfig.hpp"
#include "WhisperHandlers.hpp"
#include "addon/AsrErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "inference-addon-cpp/Logger.hpp"
#include "model-interface/BackendIdentity.hpp"
#include "model-interface/ModuleBackendsDir.hpp"
#include "model-interface/WhisperGpuSelection.hpp"
#include "model-interface/WhisperTypes.hpp"

namespace qvac::asrggml::whisper {

namespace {
constexpr double K_SAMPLES_PER_SECOND = 16000.0;
constexpr float K_SEGMENT_TIMESTAMP_SCALE = 0.01F;
constexpr int K_WARMUP_SAMPLE_COUNT = 8000;
constexpr std::size_t K_F32_SAMPLE_BYTES = 4;
constexpr std::size_t K_S16_SAMPLE_BYTES = 2;
constexpr unsigned int K_BYTE_SHIFT_8 = 8U;
constexpr unsigned int K_BYTE_SHIFT_16 = 16U;
constexpr unsigned int K_BYTE_SHIFT_24 = 24U;
constexpr float K_S16_NORMALIZATION_DIVISOR = 32768.0F;

// Legacy inter-segment yield on the inference thread, present since the initial
// monorepo import with no documented rationale. Preserved verbatim rather than
// removed to avoid an unverified runtime behavior change.
constexpr std::chrono::milliseconds K_SEGMENT_EMIT_YIELD{1};
} // namespace

static bool shouldAbortWhisper(void* userData) {
  const auto* cancelRequested = static_cast<const std::atomic_bool*>(userData);
  return cancelRequested != nullptr &&
         cancelRequested->load(std::memory_order_relaxed);
}

WhisperModel::WhisperModel(WhisperConfig config) : cfg_(std::move(config)) {}

WhisperModel::~WhisperModel() noexcept {
  try {
    unload();
  } catch (...) {
    is_loaded_ = false;
  }
}

bool WhisperModel::isCaptionModeEnabled() const {
  const auto miscConfigIt = cfg_.miscConfig.find("caption_enabled");
  if (miscConfigIt == cfg_.miscConfig.end()) {
    // Default to false if not specified
    return false;
  }
  return std::get<bool>(miscConfigIt->second);
}

namespace {
bool readBoolFlag(
    const std::map<std::string, JSValueVariant>& cfg, const char* key) {
  const auto it = cfg.find(key);
  if (it == cfg.end()) {
    return false;
  }
  const bool* value = std::get_if<bool>(&it->second);
  return value != nullptr && *value;
}

// Text tokens of one segment with their timing and probability. Ids at or
// above EOT are special (EOT, SOT, language, task, timestamp) and skipped.
std::vector<TokenData>
collectSegmentTokens(whisper_context* ctx, whisper_state* state, int segment) {
  std::vector<TokenData> tokens;
  const whisper_token eot = whisper_token_eot(ctx);
  const int nTokens = whisper_full_n_tokens_from_state(state, segment);
  tokens.reserve(static_cast<size_t>(std::max(0, nTokens)));
  for (int j = 0; j < nTokens; ++j) {
    const whisper_token_data data =
        whisper_full_get_token_data_from_state(state, segment, j);
    if (data.id >= eot) {
      continue;
    }
    TokenData token;
    const char* text =
        whisper_full_get_token_text_from_state(ctx, state, segment, j);
    token.text = text != nullptr ? text : "";
    token.start = static_cast<float>(data.t0) * K_SEGMENT_TIMESTAMP_SCALE;
    token.end = static_cast<float>(data.t1) * K_SEGMENT_TIMESTAMP_SCALE;
    token.probability = data.p;
    tokens.push_back(std::move(token));
  }
  return tokens;
}
} // namespace

bool WhisperModel::isTokenTimestampsEnabled() const {
  return readBoolFlag(cfg_.whisperMainCfg, "token_timestamps");
}

bool WhisperModel::isTdrzEnabled() const {
  return readBoolFlag(cfg_.whisperMainCfg, "tdrz_enable");
}

auto WhisperModel::formatCaptionOutput(Transcript& transcript) -> void {
  transcript.text = "<|" + std::to_string(static_cast<int>(transcript.start)) +
                    "|>" + transcript.text + "<|" +
                    std::to_string(static_cast<int>(transcript.end)) + "|>";
}

#if defined(__ANDROID__) || defined(__linux__) || defined(_WIN32)
// Android, desktop linux-arm64, and CUDA-enabled linux-x64 / win32-x64
// builds ship ggml with `GGML_BACKEND_DL=ON`, so no backend is statically
// registered. Load the per-arch CPU + GPU modules once per process before
// whisper_init; otherwise it aborts on a NULL CPU device. On static builds
// the scan finds no modules and the statically registered backends stay in
// charge, so calling this unconditionally is safe. A configured backendsDir
// is scanned as given; otherwise the addon's own backends directory.
void ensureBackendsLoaded(const std::string& backendsDir) {
  static std::once_flag flag;
  std::call_once(flag, [&]() {
    const std::filesystem::path dir = resolveBackendsDir(backendsDir);
    if (dir.empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "the addon could not locate itself; falling back to "
          "ggml_backend_load_all() (default search path), which misses the "
          "renamed qvac-speech-ggml-* modules.");
      ggml_backend_load_all();
      return;
    }
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        std::string("loading ggml backends from: ") + dir.string());
#if defined(__ANDROID__) && defined(QVAC_ASR_HEXAGON)
    const char* previous = std::getenv("DSP_LIBRARY_PATH");
    if (!previous)
      previous = std::getenv("ADSP_LIBRARY_PATH");
    const auto dspPath =
        main_gpu::dspLibraryPath(dir.string(), previous ? previous : "");
    if (!dspPath.empty() &&
        ::setenv("DSP_LIBRARY_PATH", dspPath.c_str(), 1) != 0)
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "Whisper: failed to set DSP_LIBRARY_PATH before backend discovery");
#endif
    ggml_backend_load_all_from_path(dir.string().c_str());
  });
}
#endif // __ANDROID__ || __linux__ || _WIN32

namespace {
std::string toLowerCopy(std::string value) {
  std::transform(
      value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
      });
  return value;
}

// Walk the ggml device registry in registration order and invoke `visit` with
// each GPU/IGPU device and its position in the *filtered* GPU/IGPU list. Both
// GPU and IGPU are included because ggml-vulkan reports integrated GPUs (Mali,
// Adreno-via-Vulkan, Intel iGPU) as IGPU; skipping them would hide real GPU
// execution. `visit` returns true to stop the walk early.
void forEachGpuDevice(
    const std::function<bool(int, ggml_backend_dev_t)>& visit) {
  const size_t devCount = ggml_backend_dev_count();
  int filteredIdx = 0;
  for (size_t i = 0; i < devCount; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    if (dev == nullptr) {
      continue;
    }
    const enum ggml_backend_dev_type devType = ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    if (visit(filteredIdx, dev)) {
      return;
    }
    ++filteredIdx;
  }
}

// Return the GPU/IGPU device at `index` in the filtered list, matching the
// indexing whisper_backend_init_gpu() applies to `gpu_device`, or nullptr.
ggml_backend_dev_t nthGpuDevice(int index) {
  ggml_backend_dev_t match = nullptr;
  forEachGpuDevice([&](int filteredIdx, ggml_backend_dev_t dev) {
    if (filteredIdx != index) {
      return false;
    }
    match = dev;
    return true;
  });
  return match;
}

// A device is the Adreno OpenCL GPU when its backend is OpenCL AND its
// description names an Adreno GPU. Gating on the Adreno *description* (not
// merely "some OpenCL device exists") keeps Mali on Vulkan even if a
// Mali/Intel OpenCL ICD ever enumerates, and leaves desktop (Metal / discrete
// Vulkan) untouched. Mirrors llm-llamacpp's BackendSelection gate (see
// packages/llm-llamacpp/addon/src/utils/BackendSelection.cpp).
bool isAdrenoOpenclDevice(ggml_backend_dev_t dev) {
  ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
  const char* regName = (reg != nullptr) ? ggml_backend_reg_name(reg) : "";
  const char* devDesc = ggml_backend_dev_description(dev);
  const std::string regNameLower =
      toLowerCopy(regName != nullptr ? regName : "");
  const std::string devDescLower =
      toLowerCopy(devDesc != nullptr ? devDesc : "");
  const bool isOpenCl = regNameLower.find("opencl") != std::string::npos;
  const bool isAdreno = devDescLower.find("adreno") != std::string::npos;
  return isOpenCl && isAdreno;
}

// Return the filtered GPU/IGPU index of a registered Adreno OpenCL device, or
// -1 if none.
//
// This is the Adreno guard. On Adreno (Android) ggml registers BOTH a Vulkan
// device and an OpenCL device for the same physical GPU, and
// ggml_backend_load_all_from_path() loads Vulkan *before* OpenCL
// (ggml-backend-reg.cpp), so whisper_backend_init_gpu()'s default
// (gpu_device=0) lands on the Vulkan device — whose Adreno driver SIGSEGVs in
// vkCmdBindPipeline during ggml compute. Steering to the Adreno OpenCL device
// avoids that.
int adrenoOpenclGpuDeviceIndex() {
  int adrenoIndex = -1;
  forEachGpuDevice([&](int filteredIdx, ggml_backend_dev_t dev) {
    if (!isAdrenoOpenclDevice(dev)) {
      return false;
    }
    adrenoIndex = filteredIdx;
    return true;
  });
  return adrenoIndex;
}
} // namespace

void WhisperModel::load() {
  if (!ctx_) {

#if defined(__ANDROID__) || defined(__linux__) || defined(_WIN32)
    ensureBackendsLoaded(cfg_.backendsDir);
#endif

    whisper_context_params contextParams = toWhisperContextParams(cfg_);
    bool reportMissingGpuFallback = false;

    // Resolve the raw registry identity before translating to Whisper's
    // GPU/IGPU ordinal. An excluded explicit target falls back only to CPU.
    if (contextParams.use_gpu &&
        !cfg_.whisperContextCfg.contains("gpu_device")) {
      const auto selected = main_gpu::resolveWhisperLoadSelection(
          contextParams.use_gpu,
          contextParams.gpu_device,
          false,
          cfg_.whisperContextCfg);
      if (selected.outOfRange) {
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
            "main-gpu registry index is out of range; using normal GPU "
            "selection");
      }
      contextParams.use_gpu = selected.useGpu;
      if (contextParams.use_gpu) {
        contextParams.gpu_device = selected.gpuDevice;
      } else if (!selected.refused.empty()) {
        std::string message =
            "GPU execution requested but no eligible device is available; "
            "falling back to CPU. Refused GPU-type devices:";
        for (const auto& identity : selected.refused) {
          message += " [" + identity + "]";
        }
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
            message.c_str());
      } else {
        reportMissingGpuFallback = selected.warnMissingGpuFallback;
      }
    }

    // Adreno guard: when ggml registers an Adreno OpenCL device (Android,
    // where it also registers a Vulkan device for the same GPU and Vulkan is
    // loaded first), steer whisper to the OpenCL device. The Adreno Vulkan
    // driver SIGSEGVs in ggml compute (vkCmdBindPipeline), whereas OpenCL is
    // the supported Adreno backend. No-op on Mali / desktop (no Adreno OpenCL
    // device registers there), so the proven Mali->Vulkan path is untouched.
    if (contextParams.use_gpu &&
        cfg_.whisperContextCfg.contains("gpu_device")) {
      const int adrenoOpenclDeviceIndex = adrenoOpenclGpuDeviceIndex();
      if (adrenoOpenclDeviceIndex >= 0 &&
          adrenoOpenclDeviceIndex != contextParams.gpu_device) {
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::INFO,
            std::string(
                "Adreno OpenCL GPU device detected; preferring it over "
                "the default GPU to avoid the Adreno Vulkan compute "
                "crash (gpu_device ") +
                std::to_string(contextParams.gpu_device) + " -> " +
                std::to_string(adrenoOpenclDeviceIndex) + ")");
        contextParams.gpu_device = adrenoOpenclDeviceIndex;
      }
    }

    const auto modelPathIt = cfg_.whisperContextCfg.find("model");
    if (modelPathIt == cfg_.whisperContextCfg.end()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Model path not specified in whisperContextCfg");
      throw std::runtime_error("Model path not specified in whisperContextCfg");
    }
    const auto modelPath = std::get<std::string>(modelPathIt->second);

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "Loading Whisper model from: " + modelPath);
    ctx_.reset(
        whisper_init_from_file_with_params(modelPath.c_str(), contextParams));

    if (ctx_ == nullptr) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Failed to initialize Whisper context");
      throw std::runtime_error("Failed to initialize Whisper context");
    }

    is_loaded_ = true;
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "Whisper model loaded successfully");

    captureActiveBackendInfo(
        contextParams.use_gpu || reportMissingGpuFallback,
        contextParams.gpu_device);

    // Warm up the model on first load to avoid first-segment delay
    if (!is_warmed_up_) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "Warming up Whisper model");
      warmup();
      is_warmed_up_ = true;
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "Whisper model warmup completed");
    }
  }
}

void WhisperModel::unload() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Unloading Whisper model");
  resetContext();
  is_loaded_ = false;
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Whisper model unloaded successfully");
}

void WhisperModel::reload() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Reloading Whisper model");
  unload();
  load();
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Whisper model reloaded successfully");
}

void WhisperModel::reset() {
  output_.clear();
  stream_ended_ = false;
  totalSamples_ = 0;
  totalTokens_ = 0;
  totalSegments_ = 0;
  processCalls_ = 0;
  totalWallMs_ = 0.0;
  whisperSampleMs_ = 0.0;
  whisperEncodeMs_ = 0.0;
  whisperDecodeMs_ = 0.0;
  whisperBatchdMs_ = 0.0;
  whisperPromptMs_ = 0.0;
}

void WhisperModel::endOfStream() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "End of stream signal received");
  stream_ended_ = true;
}

void WhisperModel::captureActiveBackendInfo(
    bool useGpu, int /*gpuDeviceIndex*/) {
  const char* primary = whisper_get_primary_backend_name(ctx_.get());
  auto dev = primary ? ggml_backend_dev_by_name(primary) : nullptr;
  const auto reg = dev ? ggml_backend_dev_backend_reg(dev) : nullptr;
  const char* registryName = reg ? ggml_backend_reg_name(reg) : nullptr;
  backend_name_ = registryName ? registryName : (primary ? primary : "CPU");
  backend_id_ = backendFamily(backend_name_);
  if (backend_id_ == 0)
    backend_name_ = "CPU";
  backend_device_ = backendDeviceClass(dev, static_cast<int>(backend_id_));
  const char* description = dev ? ggml_backend_dev_description(dev) : nullptr;
  gpu_device_description_ =
      description ? description : (primary ? primary : "");
  gpu_mem_total_mb_ = -1;
  gpu_mem_free_mb_ = -1;
  if (dev && backend_device_ == 1) {
    size_t freeBytes = 0;
    size_t totalBytes = 0;
    ggml_backend_dev_memory(dev, &freeBytes, &totalBytes);
    constexpr size_t bytesPerMb = 1024U * 1024U;
    gpu_mem_total_mb_ =
        totalBytes ? static_cast<int64_t>(totalBytes / bytesPerMb) : -1;
    gpu_mem_free_mb_ =
        totalBytes ? static_cast<int64_t>(freeBytes / bytesPerMb) : -1;
  }
  if (useGpu && backend_device_ == 0) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "Whisper: acceleration was requested but the initialized backend is "
        "CPU");
  }
}

bool WhisperModel::getEncoderOnCoreml() const {
  return whisper_encoder_on_coreml(ctx_.get());
}

qvac_lib_inference_addon_cpp::RuntimeStats WhisperModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;

  // Keep keys stable because integration tooling reads these.
  // Times are in seconds (totalTime) or milliseconds (audioDurationMs).
  const double audioDurationSec =
      totalSamples_ > 0
          ? static_cast<double>(totalSamples_) / K_SAMPLES_PER_SECOND
          : 0.0;
  const auto audioDurationMs = static_cast<int64_t>(audioDurationSec * 1000.0);
  const double totalTimeSec = totalWallMs_ / 1000.0;
  const double rtf =
      audioDurationSec > 0.0 ? (totalTimeSec / audioDurationSec) : 0.0;
  const double tps = totalTimeSec > 0.0
                         ? (static_cast<double>(totalTokens_) / totalTimeSec)
                         : 0.0;

  stats.emplace_back("totalTime", totalTimeSec);
  stats.emplace_back("realTimeFactor", rtf);
  stats.emplace_back("tokensPerSecond", tps);
  stats.emplace_back("audioDurationMs", audioDurationMs);
  stats.emplace_back("totalSamples", totalSamples_);

  // Additional useful counters
  stats.emplace_back("totalTokens", totalTokens_);
  stats.emplace_back("totalSegments", totalSegments_);
  stats.emplace_back("processCalls", processCalls_);

  // Whisper internal timings (ms) accumulated across process() calls
  stats.emplace_back("whisperSampleMs", whisperSampleMs_);
  stats.emplace_back("whisperEncodeMs", whisperEncodeMs_);
  stats.emplace_back("whisperDecodeMs", whisperDecodeMs_);
  stats.emplace_back("whisperBatchdMs", whisperBatchdMs_);
  stats.emplace_back("whisperPromptMs", whisperPromptMs_);
  stats.emplace_back("totalWallMs", totalWallMs_);

  // Active backend identity + device memory, captured once at load() by
  // captureActiveBackendInfo(). Field shape mirrors transcription-
  // parakeet's RuntimeStats:
  //   backendDevice : 0 = CPU, 1 = GPU (post-fallback truth)
  //   backendId     : 0 = CPU, 1 = Metal, 2 = CUDA, 3 = Vulkan,
  //                   4 = OpenCL, 99 = other (same enum as parakeet)
  // A `use_gpu: true` request that fell back to CPU at load() time
  // surfaces here as backendDevice=0 / backendId=0 (and the load()
  // path will have emitted a WARNING explaining why).
  stats.emplace_back("backendDevice", backend_device_);
  stats.emplace_back("backendId", backend_id_);
  // Device-memory snapshot at load() (whisper-specific extras; parakeet
  // does not expose these). -1 means the device does not report.
  stats.emplace_back("gpuMemTotalMb", gpu_mem_total_mb_);
  stats.emplace_back("gpuMemFreeMb", gpu_mem_free_mb_);
  return stats;
}

static void onNewSegment(
    whisper_context* ctx, whisper_state* state, int nNew, void* userData) {

  auto* whisper = static_cast<WhisperModel*>(userData);
  if (whisper == nullptr || state == nullptr) {
    return;
  }

  const int nSegments = whisper_full_n_segments_from_state(state);
  if (nNew <= 0 || nSegments <= 0) {
    return;
  }
  const int startIndex = std::max(0, nSegments - nNew);
  const int langId = whisper_full_lang_id_from_state(state);
  const char* language = langId >= 0 ? whisper_lang_str(langId) : nullptr;
  const bool withTokens = whisper->isTokenTimestampsEnabled();
  const bool withSpeakerTurns = whisper->isTdrzEnabled();

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "New segments detected: " + std::to_string(nNew) + " segments");

  for (int i = startIndex; i < nSegments; i++) {
    Transcript transcript;
    const char* text = whisper_full_get_segment_text_from_state(state, i);
    transcript.text = text != nullptr ? text : "";
    transcript.start =
        static_cast<float>(whisper_full_get_segment_t0_from_state(state, i)) *
        K_SEGMENT_TIMESTAMP_SCALE;
    transcript.end =
        static_cast<float>(whisper_full_get_segment_t1_from_state(state, i)) *
        K_SEGMENT_TIMESTAMP_SCALE;
    transcript.id = i;
    transcript.language = language != nullptr ? language : "";
    transcript.noSpeechProb =
        whisper_full_get_segment_no_speech_prob_from_state(state, i);
    if (withSpeakerTurns) {
      transcript.speakerTurnNext =
          whisper_full_get_segment_speaker_turn_next_from_state(state, i);
    }
    if (withTokens) {
      transcript.tokens = collectSegmentTokens(ctx, state, i);
    }

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "Segment " + std::to_string(i) + ": [" +
            std::to_string(transcript.start) + "s - " +
            std::to_string(transcript.end) + "s] " + transcript.text);

    if (whisper->isCaptionModeEnabled()) {
      WhisperModel::formatCaptionOutput(transcript);
    }

    whisper->emitSegment(transcript);
    std::this_thread::sleep_for(K_SEGMENT_EMIT_YIELD);
    whisper->addTranscription(transcript);

    // Stats: count tokens/segments as they are emitted
    const int nTokens = whisper_full_n_tokens_from_state(state, i);
    whisper->recordSegmentStats(nTokens);
  }
}

void WhisperModel::warmup() {
  if (!ctx_) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "Cannot warmup - context not initialized");
    return;
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Starting model warmup");
  // Generate 0.5s of silent audio at 16kHz.
  std::vector<float> silentAudio(K_WARMUP_SAMPLE_COUNT, 0.0F);

  // Get minimal params for warmup (no callbacks needed)
  whisper_full_params params = toWhisperFullParams(cfg_);

  // Disable callbacks for warmup to avoid triggering output events
  params.new_segment_callback = nullptr;
  params.new_segment_callback_user_data = nullptr;

  // Run warmup inference to "heat up" the model
  whisper_full(
      ctx_.get(),
      params,
      silentAudio.data(),
      static_cast<int>(silentAudio.size()));
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Model warmup completed");
}

void WhisperModel::process(const Input& input) {

  if (ctx_ == nullptr) {
    load();
  }
  if (ctx_ == nullptr) {
    throw std::runtime_error("Whisper context is not initialized");
  }

  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw std::runtime_error("Job cancelled");
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Processing audio input with " + std::to_string(input.size()) +
          " samples");

  processCalls_ += 1;
  totalSamples_ += static_cast<int64_t>(input.size());

  // Reset internal timings/state before processing to avoid memory issues
  if (ctx_ != nullptr) {
    whisper_reset_timings(ctx_.get());
  }

  const auto startTime = std::chrono::steady_clock::now();

  whisper_full_params params{};
  try {
    params = toWhisperFullParams(cfg_);
  } catch (const std::exception& e) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "Error in full handler: " + std::string(e.what()));
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string("error in full handler: ") + std::string(e.what()));
  }

  params.new_segment_callback = onNewSegment;
  params.new_segment_callback_user_data = this;
  params.abort_callback = shouldAbortWhisper;
  params.abort_callback_user_data = &cancelRequested_;

  int result = whisper_full(
      ctx_.get(), params, input.data(), static_cast<int>(input.size()));

  const auto endTime = std::chrono::steady_clock::now();
  totalWallMs_ +=
      std::chrono::duration<double, std::milli>(endTime - startTime).count();

  // Accumulate whisper internal timings for this call (they were reset at
  // start).
  if (ctx_ != nullptr) {
    if (auto* whisperTimings = whisper_get_timings(ctx_.get());
        whisperTimings != nullptr) {
      whisperSampleMs_ += whisperTimings->sample_ms;
      whisperEncodeMs_ += whisperTimings->encode_ms;
      whisperDecodeMs_ += whisperTimings->decode_ms;
      whisperBatchdMs_ += whisperTimings->batchd_ms;
      whisperPromptMs_ += whisperTimings->prompt_ms;
    }
  }

  if (result != 0) {
    if (cancelRequested_.load(std::memory_order_relaxed)) {
      throw std::runtime_error("Job cancelled");
    }
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "whisper_full_with_state failed with code: " + std::to_string(result));
    throw std::runtime_error(
        "Failed to process audio (whisper_full_with_state returned " +
        std::to_string(result) + ")");
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Audio processing completed");
}

std::any WhisperModel::process(const std::any& input) {
  AnyInput modelInput;
  if (const auto* anyInput = std::any_cast<AnyInput>(&input)) {
    modelInput = *anyInput;
  } else if (const auto* inputVector = std::any_cast<Input>(&input)) {
    modelInput.input = *inputVector;
  } else {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string("Invalid input type for WhisperModel::process: ") +
            input.type().name());
  }

  const auto previousOutputCallback = on_segment_;
  const bool shouldOverrideCallback =
      static_cast<bool>(modelInput.outputCallback);
  if (shouldOverrideCallback) {
    on_segment_ = modelInput.outputCallback;
  }

  reset();
  cancelRequested_.store(false, std::memory_order_relaxed);
  try {
    process(modelInput.input);
  } catch (...) {
    if (shouldOverrideCallback) {
      on_segment_ = previousOutputCallback;
    }
    throw;
  }

  if (shouldOverrideCallback) {
    on_segment_ = previousOutputCallback;
    return Output{};
  }

  return output_;
}

// Overload with callback for ModelInterface compatibility
WhisperModel::Output WhisperModel::process(
    const Input& input, const std::function<void(const Output&)>& callback) {
  // For testing/compatibility, return empty results
  // Real implementation delegates to WhisperModel's streaming process
  if (!is_loaded_ || input.empty()) {
    return Output{};
  }

  // Call original WhisperModel process (void return)
  process(input);

  // Return empty for now - WhisperModel uses callback-based output
  Output result{};
  if (callback) {
    callback(result);
  }
  return result;
}

void WhisperModel::saveLoadParams(const WhisperConfig& config) {
  // Call setConfig to ensure proper config handling
  setConfig(config);
}

void WhisperModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
}

bool WhisperModel::configContextIsChanged(
    const WhisperConfig& oldCfg, const WhisperConfig& newCfg) {
  // Context parameters that require reload: model, use_gpu, flash_attn,
  // gpu_device, main-gpu, main_gpu
  const std::vector<std::string> contextKeys = {
      "model", "use_gpu", "flash_attn", "gpu_device", "main-gpu", "main_gpu"};

  return std::ranges::any_of(contextKeys, [&](const std::string& key) {
    const auto oldIt = oldCfg.whisperContextCfg.find(key);
    const auto newIt = newCfg.whisperContextCfg.find(key);

    if (oldIt != oldCfg.whisperContextCfg.end() &&
        newIt != newCfg.whisperContextCfg.end()) {
      return oldIt->second != newIt->second;
    }

    // If one exists and the other doesn't, context changed.
    return (oldIt != oldCfg.whisperContextCfg.end()) !=
           (newIt != newCfg.whisperContextCfg.end());
  });
}

void WhisperModel::resetContext() { ctx_.reset(); }

void WhisperModel::setConfig(const WhisperConfig& config) {
  bool contextChanged = configContextIsChanged(cfg_, config);
  cfg_ = config;

  if (contextChanged) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "Context parameters changed, triggering model reload");
    reload();
  } else {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "Configuration updated without context changes");
  }
}

namespace {
std::vector<float> decodeF32le(const std::vector<uint8_t>& audioData) {
  if ((audioData.size() % K_F32_SAMPLE_BYTES) != 0) {
    throw errors::whisper::makeStatus(
        errors::whisper::Code::MisalignedBuffer,
        "f32le buffer length must be a multiple of 4");
  }
  std::vector<float> samples;
  samples.reserve(audioData.size() / K_F32_SAMPLE_BYTES);
  for (std::size_t i = 0; i < audioData.size(); i += K_F32_SAMPLE_BYTES) {
    const auto bits =
        static_cast<uint32_t>(audioData.at(i)) |
        (static_cast<uint32_t>(audioData.at(i + 1)) << K_BYTE_SHIFT_8) |
        (static_cast<uint32_t>(audioData.at(i + 2)) << K_BYTE_SHIFT_16) |
        (static_cast<uint32_t>(audioData.at(i + 3)) << K_BYTE_SHIFT_24);
    float sample = 0.0F;
    std::memcpy(&sample, &bits, sizeof(sample));
    if (!std::isfinite(sample)) {
      throw errors::whisper::makeStatus(
          errors::whisper::Code::NonFiniteSample,
          "Encountered non-finite f32 sample");
    }
    samples.push_back(sample);
  }
  return samples;
}

std::vector<float> decodeS16le(const std::vector<uint8_t>& audioData) {
  if ((audioData.size() % K_S16_SAMPLE_BYTES) != 0) {
    throw errors::whisper::makeStatus(
        errors::whisper::Code::MisalignedBuffer,
        "s16le buffer length must be a multiple of 2");
  }
  std::vector<float> samples;
  samples.reserve(audioData.size() / K_S16_SAMPLE_BYTES);
  for (std::size_t i = 0; i < audioData.size(); i += K_S16_SAMPLE_BYTES) {
    const auto lowByte = static_cast<uint16_t>(audioData.at(i));
    const auto highByte = static_cast<uint16_t>(audioData.at(i + 1));
    const auto bits = static_cast<uint16_t>(
        lowByte | static_cast<uint16_t>(highByte << K_BYTE_SHIFT_8));
    const auto sample = static_cast<int16_t>(bits);
    samples.push_back(static_cast<float>(sample) / K_S16_NORMALIZATION_DIVISOR);
  }
  return samples;
}
} // namespace

std::vector<float> WhisperModel::preprocessAudioData(
    const std::vector<uint8_t>& audioData, const std::string& audioFormat) {
  if (audioData.empty()) {
    return {};
  }
  if (audioFormat == "f32le" || audioFormat == "decoded") {
    return decodeF32le(audioData);
  }
  if (audioFormat == "s16le") {
    return decodeS16le(audioData);
  }
  throw errors::whisper::makeStatus(
      errors::whisper::Code::UnsupportedAudioFormat,
      std::string("Unsupported audio_format: ") + audioFormat);
}

} // namespace qvac::asrggml::whisper
