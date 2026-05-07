#include "TranslationModel.hpp"

#include <climits>
#include <cmath>
#include <filesystem>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <vector>

#include <ggml-backend.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "nmt_utils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_nmt {

std::string TranslationModel::getName() const {
  switch (backendType_) {
  case BackendType::GGML:
    return std::string("GGML : ") + srcLang_ + "->" + tgtLang_;
#ifdef HAVE_BERGAMOT
  case BackendType::BERGAMOT:
    return std::string("BERGAMOT : ") + srcLang_ + "->" + tgtLang_;

#endif
  default:
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InternalError, "Invalid backend type.");
  }
}

TranslationModel::TranslationModel(const std::string& modelPath) {
  if (!modelPath.empty()) {
    saveLoadParams(modelPath);
    backendType_ = detectBackendType(modelPath);
  }
}

BackendType TranslationModel::
    detectBackendType( // NOLINT(readability-convert-member-functions-to-static)
        const std::string& modelPath) {
#ifdef HAVE_BERGAMOT
  // Check for bergamot model indicators
  // Bergamot models typically have .intgemm in the filename or vocab.spm files
  try {
    std::filesystem::path pathObj(modelPath);

    // Check if this is a directory
    if (std::filesystem::is_directory(pathObj)) {
      // Look for bergamot-specific files in the directory
      for (const auto& entry : std::filesystem::directory_iterator(pathObj)) {
        std::string filename = entry.path().filename().string();
        // Check for bergamot model signatures
        if (filename.find(".intgemm") != std::string::npos ||
            (filename.find("vocab.") != std::string::npos &&
             filename.find(".spm") != std::string::npos)) {
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::INFO,
              "[TRANSLATION MODEL] Detected Bergamot backend based on model "
              "files");
          return BackendType::BERGAMOT;
        }
      }
    } else {
      // Check if the model file path itself indicates bergamot
      std::string pathStr = pathObj.string();
      if (pathStr.find(".intgemm") != std::string::npos) {
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::INFO,
            "[TRANSLATION MODEL] Detected Bergamot backend based on model "
            "filename");
        return BackendType::BERGAMOT;
      }
    }
  } catch (const std::exception& e) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "[TRANSLATION MODEL] Error during backend detection: " +
            std::string(e.what()));
  }
#endif

  // Default to GGML backend
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[TRANSLATION MODEL] Using GGML backend (default)");
  return BackendType::GGML;
}

void TranslationModel::unload() {
  std::scoped_lock<std::mutex> lock(mtx_);
  activeBackendName_.clear();
  activeBackendDescription_.clear();
  nmtCtx_ = nullptr;
#ifdef HAVE_BERGAMOT
  bergamotCtx_ = nullptr;
#endif
}

void TranslationModel::
    load() { // NOLINT(readability-function-cognitive-complexity)
  // Read backend loading config and initialize backends before any model
  // loading. Keys are preserved in config_ so reload() can re-initialize with
  // the same backends directory.
  std::string backendsDir;
  if (auto iter = config_.find("backendsdir"); iter != config_.end()) {
    if (const auto* value = std::get_if<std::string>(&iter->second)) {
      backendsDir = *value;
    } else {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "[TRANSLATION MODEL] 'backendsdir' config value is not a string; "
          "ignoring");
    }
  }
  std::string openclCacheDir;
  if (auto iter = config_.find("openclcachedir"); iter != config_.end()) {
    if (const auto* value = std::get_if<std::string>(&iter->second)) {
      openclCacheDir = *value;
    } else {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "[TRANSLATION MODEL] 'openclcachedir' config value is not a string; "
          "ignoring");
    }
  }
  backendsHandle_.emplace(backendsDir, openclCacheDir);

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[TRANSLATION MODEL] modelPath_: " + modelPath_);

  if (modelPath_.empty()) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "[TRANSLATION MODEL] ERROR: modelPath_ is empty!");
    throw std::runtime_error("Failed to load model.");
  }

