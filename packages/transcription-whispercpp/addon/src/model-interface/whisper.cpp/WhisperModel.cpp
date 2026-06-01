#include "WhisperModel.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <mutex>
#include <ranges>
#include <thread>
#include <utility>

#include <ggml-backend.h>

#include "WhisperConfig.hpp"
#include "WhisperHandlers.hpp"
#include "addon/WhisperErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "inference-addon-cpp/Logger.hpp"
#include "model-interface/WhisperTypes.hpp"

namespace qvac_lib_inference_addon_whisper {

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

auto WhisperModel::formatCaptionOutput(Transcript& transcript) -> void {
  transcript.text = "<|" + std::to_string(static_cast<int>(transcript.start)) +
                    "|>" + transcript.text + "<|" +
                    std::to_string(static_cast<int>(transcript.end)) + "|>";
}

#if defined(__ANDROID__)
namespace {
// Android ships ggml with `GGML_BACKEND_DL=ON`, so no backend is
// statically registered. dlopen the per-arch CPU + GPU `.so` modules
// once per process; otherwise whisper_init aborts on a NULL CPU device.
// Mirrors packages/{diffusion-cpp,llm-llamacpp,classification-ggml,…}.
void ensureBackendsLoadedAndroid(const std::string& backendsDir) {
  static std::once_flag flag;
  std::call_once(flag, [&]() {
    if (backendsDir.empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "Android: configurationParams.backendsDir not set; falling back to "
          "ggml_backend_load_all() (default search path). CPU/Vulkan/OpenCL "
          "registration may fail inside an APK.");
      ggml_backend_load_all();
      return;
    }
#ifdef BACKENDS_SUBDIR
    const std::filesystem::path variantsDir =
        (std::filesystem::path(backendsDir) /
         std::filesystem::path(BACKENDS_SUBDIR))
            .lexically_normal();
#else
    const std::filesystem::path variantsDir = backendsDir;
#endif
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        std::string("Android: loading ggml backends from: ") +
            variantsDir.string());
    ggml_backend_load_all_from_path(variantsDir.string().c_str());
  });
}
} // namespace
#endif // __ANDROID__

