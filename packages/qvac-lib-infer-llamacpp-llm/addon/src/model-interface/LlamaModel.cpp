#include "LlamaModel.hpp"

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <filesystem>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <system_error>
#include <vector>

#include <common/arg.h>
#include <common/chat.h>
#include <common/common.h>
#include <common/log.h>
#include <llama.h>
#include <llama/mtmd/mtmd.h>
#include <picojson/picojson.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "MtmdLlmContext.hpp"
#include "TextLlmContext.hpp"
#include "addon/LlmErrors.hpp"
#include "qvac-lib-inference-addon-cpp/LlamacppUtils.hpp"
#include "utils/BackendSelection.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

static std::vector<std::string> split(const std::string& str, char delimiter) {
  auto trim = [](const std::string& str) -> std::string {
    auto start =
        std::find_if(str.begin(), str.end(), [](unsigned char character) {
          return std::isspace(character) == 0;
        });

    if (start == str.end()) {
      return "";
    }

    auto end =
        std::find_if(str.rbegin(), str.rend(), [](unsigned char character) {
          return std::isspace(character) == 0;
        }).base();

    return {start, end};
  };

  std::vector<std::string> tokens;
  std::istringstream stream(str);
  std::string token;

  while (std::getline(stream, token, delimiter)) {
    auto trimmed = trim(token);
    if (!trimmed.empty()) {
      tokens.push_back(std::move(trimmed));
    }
  }
  return tokens;
}

void LlamaModel::resolveShardPaths(
    GGUFShards& shards, const std::string& modelPath) {
  if (shards.gguf_files.empty())
    return;
  auto baseDir = std::filesystem::path(modelPath).parent_path();
  if (baseDir.empty())
    return;
  for (auto& f : shards.gguf_files)
    f = (baseDir / f).string();
  shards.tensors_file = (baseDir / shards.tensors_file).string();
}

void LlamaModel::tuneConfigMap(
    std::unordered_map<std::string, std::string>& configFilemap,
    const ModelMetaData& metadata, const std::optional<int>& adrenoVersion) {

  const bool isBitnet =
      metadata.hasOneBitQuantization() &&
      metadata.tryGetString("general.architecture") == "bitnet";

  if (isBitnet && configFilemap.find("flash-attn") == configFilemap.end() &&
      configFilemap.find("flash_attn") == configFilemap.end()) {
    configFilemap["flash-attn"] = "off";
    QLOG_IF(
        Priority::INFO,
        "[LlamaModel] BitNet model detected: disabling flash attention\n");
  }

  constexpr int kAdrenoUbatchThreshold = 800;
  if (isBitnet && adrenoVersion.has_value() &&
      adrenoVersion.value() >= kAdrenoUbatchThreshold &&
      configFilemap.find("ubatch-size") == configFilemap.end() &&
      configFilemap.find("ubatch_size") == configFilemap.end()) {
    configFilemap["ubatch-size"] = "128";
    QLOG_IF(
        Priority::INFO,
        "[LlamaModel] BitNet on Adreno 800+: defaulting ubatch-size=128\n");
  }
}

LlamaModel::LlamaModel(
    std::string&& modelPath, std::string&& projectionPath,
    std::unordered_map<std::string, std::string>&& configFilemap)
    : loadingContext_(InitLoader::getLoadingContext("LlamaModel")),
      shards_(GGUFShards::expandGGUFIntoShards(modelPath)),
      asyncWeightsLoader_(shards_, initLoader_, loadingContext_, &metadata_) {
  auto thisModelInit = [this](auto&&... args) {
    this->init(std::forward<decltype(args)>(args)...);
  };
  initLoader_.init(
      InitLoader::LOADER_TYPE::DELAYED,
      thisModelInit,
      std::move(modelPath),
      std::move(projectionPath),
      std::move(configFilemap));
}
void LlamaModel::init(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    std::string&& modelPathRvalue, std::string&& projectionPath,
    std::unordered_map<std::string, std::string>&& configFilemapRvalue) {
  std::string modelPath = std::move(modelPathRvalue);
  std::unordered_map<std::string, std::string> configFilemap =
      std::move(configFilemapRvalue);

  // Set verbosity level
  setVerbosityLevel(configFilemap);

  if (!asyncWeightsLoader_.isStreaming()) {
    resolveShardPaths(shards_, modelPath);
  }

  metadata_.parse(
      modelPath, shards_, asyncWeightsLoader_.isStreaming(), ADDON_ID);
  {
    auto fileType = metadata_.tryGetU32("general.file_type");
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[LlamaModel] general.file_type = %s\n",
            fileType.has_value() ? std::to_string(*fileType).c_str()
                                 : "unknown"));
  }

  {
    std::string backendsDir;
    if (auto backendsDirIt = configFilemap.find("backendsDir");
        backendsDirIt != configFilemap.end()) {
      backendsDir = backendsDirIt->second;
      configFilemap.erase(backendsDirIt);
    }
    initializeBackend(backendsDir);
  }

  common_params params;
  std::optional<int> adrenoVersion;
  commonParamsParse(modelPath, configFilemap, params, adrenoVersion);

  const std::string errorWhenFailed = toString(UnableToLoadModel);
  auto streamedFiles = asyncWeightsLoader_.extractIndividualStreamedFiles();
  common_init_result llamaInit = initFromConfig(
      params,
      modelPath,
      streamedFiles,
      shards_,
      loadingContext_,
      asyncWeightsLoader_.isStreaming(),
      ADDON_ID,
      errorWhenFailed);

  // Create the appropriate context based on projectionPath
  llmContext_ =
      createContext(std::move(projectionPath), params, std::move(llamaInit));

  // Apply configured nDiscarded if provided (> 0)
  if (configuredNDiscarded_ > 0 && llmContext_) {
    llmContext_->setNDiscarded(configuredNDiscarded_);
  }

  if (llmContext_) {
    cacheManager_.emplace(
        llmContext_.get(), configuredNDiscarded_, [this](bool resetStats) {
          this->resetState(resetStats);
        });
  }
}