#ifdef HAVE_BERGAMOT
  if (backendType_ == BackendType::BERGAMOT) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[TRANSLATION MODEL] Loading with Bergamot backend");

    bergamot_params params;
    params.use_gpu = useGpu_;
    params.num_workers = get_optimal_thread_count();
    params.cache_size = 0;

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[TRANSLATION MODEL] Bergamot using " +
            std::to_string(params.num_workers) + " CPU thread(s)");

    // Set model path
    params.model_path = modelPath_;

    auto setBergamotParam =
        [&]<typename TValue>(const std::string& key, auto setter) {
          auto iter = config_.find(key);
          if (iter == config_.end()) {
            return;
          }

          if (std::holds_alternative<TValue>(iter->second)) {
            setter(std::get<TValue>(iter->second));
            return;
          }

          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
              "[TRANSLATION MODEL] Ignoring Bergamot config '" + key +
                  "' because the value type is unsupported");
        };

    setBergamotParam.operator()<int64_t>("beamsize", [&](double value) {
      params.beam_size = static_cast<int>(value);
    });
    setBergamotParam.operator()<int64_t>(
        "normalize", [&](int64_t value) { params.normalize = (bool)value; });
    setBergamotParam.operator()<double>("max_length_factor", [&](double value) {
      params.max_length_factor = value;
    });
    // Extract vocab paths from config
    auto srcVocabIter = config_.find("src_vocab");
    auto dstVocabIter = config_.find("dst_vocab");

    // Check vocab paths are provided
    if (srcVocabIter == config_.end() ||
        !std::holds_alternative<std::string>(srcVocabIter->second) ||
        std::get<std::string>(srcVocabIter->second).empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "[TRANSLATION MODEL] ERROR: Source vocab path not provided");
      throw std::runtime_error("Source vocab path required for Bergamot");
    }

    if (dstVocabIter == config_.end() ||
        !std::holds_alternative<std::string>(dstVocabIter->second) ||
        std::get<std::string>(dstVocabIter->second).empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "[TRANSLATION MODEL] ERROR: Destination vocab path not provided");
      throw std::runtime_error("Destination vocab path required for Bergamot");
    }

    params.src_vocab_path = std::get<std::string>(srcVocabIter->second);
    params.dst_vocab_path = std::get<std::string>(dstVocabIter->second);

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[TRANSLATION MODEL] Model path: " + params.model_path);
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[TRANSLATION MODEL] Src vocab: " + params.src_vocab_path);
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[TRANSLATION MODEL] Dst vocab: " + params.dst_vocab_path);

    // Build the freshly-loaded Bergamot context outside the lock so the
    // heavy bergamotInit call doesn't serialize against
    // getActiveBackendName(); commit it under mtx_ so any concurrent reader
    // sees a consistent context state. Mirrors the GGML path below.
    std::unique_ptr<bergamot_context, decltype(&bergamotFree)> freshBergamotCtx(
        bergamotInit(modelPath_.c_str(), params), &bergamotFree);

    if (freshBergamotCtx == nullptr) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "[TRANSLATION MODEL] ERROR: Failed to initialize Bergamot backend!");
      throw std::runtime_error("Failed to load model with Bergamot backend");
    }

    {
      std::scoped_lock<std::mutex> lock(mtx_);
      bergamotCtx_ = std::move(freshBergamotCtx);
    }

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[TRANSLATION MODEL] Bergamot backend loaded successfully");
    return;
  }
