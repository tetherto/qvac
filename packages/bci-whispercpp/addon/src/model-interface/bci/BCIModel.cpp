#include "BCIModel.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <ranges>
#include <string>
#include <utility>

#include <ggml-backend.h>

#include "BCIConfig.hpp"
#include "addon/BCIErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "inference-addon-cpp/Logger.hpp"
#include "model-interface/BCITypes.hpp"

namespace qvac_lib_inference_addon_bci {

namespace {
constexpr float K_SEGMENT_TIMESTAMP_SCALE = 0.01F;
constexpr int K_WARMUP_SAMPLE_COUNT = 8000;
constexpr int K_DEFAULT_DAY_IDX = 0;
constexpr char K_DAY_IDX_CONFIG_KEY[] = "day_idx";

// backendDevice / backendId codes surfaced on JS `RuntimeStats`. Shared with
// the sibling speech addons so a given integer names the same backend family
// everywhere.
constexpr int64_t K_BACKEND_DEVICE_CPU = 0;
constexpr int64_t K_BACKEND_DEVICE_GPU = 1;
constexpr int64_t K_BACKEND_ID_CPU = 0;
constexpr int64_t K_BACKEND_ID_METAL = 1;
constexpr int64_t K_BACKEND_ID_CUDA = 2;
constexpr int64_t K_BACKEND_ID_VULKAN = 3;
constexpr int64_t K_BACKEND_ID_OPENCL = 4;
constexpr int64_t K_BACKEND_ID_OTHER = 99;

constexpr size_t K_BYTES_PER_MB = 1024U * 1024U;
constexpr int64_t K_MEM_UNKNOWN_MB = -1;
} // namespace

static bool shouldAbortWhisper(void* userData) {
  const auto* cancelRequested = static_cast<const std::atomic_bool*>(userData);
  return cancelRequested != nullptr &&
         cancelRequested->load(std::memory_order_relaxed);
}

#if defined(__ANDROID__) || (defined(__linux__) && defined(__aarch64__))
namespace {
// Android and desktop linux-arm64 prebuilds ship ggml with
// `GGML_BACKEND_DL=ON`, so no backend is statically registered. dlopen the
// per-arch CPU + GPU `.so` modules once per process; otherwise whisper_init
// aborts on a NULL CPU device.
void ensureBackendsLoaded(const std::string& backendsDir) {
  static std::once_flag flag;
  std::call_once(flag, [&]() {
    if (backendsDir.empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "configurationParams.backendsDir not set; falling back to "
          "ggml_backend_load_all() (default search path). CPU / Vulkan / "
          "OpenCL registration may fail inside an APK with default "
          "compressed-native-libs packaging.");
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
        std::string("loading ggml backends from: ") +
            variantsDir.string());
    ggml_backend_load_all_from_path(variantsDir.string().c_str());
  });
}
} // namespace
#endif // __ANDROID__ || linux-arm64

BCIModel::BCIModel(BCIConfig config)
    : cfg_(std::move(config)), neuralProcessor_() {}

BCIModel::~BCIModel() noexcept {
  try {
    unload();
  } catch (...) {
    is_loaded_ = false;
  }
}

void BCIModel::loadEmbedderIfNeeded() {
  if (neuralProcessor_.hasWeights()) {
    return;
  }

  // Prefer an explicit embedder path supplied from JS
  // (`configurationParams.embedderPath`). When absent, fall back to
  // resolving `bci-embedder.bin` next to the GGML model file.
  std::string embedderPath = cfg_.embedderPath;
  if (embedderPath.empty()) {
    auto modelPathIt = cfg_.whisperContextCfg.find("model");
    if (modelPathIt == cfg_.whisperContextCfg.end()) {
      return;
    }
    const auto modelPath = std::get<std::string>(modelPathIt->second);

    auto lastSep = modelPath.find_last_of("/\\");
    auto dir =
        (lastSep != std::string::npos) ? modelPath.substr(0, lastSep) : ".";
    embedderPath = dir + "/bci-embedder.bin";
  }

  if (neuralProcessor_.loadEmbedderWeights(embedderPath)) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
         "Loaded BCI embedder weights from: " + embedderPath);
  } else {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::EmbedderWeightsNotFound,
        "BCI embedder weights not found at: " + embedderPath +
        ". This file is required for neural signal preprocessing. "
        "Generate it with: python3 scripts/convert-model.py --checkpoint <ckpt>");
  }
}