void LlamaModel::initializeBackend(const std::string& backendsDir) {
  backendsHandle_ = LlamaBackendsHandle(backendsDir);
}

void LlamaModel::setWeightsForFile(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& shard) {
  asyncWeightsLoader_.setWeightsForFile(filename, std::move(shard));
}

bool LlamaModel::isLoaded() { return static_cast<bool>(llmContext_); }

void LlamaModel::llamaLogCallback(
    ggml_log_level level, const char* text, void* userData) {
  (void)userData;
  // Convert ggml_log_level to QLOG Priority
  Priority priority = Priority::DEBUG;
  switch (level) {
  case GGML_LOG_LEVEL_ERROR:
    priority = Priority::ERROR;
    break;
  case GGML_LOG_LEVEL_WARN:
    priority = Priority::WARNING;
    break;
  case GGML_LOG_LEVEL_INFO:
    priority = Priority::INFO;
    break;
  case GGML_LOG_LEVEL_DEBUG:
  case GGML_LOG_LEVEL_NONE:
  case GGML_LOG_LEVEL_CONT:
  default:
    priority = Priority::DEBUG;
    break;
  }

  // Only log if the message priority is at or above the configured verbosity
  // level
  QLOG_IF(priority, string_format("[Llama.cpp] %s", text));
}
void LlamaModel::cancel() const {
  if (llmContext_) {
    llmContext_->stop();
  }
}

std::any LlamaModel::process(const std::any& input) {
  if (input.type() != typeid(Prompt)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Invalid input type");
  }
  return processPrompt(std::any_cast<const Prompt&>(input));
}

LlamaModel::ResolvedPrompt
LlamaModel::resolveChatAndTools(const std::string& input) {
  ResolvedPrompt resolved;
  if (cacheManager_.has_value()) {
    resolved.isCacheLoaded = cacheManager_->handleCache(
        resolved.chatMsgs,
        resolved.tools,
        input,
        [this](const std::string& inputPrompt) {
          return this->formatPrompt(inputPrompt);
        });
    resolved.shouldResetAfterInference =
        cacheManager_->isCacheDisabled() ||
        !cacheManager_->wasCacheUsedInLastPrompt();
  } else {
    auto formatted = formatPrompt(input);
    resolved.chatMsgs = std::move(formatted.first);
    resolved.tools = std::move(formatted.second);
    resolved.shouldResetAfterInference = true;
  }
  return resolved;
}