#endif

  // GGML backend
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[TRANSLATION MODEL] Loading with GGML backend");

  nmt_context_params params = nmt_context_default_params();
  params.use_gpu = useGpu_;
  params.gpu_backend = gpuBackend_;
  params.gpu_device = gpuDevice_;
  params.op_offload_min_batch = opOffloadMinBatch_;

  std::ostringstream oss;
  oss << "[TRANSLATION MODEL] use_gpu=" << (useGpu_ ? "true" : "false")
      << ", gpu_device=" << gpuDevice_;
  if (!gpuBackend_.empty()) {
    oss << ", gpu_backend='" << gpuBackend_ << "'";
  }
  if (opOffloadMinBatch_ >= 0) {
    oss << ", op_offload_min_batch=" << opOffloadMinBatch_;
  }
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, oss.str());

  // Build the freshly-loaded context outside the lock so the heavy
  // nmtInitFromFileWithParams call doesn't serialize against
  // getActiveBackendName(). Then commit nmtCtx_ + activeBackendName_ together
  // under mtx_ so any concurrent reader sees a consistent (ctx, name) pair.
  std::unique_ptr<nmt_context, decltype(&nmt_free)> freshCtx(
      nmtInitFromFileWithParams(modelPath_.c_str(), params), &nmt_free);

  std::ostringstream ctxMsg;
  ctxMsg << "[TRANSLATION MODEL] nmtInitFromFileWithParams() returned, ctx="
         << (void*)freshCtx.get();
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, ctxMsg.str());

  if (freshCtx == nullptr) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "[TRANSLATION MODEL] ERROR: nmtCtx_ is NULL!");
    throw std::runtime_error("Failed to load model");
  }

  std::string cachedName = "CPU";
  std::string cachedDescription;
  if (freshCtx->state != nullptr) {
    for (ggml_backend_t backend : freshCtx->state->backends) {
      if (backend == nullptr) {
        continue;
      }
      ggml_backend_dev_t dev = ggml_backend_get_device(backend);
      if (dev == nullptr) {
        continue;
      }
      if (ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_CPU) {
        continue;
      }
      const char* name = ggml_backend_dev_name(dev);
      if (name != nullptr) {
        cachedName = std::string(name);
      }
      const char* desc = ggml_backend_dev_description(dev);
      if (desc != nullptr) {
        cachedDescription = sanitizePrintableAscii(std::string(desc));
      }
      break;
    }
  }

  {
    std::scoped_lock<std::mutex> lock(mtx_);
    nmtCtx_ = std::move(freshCtx);
    activeBackendName_ = std::move(cachedName);
    activeBackendDescription_ = std::move(cachedDescription);
    isFirstSentence_ = true;
    srcLang_.clear();
    tgtLang_.clear();
  }

  updateConfig();

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[TRANSLATION MODEL] GGML backend loaded successfully");
}

void TranslationModel::reload() {
  unload();
  load();
}

void TranslationModel::saveLoadParams(const std::string& modelPath) {
  modelPath_ = modelPath;
}

void TranslationModel::reset() const {
  std::scoped_lock<std::mutex> scopedLock(mtx_);
#ifdef HAVE_BERGAMOT
  if (backendType_ == BackendType::BERGAMOT && bergamotCtx_) {
    bergamotResetRuntimeStats(bergamotCtx_.get());
    return;
  }
#endif

  if (nmtCtx_) {
    nmtResetRuntimeStats(nmtCtx_.get());
    nmtResetState(nmtCtx_.get());
  }
  isFirstSentence_ = true;
}

bool TranslationModel::isLoaded() const {
#ifdef HAVE_BERGAMOT
  if (backendType_ == BackendType::BERGAMOT) {
    return bergamotCtx_ != nullptr;
  }
#endif
  return nmtCtx_ != nullptr;
}