namespace {
constexpr int K_NO_GPU_DEVICE = -1;

std::string toLowerCopy(std::string value) {
  std::transform(
      value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return std::tolower(c);
      });
  return value;
}

bool isGpuLikeDevice(ggml_backend_dev_t dev) {
  const enum ggml_backend_dev_type devType = ggml_backend_dev_type(dev);
  return devType == GGML_BACKEND_DEVICE_TYPE_GPU ||
         devType == GGML_BACKEND_DEVICE_TYPE_IGPU;
}

std::string deviceRegNameLower(ggml_backend_dev_t dev) {
  ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
  const char* regName = (reg != nullptr) ? ggml_backend_reg_name(reg) : "";
  return toLowerCopy(regName != nullptr ? regName : "");
}

std::string deviceDescriptionLower(ggml_backend_dev_t dev) {
  const char* devDesc = ggml_backend_dev_description(dev);
  return toLowerCopy(devDesc != nullptr ? devDesc : "");
}

bool isAdrenoOpenclDevice(ggml_backend_dev_t dev) {
  const bool isOpenCl =
      deviceRegNameLower(dev).find("opencl") != std::string::npos;
  const bool isAdreno =
      deviceDescriptionLower(dev).find("adreno") != std::string::npos;
  return isOpenCl && isAdreno;
}

// On Adreno (Android) ggml registers both a Vulkan and an OpenCL device for
// the same GPU and loads Vulkan first, so whisper's default GPU pick lands on
// the Vulkan device -- whose Adreno driver SIGSEGVs during ggml compute.
// Return the index (within whisper's filtered GPU/IGPU list) of the Adreno
// OpenCL device so the caller can steer to it, or K_NO_GPU_DEVICE when none
// applies -- leaving Mali on Vulkan and desktop backends untouched.
int adrenoOpenclGpuDeviceIndex() {
  const size_t devCount = ggml_backend_dev_count();
  int filteredIdx = 0;
  for (size_t i = 0; i < devCount; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    if (dev == nullptr || !isGpuLikeDevice(dev)) {
      continue;
    }
    if (isAdrenoOpenclDevice(dev)) {
      return filteredIdx;
    }
    ++filteredIdx;
  }
  return K_NO_GPU_DEVICE;
}
} // namespace

void BCIModel::load() {
  if (ctx_) return;

#if defined(__ANDROID__) || (defined(__linux__) && defined(__aarch64__))
  ensureBackendsLoaded(cfg_.backendsDir);
#endif

  whisper_context_params contextParams = toWhisperContextParams(cfg_);

  // Steer to the Adreno OpenCL device when present (see
  // adrenoOpenclGpuDeviceIndex) to avoid the Adreno Vulkan compute crash.
  if (contextParams.use_gpu) {
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
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Model path not specified in contextParams");
  }
  const auto modelPath = std::get<std::string>(modelPathIt->second);

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Loading BCI model from: " + modelPath);

  auto* rawCtx = whisper_init_from_file_with_params(modelPath.c_str(), contextParams);
  if (rawCtx == nullptr) {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::FailedToLoadModel,
        "Failed to initialize Whisper context from: " + modelPath);
  }

  try {
    ctx_.reset(rawCtx);
    captureActiveBackendInfo(contextParams.use_gpu, contextParams.gpu_device);
    loadEmbedderIfNeeded();
    if (!is_warmed_up_) {
      warmup();
      is_warmed_up_ = true;
    }
    is_loaded_ = true;
  } catch (...) {
    ctx_.reset();
    is_loaded_ = false;
    throw;
  }
}