std::string LlamaModel::processPrompt(const Prompt& prompt) {
  lastRunWasPrefill_ = prompt.prefill;

  for (const auto& media : prompt.media) {
    loadMedia(media);
  }

  std::string out;
  ResolvedPrompt resolved = resolveChatAndTools(prompt.input);

  if (resolved.chatMsgs.empty() && resolved.tools.empty()) {
    QLOG_IF(
        Priority::INFO,
        "No messages to process after session commands - returning early\n");
    return out;
  }

  bool evalOk =
      resolved.tools.empty()
          ? llmContext_->evalMessage(
                resolved.chatMsgs, resolved.isCacheLoaded, prompt.prefill)
          : llmContext_->evalMessageWithTools(
                resolved.chatMsgs,
                resolved.tools,
                resolved.isCacheLoaded,
                prompt.prefill);

  if (!evalOk) {
    QLOG_IF(
        Priority::DEBUG,
        "Inference was interrupted during prompt evaluation\n");
    return out;
  }

  if (prompt.prefill) {
    return out;
  }

  std::ostringstream oss;
  auto callback = prompt.outputCallback;
  if (!prompt.outputCallback) {
    callback = [&](const std::string& token) { oss << token; };
  }

  if (!llmContext_->generateResponse(callback)) {
    resetState();
    std::string errorMsg = string_format("%s: context overflow\n", __func__);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextOverflow), errorMsg);
  }

  if (!prompt.outputCallback) {
    out = oss.str();
  }
  if (resolved.shouldResetAfterInference) {
    resetState(false);
  }
  return out;
}