std::string TranslationModel::indictransPreProcess(const std::string& text) {
  std::string input = text;
  const std::string kDelimiter = " ";

  if (isFirstSentence_) {
    std::string word1;
    std::string word2;
    std::string::size_type start = 0;
    std::string::size_type end = 0;
    int counter = 0;

    start = input.find_first_not_of(kDelimiter, end);
    if (start != std::string::npos) {
      end = input.find(kDelimiter, start);
      word1 = input.substr(start, end - start);
      counter++;

      start = input.find_first_not_of(kDelimiter, end);
      if (start != std::string::npos) {
        end = input.find(kDelimiter, start);
        word2 = input.substr(start, end - start);
        counter++;
      }
    }

    if (counter >= 2) {
      srcLang_ = word1;
      tgtLang_ = word2;
      isFirstSentence_ = false;

      input = input.erase(0, end);
    }
  } else {
    std::string::size_type end = 0;
    end = input.find(kDelimiter, 0);
    std::string temp = input.substr(0, end);

    if (temp == srcLang_) {
      end = input.find(tgtLang_, 0) + tgtLang_.size();
      input = input.erase(0, end);
    }
  }

  if (!srcLang_.empty() && !tgtLang_.empty()) {
    std::string result;
    result.reserve(srcLang_.size() + tgtLang_.size() + input.size() + 2);
    result.append(srcLang_).append(" ").append(tgtLang_).append(" ").append(
        input);
    input = std::move(result);
  }

  return input;
}

std::any TranslationModel::process(const std::any& input) {
  std::scoped_lock<std::mutex> scopedLock(mtx_);

  if (const auto* inputString = std::any_cast<std::string>(&input)) {
    return processString(*inputString);
  }
  if (const auto* inputBatch =
          std::any_cast<std::vector<std::string>>(&input)) {
    return processBatch(*inputBatch);
  }
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
      "[TRANSLATION MODEL] ERROR: Invalid input type!");
  throw std::runtime_error("Invalid Input type");
}

void TranslationModel::cancel() const { reset(); }
std::string TranslationModel::processString(const std::string& text) {
#ifdef HAVE_BERGAMOT
  if (backendType_ == BackendType::BERGAMOT) {
    if (!bergamotCtx_) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "Attempted to process text without a Bergamot model loaded");
      return "";
    }

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "[PROCESS] Processing with Bergamot backend, text length: " +
            std::to_string(text.length()));

    bool allAreSpace = std::all_of( // NOLINT(modernize-use-ranges)
        text.begin(),
        text.end(),
        [](unsigned char chr) { return std::isspace(chr); });
    if (allAreSpace) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "[PROCESS] Text is all spaces, returning empty");
      return "";
    }

    std::string output = bergamotTranslate(bergamotCtx_.get(), text.c_str());
    return output;
  }
#endif

  // GGML backend
  if (!nmtCtx_) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "Attempted to process text without a model loaded");
    return "";
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[PROCESS] Processing with GGML backend, text length: " +
          std::to_string(text.length()));

  bool allAreSpace = std::all_of( // NOLINT(modernize-use-ranges)
      text.begin(),
      text.end(),
      [](unsigned char chr) { return std::isspace(chr); });
  if (allAreSpace) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "[PROCESS] Text is all spaces, returning empty");
    return "";
  }

  nmtResetState(nmtCtx_.get());

  std::string input = text;
  if (nmt_model_is_indictrans(nmtCtx_.get())) {
    input = indictransPreProcess(text);
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[PROCESS] Input to model: \"" + input + "\"");

  nmt_full(nmtCtx_.get(), input.c_str());

  std::string output = nmt_get_output(nmtCtx_.get());

  return output;
}

std::vector<std::string>
TranslationModel::processBatch(const std::vector<std::string>& texts) {
#ifdef HAVE_BERGAMOT
  if (backendType_ == BackendType::BERGAMOT) {
    if (!bergamotCtx_) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "Attempted to process text without a Bergamot model loaded");
      return {};
    }

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "[PROCESS-BATCH] Processing batches with Bergamot backend for " +
            std::to_string(texts.size()) + " batches.");

    // Pre-process each text
    bool allAreSpace{false};
    for (const auto& text : texts) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "[PROCESS] Processing each text with Bergamot backend, text "
          "length: " +
              std::to_string(text.length()));
      // check if text is just spaces
      allAreSpace = std::all_of( // NOLINT(modernize-use-ranges)
          text.begin(),
          text.end(),
          [](unsigned char chr) { return std::isspace(chr); });
      if (allAreSpace) {
        break;
      }
    }

    if (allAreSpace) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "[PROCESS-BATCH] One or more Text is all spaces, returning empty "
          "result");
      return {};
    }

    auto result = bergamotTranslateBatch(bergamotCtx_.get(), texts);
    if (!result.error.empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "[PROCESS_BATCH] Error: " + result.error);
    }
    return result.translations;
  }