void BCIModel::unload() {
  resetContext();
  is_loaded_ = false;
  is_warmed_up_ = false;
}

void BCIModel::reload() {
  unload();
  load();
}

void BCIModel::reset() {
  output_.clear();
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

namespace {
// Match by lowercased substring because `ggml_backend_reg_name()` can return
// indexed strings like "CUDA0" / "Vulkan0" / "MTL0" when several GPUs of the
// same family are present.
int64_t backendIdFromRegName(const std::string& nameLower) {
  if (nameLower.find("metal") != std::string::npos ||
      nameLower.find("mtl") != std::string::npos) {
    return K_BACKEND_ID_METAL;
  }
  if (nameLower.find("cuda") != std::string::npos) {
    return K_BACKEND_ID_CUDA;
  }
  if (nameLower.find("vulkan") != std::string::npos) {
    return K_BACKEND_ID_VULKAN;
  }
  if (nameLower.find("opencl") != std::string::npos) {
    return K_BACKEND_ID_OPENCL;
  }
  return K_BACKEND_ID_OTHER;
}

struct GpuBackendInfo {
  int64_t backendId = K_BACKEND_ID_OTHER;
  std::string backendName;
  std::string deviceDescription;
  int64_t memTotalMb = K_MEM_UNKNOWN_MB;
  int64_t memFreeMb = K_MEM_UNKNOWN_MB;
};

int64_t bytesToMb(size_t bytes) {
  return bytes > 0 ? static_cast<int64_t>(bytes / K_BYTES_PER_MB)
                   : K_MEM_UNKNOWN_MB;
}

// Mirror whisper_backend_init_gpu(): gpu_device indexes only GPU|IGPU devices
// in registry order. IGPU must be included because ggml-vulkan reports
// integrated GPUs (Mali, Adreno-via-Vulkan, Intel) as IGPU while
// ggml-opencl / ggml-metal / ggml-cuda report GPU; skipping IGPU would make
// every Vulkan-on-mobile device look like a silent CPU fallback. Returns
// nullptr when no such device is registered.
ggml_backend_dev_t findNthGpuDevice(int targetGpuIndex) {
  int gpuSeen = 0;
  const size_t devCount = ggml_backend_dev_count();
  for (size_t i = 0; i < devCount; ++i) {
    ggml_backend_dev_t candidate = ggml_backend_dev_get(i);
    if (candidate == nullptr || !isGpuLikeDevice(candidate)) {
      continue;
    }
    if (gpuSeen == targetGpuIndex) {
      return candidate;
    }
    ++gpuSeen;
  }
  return nullptr;
}

GpuBackendInfo readGpuBackendInfo(ggml_backend_dev_t dev) {
  ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
  const char* regName = (reg != nullptr) ? ggml_backend_reg_name(reg) : "";
  const char* devName = ggml_backend_dev_name(dev);
  const char* devDesc = ggml_backend_dev_description(dev);
  const std::string regNameStr = (regName != nullptr) ? regName : "";

  GpuBackendInfo info;
  info.backendId = backendIdFromRegName(toLowerCopy(regNameStr));
  info.backendName = regNameStr;
  info.deviceDescription =
      (devDesc != nullptr) ? devDesc : (devName != nullptr ? devName : "");

  size_t freeBytes = 0;
  size_t totalBytes = 0;
  ggml_backend_dev_memory(dev, &freeBytes, &totalBytes);
  info.memTotalMb = bytesToMb(totalBytes);
  info.memFreeMb = bytesToMb(freeBytes);
  return info;
}

void logSilentCpuFallbackWarning() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
      "BCI: use_gpu=true was requested but no GGML GPU/IGPU device is "
      "registered (silent CPU fallback). Likely causes: the GPU backend "
      "library wasn't loaded (Android: ggml_backend_load_all_from_path "
      "failed for the backendsDir), the device was rejected by the "
      "backend (Adreno pre-700 OpenCL policy, missing OpenCL ICD, Vulkan "
      "driver without storageBuffer16BitAccess, iOS/Android simulator "
      "without GPU support), or no GPU backend was compiled into "
      "ggml-speech for this triplet.");
}