void WhisperModel::load() {
  if (!ctx_) {

#if defined(__ANDROID__)
    ensureBackendsLoadedAndroid(cfg_.backendsDir);
#endif

    whisper_context_params contextParams = toWhisperContextParams(cfg_);

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

    captureActiveBackendInfo();

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

namespace {
// Stable numeric mapping from a ggml backend registry name to the
// integer code surfaced on JS as `RuntimeStats.backendId`. Kept in
// lock-step with transcription-parakeet's `BackendId` enum (see
// transcription-parakeet/index.d.ts and ParakeetModel.cpp's
// `backendIdFromName`) so the same integer means the same backend
// family across both speech addons.
//
// Match by prefix (or by lowercased substring for legacy reg names)
// because ggml_backend_reg_name() can return indexed strings like
// "CUDA0" / "Vulkan0" / "MTL0" when multiple GPUs of the same family
// are present.
int64_t backendIdFromRegName(const std::string& nameLower) {
  if (nameLower.find("metal") != std::string::npos ||
      nameLower.find("mtl") != std::string::npos) {
    return 1;
  }
  if (nameLower.find("cuda") != std::string::npos) {
    return 2;
  }
  if (nameLower.find("vulkan") != std::string::npos) {
    return 3;
  }
  if (nameLower.find("opencl") != std::string::npos) {
    return 4;
  }
  return 99;
}

// Read whisper_context_params.use_gpu / .gpu_device out of the
// WhisperConfig variant map so captureActiveBackendInfo() can mirror
// whisper.cpp's own backend-pick logic. The defaults match
// WhisperConfig::defaults() (use_gpu=false, gpu_device=-1 i.e. "first
// GPU device").
bool configUseGpu(const WhisperConfig& cfg) {
  const auto it = cfg.whisperContextCfg.find("use_gpu");
  if (it == cfg.whisperContextCfg.end()) {
    return false;
  }
  if (const auto* asBool = std::get_if<bool>(&it->second)) {
    return *asBool;
  }
  return false;
}

int configGpuDeviceIndex(const WhisperConfig& cfg) {
  const auto it = cfg.whisperContextCfg.find("gpu_device");
  if (it == cfg.whisperContextCfg.end()) {
    return -1;
  }
  if (const auto* asDouble = std::get_if<double>(&it->second)) {
    return static_cast<int>(*asDouble);
  }
  if (const auto* asInt = std::get_if<int>(&it->second)) {
    return *asInt;
  }
  return -1;
}
} // namespace

void WhisperModel::captureActiveBackendInfo() {
  // Reset to "CPU" so we report a sensible default on every load.
  backend_device_ = 0;
  backend_id_ = 0;
  backend_name_ = "CPU";
  gpu_mem_total_mb_ = -1;
  gpu_mem_free_mb_ = -1;
  gpu_device_description_.clear();

  const bool useGpu = configUseGpu(cfg_);
  const int gpuDeviceIndex = configGpuDeviceIndex(cfg_);

  // Whisper.cpp v1.8.x picks a GPU only when contextParams.use_gpu is
  // true. Reflect that intent here so a CPU-only load doesn't look
  // like a silent fallback in the WARNING below.
  if (!useGpu) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "Active backend: CPU (use_gpu=false)");
    return;
  }

  // Mirror whisper.cpp's `whisper_backend_init_gpu()` selection in
  // src/whisper.cpp: pick the device at `gpu_device` index when set,
  // otherwise the first `GGML_BACKEND_DEVICE_TYPE_GPU` in ggml's
  // enumeration order. Whisper does NOT consider IGPU / ACCEL, so we
  // mustn't either — reporting an IGPU here would lie about what
  // whisper actually initialized against and confuse the device-farm
  // assertions on Android (Mali vs Adreno).
  ggml_backend_dev_t dev = nullptr;
  if (gpuDeviceIndex >= 0) {
    dev = ggml_backend_dev_get(static_cast<size_t>(gpuDeviceIndex));
    if (dev != nullptr &&
        ggml_backend_dev_type(dev) != GGML_BACKEND_DEVICE_TYPE_GPU) {
      dev = nullptr;
    }
  } else {
    const size_t devCount = ggml_backend_dev_count();
    for (size_t i = 0; i < devCount; ++i) {
      ggml_backend_dev_t candidate = ggml_backend_dev_get(i);
      if (candidate != nullptr &&
          ggml_backend_dev_type(candidate) == GGML_BACKEND_DEVICE_TYPE_GPU) {
        dev = candidate;
        break;
      }
    }
  }

  if (dev == nullptr) {
    // Parity with parakeet's CPU-fallback WARNING (see
    // ParakeetModel.cpp's `loadModel()`). On iOS/desktop mobile-perf
    // paths the integration test only checks that backendId is
    // present, so a silent CPU fallback here would not stand out in
    // CI logs without this line.
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "Whisper: use_gpu=true was requested but no GGML GPU device is "
        "registered (use_gpu fell back to CPU). Likely causes: the GPU "
        "backend library wasn't loaded (Android: ggml_backend_load_all_"
        "from_path failed for the backendsDir), the device was rejected "
        "by the backend (Adreno-tier policy, missing OpenCL ICD, "
        "iOS/Android simulator without GPU support), or no GPU backend "
        "was compiled into ggml-speech for this triplet.");
    return;
  }

  ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
  const char* regName = (reg != nullptr) ? ggml_backend_reg_name(reg) : "";
  const char* devName = ggml_backend_dev_name(dev);
  const char* devDesc = ggml_backend_dev_description(dev);

  std::string regNameLower = (regName != nullptr) ? regName : "";
  std::transform(
      regNameLower.begin(),
      regNameLower.end(),
      regNameLower.begin(),
      [](unsigned char c) { return std::tolower(c); });

  backend_device_ = 1;
  backend_id_ = backendIdFromRegName(regNameLower);
  backend_name_ = (regName != nullptr) ? regName : "";
  gpu_device_description_ =
      (devDesc != nullptr) ? devDesc : (devName != nullptr ? devName : "");

  size_t freeBytes = 0;
  size_t totalBytes = 0;
  ggml_backend_dev_memory(dev, &freeBytes, &totalBytes);
  constexpr size_t kBytesPerMb = 1024U * 1024U;
  gpu_mem_total_mb_ =
      totalBytes > 0 ? static_cast<int64_t>(totalBytes / kBytesPerMb) : -1;
  gpu_mem_free_mb_ =
      freeBytes > 0 ? static_cast<int64_t>(freeBytes / kBytesPerMb) : -1;

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      std::string("Active backend: id=") + std::to_string(backend_id_) +
          " device=" + std::to_string(backend_device_) + " name='" +
          backend_name_ + "' gpu_device='" + gpu_device_description_ +
          "' mem_total_mb=" + std::to_string(gpu_mem_total_mb_) +
          " mem_free_mb=" + std::to_string(gpu_mem_free_mb_));
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
    [[maybe_unused]] whisper_context* ctx, whisper_state* state, int nNew,
    void* userData) {

  auto* whisper = static_cast<WhisperModel*>(userData);
  if (whisper == nullptr || state == nullptr) {
    return;
  }

  const int nSegments = whisper_full_n_segments_from_state(state);
  if (nNew <= 0 || nSegments <= 0) {
    return;
  }
  const int startIndex = std::max(0, nSegments - nNew);

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

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "Segment " + std::to_string(i) + ": [" +
            std::to_string(transcript.start) + "s - " +
            std::to_string(transcript.end) + "s] " + transcript.text);

    if (whisper->isCaptionModeEnabled()) {
      WhisperModel::formatCaptionOutput(transcript);
    }

    whisper->emitSegment(transcript);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
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
  // gpu_device
  const std::vector<std::string> contextKeys = {
      "model", "use_gpu", "flash_attn", "gpu_device"};

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