#endif
  // GGML backend: process one-by-one
  std::vector<std::string> results;
  results.reserve(texts.size());
  for (const auto& text : texts) {
    results.push_back(processString(text));
  }
  return results;
}

qvac_lib_inference_addon_cpp::RuntimeStats TranslationModel::runtimeStats()
    const { // NOLINT(readability-convert-member-functions-to-static)
#ifdef HAVE_BERGAMOT
  if (backendType_ == BackendType::BERGAMOT) {
    if (!bergamotCtx_) {
      return {};
    }

    double encodeTime = 0.0;
    double decodeTime = 0.0;
    int totalTokens = 0;

    if (bergamotGetRuntimeStats(
            bergamotCtx_.get(), &encodeTime, &decodeTime, &totalTokens) == 0) {
      // For Bergamot: totalTime = decodeTime (no separate encode phase)
      double totalTime = decodeTime;
      // TPS = tokens per second (total tokens / total time)
      double tps = (totalTime > 0) ? totalTokens / totalTime : 0.0;

      return {
          std::make_pair(
              "totalTokens",
              std::variant<double, int64_t>(static_cast<int64_t>(totalTokens))),
          std::make_pair("totalTime", std::variant<double, int64_t>(totalTime)),
          std::make_pair(
              "decodeTime", std::variant<double, int64_t>(decodeTime)),
          std::make_pair("TPS", std::variant<double, int64_t>(tps))};
    }

    return {};
  }
#endif

  // GGML backend
  if (!nmtCtx_) {
    return {};
  }

  double encodeTime = 0.0;
  double decodeTime = 0.0;
  int totalTokens = 0;

  if (nmtGetRuntimeStats(
          nmtCtx_.get(), &encodeTime, &decodeTime, &totalTokens) == 0) {
    // TTFT = encodeTime in milliseconds (time before first output token)
    double ttft =
        encodeTime *
        1000.0; // NOLINT(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
    // TPS = tokens per second (total tokens / total time)
    double totalTime = encodeTime + decodeTime;
    double tps = (totalTime > 0) ? totalTokens / totalTime : 0.0;

    return {
        std::make_pair(
            "totalTokens",
            std::variant<double, int64_t>(static_cast<int64_t>(totalTokens))),
        std::make_pair(
            "totalTime",
            std::variant<double, int64_t>(encodeTime + decodeTime)),
        std::make_pair("encodeTime", std::variant<double, int64_t>(encodeTime)),
        std::make_pair("decodeTime", std::variant<double, int64_t>(decodeTime)),
        std::make_pair("TTFT", std::variant<double, int64_t>(ttft)),
        std::make_pair("TPS", std::variant<double, int64_t>(tps))};
  }

  return {};
}

TranslationModel::~TranslationModel() { unload(); }

std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
TranslationModel::getConfig() const {
  return config_;
}