qvac_lib_inference_addon_cpp::RuntimeStats LlamaModel::runtimeStats() const {
  auto perfData = llama_perf_context(llmContext_->getCtx());
  constexpr double kMillisInSecond = 1000.0;

  double timeToFirstToken = lastRunWasPrefill_ ? 0.0 : perfData.t_p_eval_ms;
  double tokensPerSecond =
      (!lastRunWasPrefill_ && perfData.t_eval_ms > 0)
          ? kMillisInSecond / perfData.t_eval_ms * perfData.n_eval
          : 0.0;

  int32_t generatedTokens = lastRunWasPrefill_ ? 0 : perfData.n_eval;
  int32_t promptTokens = lastRunWasPrefill_ ? 0 : perfData.n_p_eval;
  llama_perf_context_reset(llmContext_->getCtx());

  return {
      {"TTFT", timeToFirstToken},
      {"TPS", tokensPerSecond},
      {"CacheTokens", llmContext_->getNPast()},
      {"generatedTokens", generatedTokens},
      {"promptTokens", promptTokens}};
}
// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
void LlamaModel::commonParamsParse(
    const std::string& modelPath,
    std::unordered_map<std::string, std::string>& configFilemap,
    common_params& params, std::optional<int>& outAdrenoVersion) {

  std::vector<std::string> configVector;

  // Check if tools are enabled and exclude it with jinja from the config file
  if (auto iter = configFilemap.find("tools"); iter != configFilemap.end()) {
    std::string toolsVal = iter->second;
    std::ranges::transform(toolsVal, toolsVal.begin(), ::tolower);
    if (toolsVal == "true") {
      params.use_jinja = true;
      // Remove "tools" from config, since using jinja
      configFilemap.erase(iter);
    } else {
      configFilemap.erase(iter);
    }
  }
  if (auto jit = configFilemap.find("jinja"); jit != configFilemap.end()) {
    // Remove "jinja" from config
    configFilemap.erase(jit);
  }

  // parse custom nDiscarded from config (apply only if > 0)
  if (auto iter = configFilemap.find("n_discarded");
      iter != configFilemap.end()) {
    try {
      long long parsed = std::stoll(iter->second);
      if (parsed > 0) {
        configuredNDiscarded_ = static_cast<llama_pos>(parsed);
      }
    } catch (...) {
      std::string errorMsg = string_format(
          "%s: invalid n_discarded value: %s\n",
          __func__,
          iter->second.c_str());
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
    configFilemap.erase(iter);
  }

  auto deviceIt = configFilemap.find("device");
  if (deviceIt == configFilemap.end()) {
    std::string errorMsg =
        string_format("%s: must specify a device: 'gpu' or 'cpu'.\n", __func__);
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, errorMsg);
  }

  {
    using namespace backend_selection;
    const BackendType preferredBackend =
        preferredBackendTypeFromString(deviceIt->second);

    const std::optional<MainGpu> mainGpu = tryMainGpuFromMap(configFilemap);

    const std::pair<BackendType, std::string> chosenBackend = chooseBackend(
        preferredBackend,
        LlamaModel::llamaLogCallback,
        mainGpu,
        &metadata_,
        &outAdrenoVersion);

    if (chosenBackend.first == BackendType::GPU) {
      params.mmproj_backend = chosenBackend.second;
#ifdef __ANDROID__
      params.mmproj_use_gpu = false;
#else
      params.mmproj_use_gpu = true;
#endif
      params.split_mode = LLAMA_SPLIT_MODE_NONE;
    } else if (chosenBackend.first == BackendType::CPU) {
      params.mmproj_use_gpu = false;
    } else {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "preferredDeviceFromString: wrong deduced device, must be 'gpu' or "
          "'cpu'.\n");
    }
    configVector.emplace_back("--device");
    configVector.emplace_back(chosenBackend.second);
    configFilemap.erase(deviceIt);
  }

  tuneConfigMap(configFilemap, metadata_, outAdrenoVersion);

  // Handle both reverse-prompt variants
  for (const std::string& key : {"reverse-prompt", "reverse_prompt"}) {
    if (auto iter = configFilemap.find(key); iter != configFilemap.end()) {
      auto listString = iter->second;
      std::vector<std::string> list = split(listString, ',');
      for (const auto& item : list) {
        params.antiprompt.push_back(item);
      }
      configFilemap.erase(iter);
    }
  }

  // transform json config into the format required by llama.cpp
  for (auto& keyValuePair : configFilemap) {
    configVector.push_back(std::string("--") + keyValuePair.first);
    if (!keyValuePair.second.empty()) {
      configVector.push_back(keyValuePair.second);
    }
  }

  auto ctxArg =
      common_params_parser_init(params, LLAMA_EXAMPLE_MAIN, [](int, char**) {});

  // disable warmup run
  params.warmup = false;
  // add model path to  model parameters
  params.model.path = modelPath;

  int size = static_cast<int>(configVector.size());

  std::unordered_map<std::string, common_arg*> argToOptions;
  for (auto& opt : ctxArg.options) {
    for (const auto& arg : opt.args) {
      argToOptions[arg] = &opt;
    }
  }

  // handle config arguments
  auto checkArg = [&](int argIndex) {
    if (argIndex >= size) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          "Expected value for argument");
    }
  };

  for (int argIndex = 0; argIndex < size; argIndex++) {
    const std::string argPrefix = "--";

    std::string arg = configVector.at(argIndex);
    if (arg.starts_with(argPrefix)) {
      std::ranges::replace(arg, '_', '-');
    }
    if (argToOptions.find(arg) == argToOptions.end()) {
      std::string errorMsg =
          string_format("%s: invalid argument: %s\n", __func__, arg.c_str());
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
    auto opt = *argToOptions[arg];
    if (opt.has_value_from_env()) {
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "%s: %s variable is set, but will be overwritten by argument "
              "%s\n",
              __func__,
              opt.env,
              arg.c_str()));
    }
    try {
      if (opt.handler_void != nullptr) {
        opt.handler_void(params);
        continue;
      }

      // arg with single value
      checkArg(argIndex);
      const std::string& val = configVector[++argIndex];
      if (opt.handler_int != nullptr) {
        opt.handler_int(params, std::stoi(val));
        continue;
      }
      if (opt.handler_string != nullptr) {
        opt.handler_string(params, val);
        continue;
      }

      // arg with 2 values
      checkArg(argIndex);
      const std::string& val2 = configVector[++argIndex];
      if (opt.handler_str_str != nullptr) {
        opt.handler_str_str(params, val, val2);
        continue;
      }
    } catch (std::exception& e) {
      std::string errorMsg = string_format(
          "%s: error while handling argument \"%s\": %s\n\n",
          __func__,
          arg.c_str(),
          e.what());
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
  }

  postprocess_cpu_params(params.cpuparams, nullptr);
  postprocess_cpu_params(params.cpuparams_batch, &params.cpuparams);

  postprocess_cpu_params(params.speculative.cpuparams, &params.cpuparams);
  postprocess_cpu_params(
      params.speculative.cpuparams_batch, &params.cpuparams_batch);

  if (!params.kv_overrides.empty()) {
    params.kv_overrides.emplace_back();
    params.kv_overrides.back().key[0] = 0;
  }

  if (!params.tensor_buft_overrides.empty()) {
    params.tensor_buft_overrides.push_back({nullptr, nullptr});
  }

  if (!params.chat_template.empty() &&
      !common_chat_verify_template(params.chat_template, params.use_jinja)) {
    std::string errorMsg = string_format(
        "%s: the supplied chat template is not supported: %s%s\n",
        __func__,
        params.chat_template.c_str(),
        params.use_jinja ? ""
                         : "\nnote: llama.cpp was started without --jinja, "
                           "we only support commonly used templates");
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  constexpr int kMinNCtx = 8;
  if (params.n_ctx != 0 && params.n_ctx < kMinNCtx) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: warning: minimum context size is 8, using minimum size.\n",
            __func__));
    params.n_ctx = kMinNCtx;
  }
  if (params.rope_freq_base != 0.0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: changing RoPE frequency base to %g.\n",
            __func__,
            params.rope_freq_base));
  }
  if (params.rope_freq_scale != 0.0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: scaling RoPE frequency by %g.\n",
            __func__,
            params.rope_freq_scale));
  }
}
// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
std::pair<std::vector<common_chat_msg>, std::vector<common_chat_tool>>
LlamaModel::formatPrompt(const std::string& input) {
  if (input.empty()) {
    llmContext_->resetMedia();
    std::string errorMsg = string_format("%s: empty prompt\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }
  std::vector<common_chat_msg> chatMsgs;
  std::vector<common_chat_tool> tools;

  picojson::value chatJson;
  std::string err = picojson::parse(chatJson, input);

  if (err.empty() && chatJson.is<picojson::array>()) {
    auto& obj = chatJson.get<picojson::array>();

    int addMediaPlaceholder = 0;
    bool isNextUser = false;
    for (const auto& subObj : obj) {
      if (subObj.is<picojson::object>()) {
        picojson::object jsonObj = subObj.get<picojson::object>();

        if (jsonObj.find("type") != jsonObj.end() &&
            jsonObj["type"].get<std::string>() == "function") {
          common_chat_tool tool;
          tool.name = jsonObj["name"].get<std::string>();
          if (jsonObj.find("description") != jsonObj.end()) {
            tool.description = jsonObj["description"].get<std::string>();
          }
          if (jsonObj.find("parameters") != jsonObj.end()) {
            tool.parameters = jsonObj["parameters"].serialize();
          }
          tools.push_back(tool);
          continue;
        }

        common_chat_msg newMsg;
        if (jsonObj.find("role") == jsonObj.end()) {
          const char* errorMsg = "role is required in the input\n";
          throw qvac_errors::StatusError(
              ADDON_ID, toString(NoRoleProvided), errorMsg);
        }
        newMsg.role = jsonObj["role"].get<std::string>();

        if (jsonObj.find("content") == jsonObj.end()) {
          const char* errorMsg = "content is required in the input\n";
          throw qvac_errors::StatusError(
              ADDON_ID, toString(NoContentProvided), errorMsg);
        }
        auto content = jsonObj["content"].get<std::string>();

        if (jsonObj.find("type") != jsonObj.end() &&
            jsonObj["type"].get<std::string>() == "media") {
          if (isTextLlm_) {
            const char* errorMsg = "Media not supported by text-only models";
            throw qvac_errors::StatusError(
                ADDON_ID, toString(MediaNotSupported), errorMsg);
          }

          if (!content.empty()) {
            llmContext_->loadMedia(content);
          }
          addMediaPlaceholder++;
          isNextUser = true;
          continue;
        }
        if (newMsg.role == "user" && isNextUser) {
          isNextUser = false;
          while (addMediaPlaceholder > 0) {
            addMediaPlaceholder--;
            content.insert(0, mtmd_default_marker());
          }
        }
        if (newMsg.role != "user" && isNextUser) {
          llmContext_->resetMedia();
          std::string errorMsg = string_format(
              "%s: Must append a user question after loading "
              "media\n",
              __func__);
          throw qvac_errors::StatusError(
              ADDON_ID, toString(UserMessageNotProvided), errorMsg);
        }
        newMsg.content = content;
        chatMsgs.push_back(newMsg);
      }
    }

    if (addMediaPlaceholder > 0) {
      llmContext_->resetMedia();
      std::string errorMsg =
          string_format("%s: No request for media was made\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(MediaRequestNotProvided), errorMsg);
    }
  }
  if (!err.empty()) {
    llmContext_->resetMedia();
    std::string errorMsg =
        string_format("%s: Invalid input format: %s\n", __func__, err.c_str());
    throw qvac_errors::StatusError(
        ADDON_ID, toString(InvalidInputFormat), errorMsg);
  }
  return {chatMsgs, tools};
}

void LlamaModel::resetState(bool resetStats) {
  llmContext_->setNDiscarded(configuredNDiscarded_);
  llmContext_->resetState(resetStats);
}

std::unique_ptr<LlmContext> LlamaModel::createContext(
    std::string&& projectionPath, common_params& params,
    common_init_result&& llamaInit) {
  if (!projectionPath.empty()) {
    params.mmproj.path = std::move(projectionPath);
    isTextLlm_ = false;
    return std::make_unique<MtmdLlmContext>(params, std::move(llamaInit));
  }
  isTextLlm_ = true;
  return std::make_unique<TextLlmContext>(params, std::move(llamaInit));
}

bool LlamaModel::loadMedia(const std::vector<uint8_t>& input) {
  if (isTextLlm_) {
    QLOG_IF(Priority::ERROR, "Media not supported by text-only models");
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(MediaNotSupported),
        "Media not supported by text-only models");
  }
  llmContext_->loadMedia(input);
  return true;
}