std::vector<float> WhisperModel::preprocessAudioData(
    const std::vector<uint8_t>& audioData, const std::string& audioFormat) {
  std::vector<float> samples;
  if (audioData.empty()) {
    return samples;
  }

  if (audioFormat == "f32le" || audioFormat == "decoded") {
    if ((audioData.size() % K_F32_SAMPLE_BYTES) != 0) {
      throw qvac_errors::whisper_error::makeStatus(
          qvac_errors::whisper_error::Code::MisalignedBuffer,
          "f32le buffer length must be a multiple of 4");
    }
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
        throw qvac_errors::whisper_error::makeStatus(
            qvac_errors::whisper_error::Code::NonFiniteSample,
            "Encountered non-finite f32 sample");
      }
      samples.push_back(sample);
    }
  } else if (audioFormat == "s16le") {
    if ((audioData.size() % K_S16_SAMPLE_BYTES) != 0) {
      throw qvac_errors::whisper_error::makeStatus(
          qvac_errors::whisper_error::Code::MisalignedBuffer,
          "s16le buffer length must be a multiple of 2");
    }
    samples.reserve(audioData.size() / K_S16_SAMPLE_BYTES);

    for (std::size_t i = 0; i < audioData.size(); i += K_S16_SAMPLE_BYTES) {
      const auto lowByte = static_cast<uint16_t>(audioData.at(i));
      const auto highByte = static_cast<uint16_t>(audioData.at(i + 1));
      const auto bits = static_cast<uint16_t>(
          lowByte | static_cast<uint16_t>(highByte << K_BYTE_SHIFT_8));
      const auto sample = static_cast<int16_t>(bits);
      samples.push_back(
          static_cast<float>(sample) / K_S16_NORMALIZATION_DIVISOR);
    }
  } else {
    throw qvac_errors::whisper_error::makeStatus(
        qvac_errors::whisper_error::Code::UnsupportedAudioFormat,
        std::string("Unsupported audio_format: ") + audioFormat);
  }

  return samples;
}

} // namespace qvac_lib_inference_addon_whisper