void TranslationModel::
    setConfig( // NOLINT(readability-function-cognitive-complexity)
        std::unordered_map<
            std::string, std::variant<double, int64_t, std::string>>
            config) {
  config_ = std::move(config);

  // use_gpu is lifted out of the generic map because it must be applied
  // BEFORE load() — the GGML/Bergamot backend picks it up from useGpu_ at
  // init time, and updateConfig() below is a no-op until nmtCtx_ exists.
  // getConfigMap() stores booleans as int64 {0,1}, so accept either int64
  // or double (0.0/1.0) for defensiveness.
  if (auto iter = config_.find("use_gpu"); iter != config_.end()) {
    bool value = false;
    bool parsed = false;
    if (const auto* asInt = std::get_if<int64_t>(&iter->second)) {
      value = (*asInt != 0);
      parsed = true;
    } else if (const auto* asDouble = std::get_if<double>(&iter->second)) {
      value = (*asDouble != 0.0);
      parsed = true;
    } else {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "[TRANSLATION MODEL] 'use_gpu' config value is not a "
          "boolean/number; ignoring");
    }
    if (parsed) {
      setUseGpu(value);
    }
  }

  // Same pre-load lift for gpu_backend — the ggml device selector in
  // nmt_backend_init_gpu reads it at init time. Accepts strings like
  // "vulkan", "vulkan0", "opencl", "metal" (case-insensitive substring).
  if (auto iter = config_.find("gpu_backend"); iter != config_.end()) {
    if (const auto* asString = std::get_if<std::string>(&iter->second)) {
      setGpuBackend(*asString);
    } else {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "[TRANSLATION MODEL] 'gpu_backend' config value is not a string; "
          "ignoring");
    }
  }

  // Same pre-load lift for gpu_device — ordinal among matching devices.
  // Cap to a small upper bound to keep the per-device-loop counter (`int`)
  // safely away from overflow and to reject obviously-bogus inputs.
  static constexpr int64_t kMaxGpuDevice = 64;
  if (auto iter = config_.find("gpu_device"); iter != config_.end()) {
    if (const auto* asInt = std::get_if<int64_t>(&iter->second)) {
      const int64_t val = *asInt;
      if (val < 0 || val > kMaxGpuDevice) {
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
            "[TRANSLATION MODEL] 'gpu_device' int value out of range "
            "[0, 64]; ignoring");
      } else {
        setGpuDevice(static_cast<int>(val));
      }
    } else if (const auto* asDouble = std::get_if<double>(&iter->second)) {
      double val = *asDouble;
      if (std::isfinite(val) && val >= 0.0 &&
          val <= static_cast<double>(kMaxGpuDevice)) {
        if (val != std::floor(val)) {
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
              "[TRANSLATION MODEL] 'gpu_device' double has fractional part; "
              "truncating toward zero");
        }
        setGpuDevice(static_cast<int>(val));
      } else {
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
            "[TRANSLATION MODEL] 'gpu_device' double value out of range "
            "[0, 64]; ignoring");
      }
    } else {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "[TRANSLATION MODEL] 'gpu_device' config value is not a number; "
          "ignoring");
    }
  }

  if (auto iter = config_.find("op_offload_min_batch"); iter != config_.end()) {
    if (const auto* asInt = std::get_if<int64_t>(&iter->second)) {
      auto clamped = std::clamp(
          *asInt, static_cast<int64_t>(0), static_cast<int64_t>(INT_MAX));
      setOpOffloadMinBatch(static_cast<int>(clamped));
    } else if (const auto* asDouble = std::get_if<double>(&iter->second)) {
      if (std::isfinite(*asDouble)) {
        auto clamped = std::clamp(
            static_cast<int64_t>(*asDouble),
            static_cast<int64_t>(0),
            static_cast<int64_t>(INT_MAX));
        setOpOffloadMinBatch(static_cast<int>(clamped));
      }
    } else {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "[TRANSLATION MODEL] 'op_offload_min_batch' config value is not a "
          "number; ignoring");
    }
  }

  updateConfig();
}

void TranslationModel::setUseGpu(bool useGpu) { useGpu_ = useGpu; }