void logActiveGpuBackend(const GpuBackendInfo& info) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      std::string("Active backend: id=") + std::to_string(info.backendId) +
          " device=" + std::to_string(K_BACKEND_DEVICE_GPU) + " name='" +
          info.backendName + "' gpu_device='" + info.deviceDescription +
          "' mem_total_mb=" + std::to_string(info.memTotalMb) +
          " mem_free_mb=" + std::to_string(info.memFreeMb));
}
} // namespace

void BCIModel::resetBackendInfoToCpu() {
  backend_device_ = K_BACKEND_DEVICE_CPU;
  backend_id_ = K_BACKEND_ID_CPU;
  backend_name_ = "CPU";
  gpu_mem_total_mb_ = K_MEM_UNKNOWN_MB;
  gpu_mem_free_mb_ = K_MEM_UNKNOWN_MB;
  gpu_device_description_.clear();
}

// `useGpu` / `gpuDeviceIndex` are the exact whisper_context_params the context
// was created with (including the Adreno->OpenCL preference), so the reported
// backend matches whisper's actual selection.
void BCIModel::captureActiveBackendInfo(bool useGpu, int gpuDeviceIndex) {
  resetBackendInfoToCpu();

  if (!useGpu) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "Active backend: CPU (use_gpu=false)");
    return;
  }

  const int targetGpuIndex = gpuDeviceIndex >= 0 ? gpuDeviceIndex : 0;
  ggml_backend_dev_t dev = findNthGpuDevice(targetGpuIndex);
  if (dev == nullptr) {
    logSilentCpuFallbackWarning();
    return;
  }

  const GpuBackendInfo info = readGpuBackendInfo(dev);
  backend_device_ = K_BACKEND_DEVICE_GPU;
  backend_id_ = info.backendId;
  backend_name_ = info.backendName;
  gpu_device_description_ = info.deviceDescription;
  gpu_mem_total_mb_ = info.memTotalMb;
  gpu_mem_free_mb_ = info.memFreeMb;
  logActiveGpuBackend(info);
}

qvac_lib_inference_addon_cpp::RuntimeStats BCIModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;

  const double totalTimeSec = totalWallMs_ / 1000.0;
  const double tps = totalTimeSec > 0.0
                         ? (static_cast<double>(totalTokens_) / totalTimeSec)
                         : 0.0;

  stats.emplace_back("totalTime", totalTimeSec);
  stats.emplace_back("tokensPerSecond", tps);
  stats.emplace_back("totalTokens", totalTokens_);
  stats.emplace_back("totalSegments", totalSegments_);
  stats.emplace_back("processCalls", processCalls_);
  stats.emplace_back("totalWallMs", totalWallMs_);
  stats.emplace_back("whisperSampleMs", whisperSampleMs_);
  stats.emplace_back("whisperEncodeMs", whisperEncodeMs_);
  stats.emplace_back("whisperDecodeMs", whisperDecodeMs_);
  stats.emplace_back("whisperBatchdMs", whisperBatchdMs_);
  stats.emplace_back("whisperPromptMs", whisperPromptMs_);

  // Active backend identity + device memory, captured once at load() by
  // captureActiveBackendInfo(). A use_gpu=true request that fell back to CPU
  // surfaces as the CPU codes (load() logs a WARNING explaining why).
  stats.emplace_back("backendDevice", backend_device_);
  stats.emplace_back("backendId", backend_id_);
  stats.emplace_back("gpuMemTotalMb", gpu_mem_total_mb_);
  stats.emplace_back("gpuMemFreeMb", gpu_mem_free_mb_);

  return stats;
}

