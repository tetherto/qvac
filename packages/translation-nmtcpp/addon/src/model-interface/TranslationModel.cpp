#include "TranslationModel.hpp"

#include <filesystem>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <vector>

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

BackendType TranslationModel::detectBackendType(const std::string& modelPath) {
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
  nmtCtx_ = nullptr;
#ifdef HAVE_BERGAMOT
  bergamotCtx_ = nullptr;
#endif
}

void TranslationModel::load() {
  // Read backend loading config and initialize backends before any model
  // loading. Keys are preserved in config_ so reload() can re-initialize with
  // the same backends directory.
  std::string backendsDir;
  if (auto it = config_.find("backendsdir"); it != config_.end()) {
    if (const auto* value = std::get_if<std::string>(&it->second)) {
      backendsDir = *value;
    } else {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          "[TRANSLATION MODEL] 'backendsdir' config value is not a string; "
          "ignoring");
    }
  }
  std::string openclCacheDir;
  if (auto it = config_.find("openclcachedir"); it != config_.end()) {
    if (const auto* value = std::get_if<std::string>(&it->second)) {
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
    auto src_vocab_iter = config_.find("src_vocab");
    auto dst_vocab_iter = config_.find("dst_vocab");

    // Check vocab paths are provided
    if (src_vocab_iter == config_.end() ||
        !std::holds_alternative<std::string>(src_vocab_iter->second) ||
        std::get<std::string>(src_vocab_iter->second).empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "[TRANSLATION MODEL] ERROR: Source vocab path not provided");
      throw std::runtime_error("Source vocab path required for Bergamot");
    }

    if (dst_vocab_iter == config_.end() ||
        !std::holds_alternative<std::string>(dst_vocab_iter->second) ||
        std::get<std::string>(dst_vocab_iter->second).empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "[TRANSLATION MODEL] ERROR: Destination vocab path not provided");
      throw std::runtime_error("Destination vocab path required for Bergamot");
    }

    params.src_vocab_path = std::get<std::string>(src_vocab_iter->second);
    params.dst_vocab_path = std::get<std::string>(dst_vocab_iter->second);

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[TRANSLATION MODEL] Model path: " + params.model_path);
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[TRANSLATION MODEL] Src vocab: " + params.src_vocab_path);
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[TRANSLATION MODEL] Dst vocab: " + params.dst_vocab_path);

    bergamotCtx_.reset(bergamot_init(modelPath_.c_str(), params));

    if (bergamotCtx_ == nullptr) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "[TRANSLATION MODEL] ERROR: Failed to initialize Bergamot backend!");
      throw std::runtime_error("Failed to load model with Bergamot backend");
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

  std::ostringstream oss;
  oss << "[TRANSLATION MODEL] use_gpu set to: " << (useGpu_ ? "true" : "false");
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, oss.str());

  nmtCtx_.reset(nmt_init_from_file_with_params(modelPath_.c_str(), params));

  std::ostringstream ctxMsg;
  ctxMsg
      << "[TRANSLATION MODEL] nmt_init_from_file_with_params() returned, ctx="
      << (void*)nmtCtx_.get();
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, ctxMsg.str());

  if (nmtCtx_ == nullptr) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "[TRANSLATION MODEL] ERROR: nmtCtx_ is NULL!");
    throw std::runtime_error("Failed to load model");
  }
  isFirstSentence_ = true;
  srcLang_.clear();
  tgtLang_.clear();

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
  std::scoped_lock<std::mutex> scoped_lock(mtx_);
#ifdef HAVE_BERGAMOT
  if (backendType_ == BackendType::BERGAMOT && bergamotCtx_) {
    bergamot_reset_runtime_stats(bergamotCtx_.get());
    return;
  }
#endif

  if (nmtCtx_) {
    nmt_reset_runtime_stats(nmtCtx_.get());
    nmt_reset_state(nmtCtx_.get());
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
  const std::string DELIMITER = " ";

  if (isFirstSentence_) {
    std::string word1;
    std::string word2;
    std::string::size_type start = 0;
    std::string::size_type end = 0;
    int counter = 0;

    start = input.find_first_not_of(DELIMITER, end);
    if (start != std::string::npos) {
      end = input.find(DELIMITER, start);
      word1 = input.substr(start, end - start);
      counter++;

      start = input.find_first_not_of(DELIMITER, end);
      if (start != std::string::npos) {
        end = input.find(DELIMITER, start);
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
    end = input.find(DELIMITER, 0);
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
  std::scoped_lock<std::mutex> scoped_lock(mtx_);

  if (auto* inputString = std::any_cast<std::string>(&input)) {
    return processString(*inputString);
  } else if (
      auto* inputBatch = std::any_cast<std::vector<std::string>>(&input)) {
    return processBatch(*inputBatch);
  } else {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "[TRANSLATION MODEL] ERROR: Invalid input type!");
    throw std::runtime_error("Invalid Input type");
  }
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

    bool allAreSpace =
        std::all_of(text.begin(), text.end(), [](unsigned char chr) {
          return std::isspace(chr);
        });
    if (allAreSpace) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "[PROCESS] Text is all spaces, returning empty");
      return "";
    }

    std::string output = bergamot_translate(bergamotCtx_.get(), text.c_str());
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

  bool allAreSpace =
      std::all_of(text.begin(), text.end(), [](unsigned char chr) {
        return std::isspace(chr);
      });
  if (allAreSpace) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "[PROCESS] Text is all spaces, returning empty");
    return "";
  }

  nmt_reset_state(nmtCtx_.get());

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
      allAreSpace =
          std::all_of(text.begin(), text.end(), [](unsigned char chr) {
            return std::isspace(chr);
          });
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

    auto result = bergamot_translate_batch(bergamotCtx_.get(), texts);
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

    if (bergamot_get_runtime_stats(
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

  if (nmt_get_runtime_stats(
          nmtCtx_.get(), &encodeTime, &decodeTime, &totalTokens) == 0) {
    // TTFT = encodeTime in milliseconds (time before first output token)
    double ttft = encodeTime * 1000.0;
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

void TranslationModel::setConfig(
    std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
        config) {
  config_ = std::move(config);
  updateConfig();
}

void TranslationModel::setUseGpu(bool useGpu) { useGpu_ = useGpu; }

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

} // namespace qvac_lib_inference_addon_nmt