void TranslationModel::setGpuBackend(const std::string& gpuBackend) {
  // Tight allowlist — every valid ggml device name substring fits in
  // [a-zA-Z0-9_-]. Rejecting other printable chars (quotes, equals, spaces,
  // etc.) prevents log-line spoofing in messages that embed the value.
  static constexpr size_t kMaxGpuBackendLen = 64;
  std::string sanitized;
  sanitized.reserve(std::min(gpuBackend.size(), kMaxGpuBackendLen));
  for (size_t i = 0; i < gpuBackend.size() && i < kMaxGpuBackendLen; ++i) {
    auto chr = static_cast<unsigned char>(gpuBackend[i]);
    const bool allowed = (chr >= 'a' && chr <= 'z') ||
                         (chr >= 'A' && chr <= 'Z') ||
                         (chr >= '0' && chr <= '9') || chr == '_' || chr == '-';
    if (allowed) {
      sanitized.push_back(static_cast<char>(chr));
    }
  }
  if (sanitized.size() != gpuBackend.size()) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "[TRANSLATION MODEL] gpu_backend rejected — contains disallowed "
        "characters (only [a-zA-Z0-9_-] accepted); ignoring");
    return;
  }
  gpuBackend_ = std::move(sanitized);
}

void TranslationModel::setGpuDevice(int gpuDevice) {
  if (gpuDevice < 0) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "[TRANSLATION MODEL] gpu_device is negative; clamping to 0");
    gpuDevice_ = 0;
  } else {
    gpuDevice_ = gpuDevice;
  }
}

void TranslationModel::setOpOffloadMinBatch(int opOffloadMinBatch) {
  opOffloadMinBatch_ = opOffloadMinBatch;
}

void TranslationModel::updateConfig() {
  if (nmtCtx_) {
    auto setInt64Param = [&](const std::string& key, auto setter) {
      auto iter = config_.find(key);
      if (iter != config_.end()) {
        if (std::holds_alternative<int64_t>(iter->second)) {
          (nmtCtx_.get()->*setter)(std::get<int64_t>(iter->second));
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::INFO,
              "Set " + key + " to " +
                  std::to_string(std::get<int64_t>(iter->second)));

        } else {
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
              "Error: Invalid type for parameter '" + key + "'. Expected int");
        }
      }
    };

    auto setDoubleParam = [&](const std::string& key, auto setter) {
      auto iter = config_.find(key);
      if (iter != config_.end()) {
        if (std::holds_alternative<double>(iter->second)) {
          (nmtCtx_.get()->*setter)(std::get<double>(iter->second));
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::INFO,
              "Set " + key + " to " +
                  std::to_string(std::get<double>(iter->second)));
        } else if (std::holds_alternative<int64_t>(iter->second)) {
          // Auto-convert int to double for convenience
          auto value = static_cast<double>(std::get<int64_t>(iter->second));
          (nmtCtx_.get()->*setter)(value);
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::INFO,
              "Set " + key + " to " + std::to_string(value));
        } else {
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
              "Error: Invalid type for parameter '" + key +
                  "'. Expected float");
        }
      }
    };

    setInt64Param("beamsize", &nmt_context::setBeamSize);
    setDoubleParam("lengthpenalty", &nmt_context::setLengthPenalty);
    setInt64Param("maxlength", &nmt_context::setMaxLength);
    setDoubleParam("repetitionpenalty", &nmt_context::setRepetitionPenalty);
    setInt64Param("norepeatngramsize", &nmt_context::setNoRepeatNgramSize);
    setDoubleParam("temperature", &nmt_context::setTemperature);
    setInt64Param("topk", &nmt_context::setTopK);
    setDoubleParam("topp", &nmt_context::setTopP);
  }
}

std::string TranslationModel::getActiveBackendName() const {
  std::scoped_lock<std::mutex> scopedLock(mtx_);

#ifdef HAVE_BERGAMOT
  if (backendType_ == BackendType::BERGAMOT) {
    return bergamotCtx_ ? std::string("Bergamot-CPU") : std::string("Unloaded");
  }
#endif

  if (!nmtCtx_) {
    return "Unloaded";
  }

  return activeBackendName_;
}

std::string TranslationModel::getActiveBackendDescription() const {
  std::scoped_lock<std::mutex> scopedLock(mtx_);

#ifdef HAVE_BERGAMOT
  if (backendType_ == BackendType::BERGAMOT) {
    return "";
  }
#endif

  if (!nmtCtx_) {
    return "";
  }

  return activeBackendDescription_;
}

} // namespace qvac_lib_inference_addon_nmt