static void onNewSegment(
    [[maybe_unused]] whisper_context* ctx, whisper_state* state, int nNew,
    void* userData) {
  auto* bci = static_cast<BCIModel*>(userData);
  if (bci == nullptr || state == nullptr) return;

  const int nSegments = whisper_full_n_segments_from_state(state);
  if (nNew <= 0 || nSegments <= 0) return;
  const int startIndex = std::max(0, nSegments - nNew);

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

    bci->emitSegment(transcript);
    bci->addTranscription(transcript);

    const int nTokens = whisper_full_n_tokens_from_state(state, i);
    bci->recordSegmentStats(nTokens);
  }
}

void BCIModel::warmup() {
  if (!ctx_) return;

  std::vector<float> silentAudio(K_WARMUP_SAMPLE_COUNT, 0.0F);
  whisper_full_params params = toWhisperFullParams(cfg_);
  params.new_segment_callback = nullptr;
  params.new_segment_callback_user_data = nullptr;

  whisper_full(ctx_.get(), params,
               silentAudio.data(),
               static_cast<int>(silentAudio.size()));
}

int BCIModel::injectNeuralMelAndRunWhisper(
    const std::vector<float>& melFeatures, int melFrames, int melBins,
    whisper_full_params& params) {
  const int melStatus =
      whisper_set_mel(ctx_.get(), melFeatures.data(), melFrames, melBins);
  if (melStatus != 0) {
    const std::string melError =
        "whisper_set_mel rejected neural mel features (status " +
        std::to_string(melStatus) + ")";
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR, melError);
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::InvalidNeuralSignal,
        "Failed to inject neural mel features into whisper state");
  }
  return whisper_full(ctx_.get(), params, nullptr, 0);
}

void BCIModel::ensureContextInitialized() const {
  if (ctx_ == nullptr) {
    throw std::runtime_error(
        "BCI Whisper context is not initialized — call load() first");
  }
}

void BCIModel::throwIfCancelled() const {
  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw std::runtime_error("Job cancelled");
  }
}

// Default day 0 matches NeuralProcessor::processToMel; callers that omit
// bciConfig get day 0.
int BCIModel::resolveDayIdx() const {
  auto it = cfg_.bciConfig.find(K_DAY_IDX_CONFIG_KEY);
  if (it == cfg_.bciConfig.end()) {
    return K_DEFAULT_DAY_IDX;
  }
  if (auto* d = std::get_if<double>(&it->second)) {
    return static_cast<int>(*d);
  }
  if (auto* i = std::get_if<int>(&it->second)) {
    return *i;
  }
  return K_DEFAULT_DAY_IDX;
}

void BCIModel::warnIfDayIdxOutOfRange(int dayIdx) const {
  if (!neuralProcessor_.hasWeights()) {
    return;
  }
  const int maxDay = static_cast<int>(neuralProcessor_.getNumDays()) - 1;
  if (maxDay >= 0 && (dayIdx < 0 || dayIdx > maxDay)) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "day_idx " + std::to_string(dayIdx) + " is outside [0, " +
            std::to_string(maxDay) + "]; it will be clamped");
  }
}

void BCIModel::accumulateWhisperTimings() {
  auto* whisperTimings = whisper_get_timings(ctx_.get());
  if (whisperTimings == nullptr) {
    return;
  }
  whisperSampleMs_ += whisperTimings->sample_ms;
  whisperEncodeMs_ += whisperTimings->encode_ms;
  whisperDecodeMs_ += whisperTimings->decode_ms;
  whisperBatchdMs_ += whisperTimings->batchd_ms;
  whisperPromptMs_ += whisperTimings->prompt_ms;
}

int BCIModel::runWhisperTimed(
    const std::vector<float>& melFeatures, int melFrames, int melBins,
    whisper_full_params& params) {
  whisper_reset_timings(ctx_.get());
  const auto startTime = std::chrono::steady_clock::now();
  const int result =
      injectNeuralMelAndRunWhisper(melFeatures, melFrames, melBins, params);
  const auto endTime = std::chrono::steady_clock::now();
  totalWallMs_ +=
      std::chrono::duration<double, std::milli>(endTime - startTime).count();
  accumulateWhisperTimings();
  return result;
}

void BCIModel::throwIfWhisperFailed(int result) const {
  if (result == 0) {
    return;
  }
  throwIfCancelled();
  throw std::runtime_error(
      "Failed to process neural signal (whisper_full returned " +
      std::to_string(result) + ")");
}

whisper_full_params BCIModel::buildNeuralProcessParams() {
  whisper_full_params params = toWhisperFullParams(cfg_);
  params.new_segment_callback = onNewSegment;
  params.new_segment_callback_user_data = this;
  params.abort_callback = shouldAbortWhisper;
  params.abort_callback_user_data = &cancelRequested_;
  return params;
}

void BCIModel::process(const Input& rawNeuralData) {
  ensureContextInitialized();
  throwIfCancelled();

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Processing neural signal (" + std::to_string(rawNeuralData.size()) +
          " bytes)");

  const int dayIdx = resolveDayIdx();
  warnIfDayIdxOutOfRange(dayIdx);

  const auto melFeatures = neuralProcessor_.processToMel(rawNeuralData, dayIdx);
  const int melBins = neuralProcessor_.getMelBins();
  const int melFrames = neuralProcessor_.getMelFrames();

  processCalls_ += 1;

  whisper_full_params params = buildNeuralProcessParams();
  const int result = runWhisperTimed(melFeatures, melFrames, melBins, params);
  throwIfWhisperFailed(result);
}

std::any BCIModel::process(const std::any& input) {
  AnyInput modelInput;
  if (auto* anyInput = std::any_cast<AnyInput>(
          const_cast<std::any*>(&input))) {
    modelInput = std::move(*anyInput);
  } else if (auto* inputVector = std::any_cast<Input>(
                 const_cast<std::any*>(&input))) {
    modelInput.input = std::move(*inputVector);
  } else {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string("Invalid input type for BCIModel::process: ") +
            input.type().name());
  }

  const auto previousOutputCallback = on_segment_;
  const bool shouldOverrideCallback =
      static_cast<bool>(modelInput.outputCallback);
  if (shouldOverrideCallback) {
    on_segment_ = modelInput.outputCallback;
  }

  // Clear the cancel flag FIRST so a cancel() call that races with reset()
  // is not silently lost. process(Input&) still checks cancelRequested_ at
  // the top, so a cancel that arrives between these two statements aborts
  // the upcoming whisper_full call via shouldAbortWhisper.
  cancelRequested_.store(false, std::memory_order_relaxed);
  reset();
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
  }

  return output_;
}

void BCIModel::saveLoadParams(const BCIConfig& config) {
  setConfig(config);
}

void BCIModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
}

bool BCIModel::configContextIsChanged(
    const BCIConfig& oldCfg, const BCIConfig& newCfg) {
  const std::vector<std::string> contextKeys = {
      "model", "use_gpu", "flash_attn", "gpu_device"};
  return std::ranges::any_of(contextKeys, [&](const std::string& key) {
    const auto oldIt = oldCfg.whisperContextCfg.find(key);
    const auto newIt = newCfg.whisperContextCfg.find(key);
    if (oldIt != oldCfg.whisperContextCfg.end() &&
        newIt != newCfg.whisperContextCfg.end()) {
      return oldIt->second != newIt->second;
    }
    return (oldIt != oldCfg.whisperContextCfg.end()) !=
           (newIt != newCfg.whisperContextCfg.end());
  });
}

void BCIModel::resetContext() { ctx_.reset(); }

void BCIModel::setConfig(const BCIConfig& config) {
  bool contextChanged = configContextIsChanged(cfg_, config);
  cfg_ = config;
  if (contextChanged) reload();
}

} // namespace qvac_lib_inference_addon_bci
