#include "LlamaModel.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <filesystem>
#include <functional>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#include <common/arg.h>
#include <common/chat.h>
#include <common/common.h>
#include <common/log.h>
#include <ggml-opt.h>
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

LlamaModel::LlamaModel(
    std::string&& modelPath, std::string&& projectionPath,
    std::unordered_map<std::string, std::string>&& configFilemap)
    : loading_context(InitLoader::getLoadingContext("LlamaModel")),
      _shards(GGUFShards::expandGGUFIntoShards(modelPath)) {
  auto thisModelInit = [this](auto&&... args) {
    this->init(std::forward<decltype(args)>(args)...);
  };
  initLoader.init(
      InitLoader::LOADER_TYPE::DELAYED,
      thisModelInit,
      std::move(modelPath),
      std::move(projectionPath),
      std::move(configFilemap));
}
void LlamaModel::init(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    const std::string&& modelPath, const std::string&& projectionPath,
    std::unordered_map<std::string, std::string>&& configFilemapRvalue) {
  std::unordered_map<std::string, std::string> configFilemap =
      std::move(configFilemapRvalue);

  SetVerbosityLevel(configFilemap);

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
  CommonParamsParse(modelPath, configFilemap, params);

  const std::string errorWhenFailed = toString(UnableToLoadModel);
  common_init_result llamaInit = initFromConfig(
      params,
      modelPath,
      singleGgufStreamedFiles,
      _shards,
      loading_context,
      isStreaming,
      AddonID,
      errorWhenFailed);

  llmContext = CreateContext(projectionPath, params, std::move(llamaInit));

  // Apply configured n_discarded if provided (> 0)
  if (configured_n_discarded > 0 && llmContext) {
    llmContext->setNDiscarded(configured_n_discarded);
  }

  if (llmContext) {
    cacheManager.emplace(
        llmContext.get(), configured_n_discarded, [this](bool resetStats) {
          this->ResetState(resetStats);
        });
  }
}

void LlamaModel::initializeBackend(const std::string& backendsDir) {
  backendsHandle_ = LlamaBackendsHandle(backendsDir);
}

void LlamaModel::setWeightsForFile(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& shard) {
  isStreaming = true;
  if (_shards.gguf_files.empty()) {
    // Store it and make it available when `init` is called
    singleGgufStreamedFiles[filename] = std::move(shard);
    return;
  }
  // Asynchronous shard loading
  initLoader.ensureLoadInBackground();
  if (!llama_model_load_fulfill_split_future(
          filename.c_str(), loading_context.c_str(), std::move(shard))) {
    std::string errorMsg = string_format(
        "%s: failed to load model from %s\n", __func__, filename.c_str());

    throw qvac_errors::StatusError(
        AddonID, toString(UnableToLoadModel), errorMsg);
  }
}

bool LlamaModel::isLoaded() { return static_cast<bool>(llmContext); }

llama_context* LlamaModel::getContext() {
  if (!llmContext) {
    return nullptr;
  }
  return llmContext->getCtx();
}

llama_model* LlamaModel::getModel() {
  if (!llmContext) {
    return nullptr;
  }
  return llmContext->getModel();
}

common_params& LlamaModel::getCommonParams() {
  if (!llmContext) {
    throw std::runtime_error("Model context not initialized");
  }
  return llmContext->getParams();
}

void LlamaModel::llamaLogCallback(
    ggml_log_level level, const char* text, void* user_data) {
  // Convert ggml_log_level to QLOG Priority
  Priority priority;
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
    priority = Priority::DEBUG;
    break;
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
  if (llmContext) {
    llmContext->stop();
  }
}

std::any LlamaModel::process(const std::any& input) {
  if (input.type() != typeid(Prompt)) {
    throw qvac_errors::StatusError(
        AddonID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Invalid input type");
  }
  const Prompt& prompt = std::any_cast<const Prompt&>(input);
#ifndef STANDALONE_TEST_BUILD
  if (prompt.finetuningParams.has_value()) {
    return std::any(finetune(*prompt.finetuningParams));
  }
#else
  if (prompt.finetuningParams.has_value()) {
    throw qvac_errors::StatusError(
        AddonID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Finetuning not available in standalone test build");
  }
#endif
  return processPrompt(prompt);
}

std::string LlamaModel::processPrompt(const Prompt& prompt) {
  if (prompt.media.has_value()) {
    LoadMedia(*(prompt.media));
  }

  const std::string& input = prompt.input;
  std::string out;
  std::vector<common_chat_msg> chatMsgs;
  std::vector<common_chat_tool> tools;

  if (prompt.prefill) {
    // Just a PoC. TODO implement actual usage
    QLOG_IF(
        Priority::WARNING,
        "[LlamaModel] processTextWithOutputCallback: Prefill is enabled but "
        "not implemented yet.\n");
  }

  bool isCacheLoaded = false;
  bool shouldResetAfterInference = false;
  if (cacheManager.has_value()) {
    isCacheLoaded = cacheManager->handleCache(
        chatMsgs, tools, input, [this](const std::string& inputPrompt) {
          return this->FormatPrompt(inputPrompt);
        });

    if (cacheManager->isCacheDisabled() ||
        !cacheManager->wasCacheUsedInLastPrompt()) {
      shouldResetAfterInference = true;
    }
  } else {
    auto formatted = FormatPrompt(input);
    chatMsgs = std::move(formatted.first);
    tools = std::move(formatted.second);
    shouldResetAfterInference = true;
  }

  if (chatMsgs.empty() && tools.empty()) {
    QLOG_IF(
        Priority::INFO,
        "No messages to process after session commands - returning early\n");
    return out;
  }

  bool returnEval = true;
  if (tools.empty()) {
    returnEval = llmContext->evalMessage(chatMsgs, isCacheLoaded);
  } else {
    returnEval =
        llmContext->evalMessageWithTools(chatMsgs, tools, isCacheLoaded);
  }

  if (!returnEval) {
    QLOG_IF(
        Priority::DEBUG,
        "Inference was interrupted during prompt evaluation\n");
    return out;
  }

  std::ostringstream oss;
  auto cb = prompt.outputCallback;

  // Capture response either via callback or into `out`
  if (!prompt.outputCallback) {
    cb = [&](const std::string& token) { oss << token; };
  }

  bool generationOk = llmContext->generateResponse(cb);
  if (!generationOk) {
    ResetState();
    std::string errorMsg = string_format("%s: context overflow\n", __func__);
    throw qvac_errors::StatusError(
        AddonID, toString(ContextOverflow), errorMsg);
  }

  if (!prompt.outputCallback) {
    out = oss.str();
  }

  if (shouldResetAfterInference) {
    ResetState(false);
  }

  return out;
}

qvac_lib_inference_addon_cpp::RuntimeStats LlamaModel::runtimeStats() const {
  auto perfData = llama_perf_context(llmContext->getCtx());
  constexpr double K_MILLIS_IN_SECOND = 1000.0;

  double timeToFirstToken = perfData.t_p_eval_ms;
  double tokensPerSecond =
      (perfData.t_eval_ms > 0)
          ? K_MILLIS_IN_SECOND / perfData.t_eval_ms * perfData.n_eval
          : 0.0;

  int32_t generatedTokens = perfData.n_eval;
  int32_t promptTokens = perfData.n_p_eval;
  llama_perf_context_reset(llmContext->getCtx());

  return {
      {"TTFT", timeToFirstToken},
      {"TPS", tokensPerSecond},
      {"CacheTokens", llmContext->getNPast()},
      {"generatedTokens", generatedTokens},
      {"promptTokens", promptTokens}};
}
// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
void LlamaModel::CommonParamsParse(
    const std::string& modelPath,
    std::unordered_map<std::string, std::string>& configFilemap,
    common_params& params) {

  std::vector<std::string> configVector;

  if (auto it = configFilemap.find("tools"); it != configFilemap.end()) {
    std::string tools_val = it->second;
    std::transform(
        tools_val.begin(), tools_val.end(), tools_val.begin(), ::tolower);
    if (tools_val == "true") {
      params.use_jinja = true;
      // Remove "tools" from config, since using jinja
      configFilemap.erase(it);
    } else {
      configFilemap.erase(it);
    }
  }
  if (auto jit = configFilemap.find("jinja"); jit != configFilemap.end()) {
    // Remove "jinja" from config
    configFilemap.erase(jit);
  }

  // parse custom n_discarded from config (apply only if > 0)
  if (auto it = configFilemap.find("n_discarded"); it != configFilemap.end()) {
    try {
      long long parsed = std::stoll(it->second);
      if (parsed > 0) {
        configured_n_discarded = static_cast<llama_pos>(parsed);
      }
    } catch (...) {
      std::string errorMsg = string_format(
          "%s: invalid n_discarded value: %s\n", __func__, it->second.c_str());
      throw qvac_errors::StatusError(
          AddonID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
    configFilemap.erase(it);
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
    const BackendType PREFERRED_BACKEND =
        preferredBackendTypeFromString(deviceIt->second);

    const std::optional<MainGpu> mainGpu = tryMainGpuFromMap(configFilemap);

    const std::pair<BackendType, std::string> CHOSEN_BACKEND =
        chooseBackend(PREFERRED_BACKEND, LlamaModel::llamaLogCallback, mainGpu);

    if (CHOSEN_BACKEND.first == BackendType::GPU) {
#ifdef __ANDROID__
      params.mmproj_use_gpu = false;
#else
      params.mmproj_use_gpu = true;
#endif
      params.split_mode = LLAMA_SPLIT_MODE_NONE;
    } else if (CHOSEN_BACKEND.first == BackendType::CPU) {
      params.mmproj_use_gpu = false;
    } else {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "preferredDeviceFromString: wrong deduced device, must be 'gpu' or "
          "'cpu'.\n");
    }
    configVector.emplace_back("--device");
    configVector.emplace_back(CHOSEN_BACKEND.second);
    configFilemap.erase(deviceIt);
  }

  // Handle both reverse-prompt variants
  for (const std::string& key : {"reverse-prompt", "reverse_prompt"}) {
    if (auto it = configFilemap.find(key); it != configFilemap.end()) {
      auto listString = it->second;
      std::vector<std::string> list = split(listString, ',');
      for (const auto& item : list) {
        params.antiprompt.push_back(item);
      }
      configFilemap.erase(it);
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
          AddonID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          "Expected value for argument");
    }
  };

  for (int argIndex = 0; argIndex < size; argIndex++) {
    const std::string ARG_PREFIX = "--";

    std::string arg = configVector.at(argIndex);
    if (arg.compare(0, ARG_PREFIX.size(), ARG_PREFIX) == 0) {
      std::replace(arg.begin(), arg.end(), '_', '-');
    }
    if (argToOptions.find(arg) == argToOptions.end()) {
      std::string errorMsg =
          string_format("%s: invalid argument: %s\n", __func__, arg.c_str());
      throw qvac_errors::StatusError(
          AddonID,
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
      std::string val = configVector[++argIndex];
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
      std::string val2 = configVector[++argIndex];
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
          AddonID,
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
        AddonID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  constexpr int K_MIN_N_CTX = 8;
  if (params.n_ctx != 0 && params.n_ctx < K_MIN_N_CTX) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: warning: minimum context size is 8, using minimum size.\n",
            __func__));
    params.n_ctx = K_MIN_N_CTX;
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
LlamaModel::FormatPrompt(const std::string& input) {
  if (input.empty()) {
    llmContext->resetMedia();
    std::string errorMsg = string_format("%s: empty prompt\n", __func__);
    throw qvac_errors::StatusError(AddonID, toString(EmptyPrompt), errorMsg);
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
              AddonID, toString(NoRoleProvided), errorMsg);
        }
        newMsg.role = jsonObj["role"].get<std::string>();

        if (jsonObj.find("content") == jsonObj.end()) {
          const char* errorMsg = "content is required in the input\n";
          throw qvac_errors::StatusError(
              AddonID, toString(NoContentProvided), errorMsg);
        }
        auto content = jsonObj["content"].get<std::string>();

        if (jsonObj.find("type") != jsonObj.end() &&
            jsonObj["type"].get<std::string>() == "media") {
          if (isTextLlm) {
            const char* errorMsg = "Media not supported by text-only models";
            throw qvac_errors::StatusError(
                AddonID, toString(MediaNotSupported), errorMsg);
          }

          if (!content.empty()) {
            llmContext->loadMedia(content);
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
          llmContext->resetMedia();
          std::string errorMsg = string_format(
              "%s: Must append a user question after loading "
              "media\n",
              __func__);
          throw qvac_errors::StatusError(
              AddonID, toString(UserMessageNotProvided), errorMsg);
        }
        newMsg.content = content;
        chatMsgs.push_back(newMsg);
      }
    }

    if (addMediaPlaceholder > 0) {
      llmContext->resetMedia();
      std::string errorMsg =
          string_format("%s: No request for media was made\n", __func__);
      throw qvac_errors::StatusError(
          AddonID, toString(MediaRequestNotProvided), errorMsg);
    }
  }
  if (!err.empty()) {
    llmContext->resetMedia();
    std::string errorMsg =
        string_format("%s: Invalid input format: %s\n", __func__, err.c_str());
    throw qvac_errors::StatusError(
        AddonID, toString(InvalidInputFormat), errorMsg);
  }
  return {chatMsgs, tools};
}

void LlamaModel::ResetState(bool resetStats) {
  llmContext->setNDiscarded(configured_n_discarded);
  llmContext->resetState(resetStats);
}

std::unique_ptr<LlmContext> LlamaModel::CreateContext(
    const std::string& projectionPath, common_params& params,
    common_init_result&& llamaInit) {
  if (!projectionPath.empty()) {
    params.mmproj.path = projectionPath;
    isTextLlm = false;
    return std::make_unique<MtmdLlmContext>(params, std::move(llamaInit));
  }
  isTextLlm = true;
  return std::make_unique<TextLlmContext>(params, std::move(llamaInit));
}

bool LlamaModel::LoadMedia(const std::vector<uint8_t>& input) {
  if (isTextLlm) {
    QLOG_IF(Priority::ERROR, "Media not supported by text-only models");
    throw qvac_errors::StatusError(
        AddonID,
        toString(MediaNotSupported),
        "Media not supported by text-only models");
  }
  llmContext->loadMedia(input);
  return true;
}

#ifndef STANDALONE_TEST_BUILD
std::string LlamaModel::finetune(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params) {
  using namespace llama_finetuning_helpers;

  llama_context* ctx = getContext();
  llama_model* mdl = getModel();
  if (ctx == nullptr || mdl == nullptr) {
    std::string errorMsg =
        "Finetune error: model/context not available. Call activate() first.";
    QLOG_IF(Priority::ERROR, errorMsg);
    return "ERROR";
  }

  try {

    validateFinetuningParams(params);

    std::filesystem::path checkpointDir =
        params.checkpointSaveDir.empty()
            ? std::filesystem::path{"./checkpoints"}
            : std::filesystem::path{params.checkpointSaveDir};
    bool allowResumeFromPause = pauseCheckpointExists(checkpointDir);
    if (allowResumeFromPause) {
      clearPauseRequest();
    }

    auto dataset = prepareTrainingDataset(params);
    std::unique_ptr<
        std::remove_pointer_t<ggml_opt_dataset_t>,
        decltype(&ggml_opt_dataset_free)>
        datasetPtr(dataset, ggml_opt_dataset_free);

    const int64_t datasetSampleCount = ggml_opt_dataset_ndata(datasetPtr.get());
    if (datasetSampleCount <= 0) {
      throw std::runtime_error(
          "Unable to build training dataset from provided corpus");
    }

    const int64_t ctxSize = llama_n_ctx(ctx);
    const int64_t sequenceLength =
        params.contextLength > 0
            ? std::clamp<int64_t>(params.contextLength, int64_t{8}, ctxSize)
            : std::max<int64_t>(ctxSize / 2, 8);
    const int64_t microBatchSize =
        params.microBatchSize > 0 ? params.microBatchSize : 1;

    const int64_t requestedMicroBatch =
        microBatchSize > 0 ? microBatchSize : int64_t{1};
    int64_t actualMicroBatch =
        std::min<int64_t>(requestedMicroBatch, datasetSampleCount);
    actualMicroBatch = std::max<int64_t>(
        int64_t{1}, std::gcd(datasetSampleCount, actualMicroBatch));

    double validationSplit = 0.05;
    const std::string evalPath = !params.evalDatasetPath.empty()
                                     ? params.evalDatasetPath
                                     : params.evalDatasetDir;
    const bool hasSeparateEvalDataset =
        !evalPath.empty() && evalPath != params.trainDatasetDir;
    if (params.useEvalDatasetForValidation && hasSeparateEvalDataset) {
      validationSplit = 0.0;
    } else if (hasSeparateEvalDataset) {
      validationSplit = 0.0;
    } else {
      validationSplit = std::clamp(params.validationSplit, 0.0, 1.0);
    }

    int64_t trainSplit = datasetSampleCount;
    int64_t evalSplit = 0;
    if (validationSplit > 0.0 && datasetSampleCount > 1) {
      const double rawTrain =
          static_cast<double>(datasetSampleCount) * (1.0 - validationSplit);
      trainSplit = static_cast<int64_t>(std::floor(rawTrain));
      trainSplit =
          std::clamp<int64_t>(trainSplit, int64_t{1}, datasetSampleCount);
      evalSplit = datasetSampleCount - trainSplit;
    }

    std::ostringstream datasetInfo;
    datasetInfo << "Finetune dataset prepared | mode="
                << (params.assistantLossOnly ? "sft" : "causal")
                << " | sequenceLength=" << sequenceLength
                << " | samples=" << datasetSampleCount
                << " | trainSplit=" << trainSplit
                << " | evalSplit=" << evalSplit
                << " | microBatch=" << actualMicroBatch;
    QLOG_IF(Priority::DEBUG, datasetInfo.str());

    if (actualMicroBatch != requestedMicroBatch) {
      std::ostringstream microBatchMsg;
      microBatchMsg << "Requested microBatch=" << requestedMicroBatch
                    << " but using " << actualMicroBatch
                    << " due to dataset size";
      QLOG_IF(Priority::WARNING, microBatchMsg.str());
    }

    const int64_t stepsPerEpoch = std::max<int64_t>(int64_t{1}, trainSplit);
    const int64_t totalSteps = std::max<int64_t>(
        int64_t{1},
        static_cast<int64_t>(params.numberOfEpochs) * stepsPerEpoch);

    auto schedulerState = createLrScheduler(params, totalSteps);

    CheckpointMetadata resumeMeta{};
    bool resumingFromPause = false;
    std::filesystem::path pausePath;

    if (allowResumeFromPause) {
      pausePath =
          llama_finetuning_helpers::findLatestPauseCheckpoint(checkpointDir);

      if (!pausePath.empty() && pauseCheckpointExists(checkpointDir)) {
        const auto metadataPath = pausePath / "metadata.json";
        if (parseCheckpointMetadata(metadataPath, resumeMeta)) {
          resumingFromPause = true;
          std::ostringstream resumeMsg;
          resumeMsg << "Resuming training from checkpoint: "
                    << pausePath.string() << " | epoch "
                    << (resumeMeta.epoch + 1) << " | expected next batch: "
                    << (resumeMeta.globalStep + 1);
          QLOG_IF(Priority::DEBUG, resumeMsg.str());
        } else {
          QLOG_IF(
              Priority::WARNING,
              "Failed to parse checkpoint metadata, starting fresh");
        }
      }
    }

    uint32_t targetModules = resumingFromPause
                                 ? resumeMeta.targetModules
                                 : parseLoraModules(params.loraModules);
    llama_adapter_lora* adapter = nullptr;
    if (resumingFromPause) {
      llama_lora_training_params loraParams{
          targetModules,
          static_cast<int32_t>(resumeMeta.loraRank),
          resumeMeta.loraAlpha,
          static_cast<float>(params.loraDropout),
          static_cast<float>(params.loraInitStd)};
      adapter = llama_lora_training_init(ctx, mdl, &loraParams);
      if (adapter == nullptr) {
        throw std::runtime_error(
            "LoRA training initialization failed when resuming");
      }

      const auto adapterPath = pausePath / "model.gguf";
      if (!std::filesystem::exists(adapterPath)) {
        std::string errorMsg =
            "Checkpoint adapter file not found: " + adapterPath.string();
        QLOG_IF(Priority::ERROR, errorMsg);
        throw std::runtime_error(errorMsg);
      }
    } else {
      initializeLoraAdapter(params, targetModules, adapter);
    }
    std::unique_ptr<llama_adapter_lora, decltype(&llama_adapter_lora_free)>
        adapterPtr(adapter, llama_adapter_lora_free);

    pausedCheckpointState_.reset();
    currentCheckpointState_.store(nullptr, std::memory_order_release);

    auto checkpointState = initializeCheckpointing(
        params, adapterPtr.get(), &schedulerState);

    if (checkpointState) {
      if (resumingFromPause) {
        checkpointState->globalStep = resumeMeta.globalStep;
        checkpointState->currentEpoch = resumeMeta.epoch;
        if (checkpointState->scheduler) {
          checkpointState->scheduler->currentStep = resumeMeta.currentStep;
        }
        checkpointState->expectedFirstBatchAfterResume =
            resumeMeta.globalStep + 1;
        checkpointState->firstBatchAfterResumeLogged = false;

        const int64_t stepsPerEpoch = std::max<int64_t>(int64_t{1}, trainSplit);
        const int64_t batchOffset = (resumeMeta.globalStep - 1) % stepsPerEpoch;
        checkpointState->batchOffsetWithinEpoch = batchOffset;
        checkpointState->skippingBatches = (batchOffset > 0);

        if (batchOffset > 0) {
          std::ostringstream batchOffsetMsg;
          batchOffsetMsg << "Resuming from batch " << (batchOffset + 1) << "/"
                         << trainSplit << " within epoch "
                         << (resumeMeta.epoch + 1);
          QLOG_IF(Priority::DEBUG, batchOffsetMsg.str());
        }
      }
    }

    configureOptimizer(
        params,
        adapterPtr.get(),
        schedulerState,
        checkpointState.get(),
        resumingFromPause);

    if (resumingFromPause) {
      QLOG_IF(Priority::DEBUG, "Checkpoint loaded successfully");
    }

    if (resumingFromPause && checkpointState) {
      clearPauseCheckpoint(checkpointState->checkpointDir);
    }

    if (checkpointState) {
      checkpointState->pauseWaitDone.store(false);
      currentCheckpointState_.store(
          checkpointState.get(), std::memory_order_release);
      setCurrentCheckpointState(checkpointState.get());
    }

    int64_t evalDatasetSampleCount = 0;
    std::unique_ptr<
        std::remove_pointer_t<ggml_opt_dataset_t>,
        decltype(&ggml_opt_dataset_free)>
        evalDatasetPtr(nullptr, ggml_opt_dataset_free);
    if (params.useEvalDatasetForValidation && hasSeparateEvalDataset) {
      evalDatasetPtr.reset(prepareEvalDataset(params));
      evalDatasetSampleCount = ggml_opt_dataset_ndata(evalDatasetPtr.get());
      if (evalDatasetSampleCount <= 0) {
        throw std::runtime_error("Eval dataset has no samples");
      }
      std::ostringstream evalMsg;
      evalMsg << "Eval dataset loaded | samples=" << evalDatasetSampleCount;
      QLOG_IF(Priority::DEBUG, evalMsg.str());
    }

    try {
      executeTrainingLoop(
          params,
          datasetPtr.get(),
          trainSplit,
          evalSplit,
          schedulerState,
          checkpointState.get(),
          resumingFromPause ? resumeMeta.epoch : 0,
          resumingFromPause,
          evalDatasetPtr.get(),
          evalDatasetSampleCount);
    } catch (...) {
      if (checkpointState) {
        checkpointState->pauseWaitDone.store(true);
        checkpointState->pauseDoneCv.notify_all();
      }
      throw;
    }

    bool wasPaused = checkpointState && checkpointState->shouldExit.load() &&
                     checkpointState->pauseCheckpointSaved.load();

    if (checkpointState) {
      checkpointState->isIdle.store(true);
      checkpointState->isFinetuning.store(false);
      if (!wasPaused) {
        checkpointState->isPaused.store(false);
      }
      checkpointState->pauseWaitDone.store(true);
      checkpointState->pauseDoneCv.notify_all();
      clearCurrentCheckpointState();
      if (wasPaused) {
        pausedCheckpointState_ = std::move(checkpointState);
      } else {
        currentCheckpointState_.store(nullptr, std::memory_order_release);
        pausedCheckpointState_.reset();
      }
    }

    if (!wasPaused) {
      saveLoraAdapter(adapterPtr.get(), params);

      const auto adapterPath =
          llama_finetuning_helpers::resolveAdapterOutputPath(params);
      QLOG_IF(Priority::DEBUG, "LoRA adapter saved to: " + adapterPath);
      QLOG_IF(Priority::DEBUG, "Finetune completed successfully");
    }
    const std::string status = wasPaused ? "PAUSED" : "COMPLETED";
    return status;
  } catch (const std::exception& ex) {
    auto* state = getCurrentCheckpointState();
    if (state)
      state->setIdle();
    if (pausedCheckpointState_)
      pausedCheckpointState_->setIdle();
    llama_finetuning_helpers::clearCurrentCheckpointState();
    currentCheckpointState_.store(nullptr, std::memory_order_release);
    QLOG_IF(Priority::ERROR, std::string{"Finetune error: "} + ex.what());
    return "ERROR";
  }
}

void LlamaModel::validateFinetuningParams(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params) {
  using namespace llama_finetuning_helpers;

  const uint32_t targetModules = parseLoraModules(params.loraModules);
  if (targetModules == 0) {
    throw std::runtime_error("No valid LoRA target modules selected");
  }

  if (params.loraRank <= 0) {
    throw std::runtime_error("LoRA rank must be greater than zero");
  }

  if (params.loraAlpha <= 0.0) {
    throw std::runtime_error("LoRA alpha must be greater than zero");
  }

  if (params.loraInitStd < 0.0) {
    throw std::runtime_error("LoRA init_std must be non-negative");
  }

  if (params.learningRate <= 0.0) {
    throw std::runtime_error("Learning rate must be positive");
  }
}

ggml_opt_dataset_t LlamaModel::prepareDatasetFromPath(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    const std::string& datasetPath, const char* errorLabel,
    const char* constructKind) {
  using namespace llama_finetuning_helpers;

  llama_context* ctx = getContext();
  if (ctx == nullptr) {
    throw std::runtime_error("Context not available");
  }

  const int64_t ctxSize = llama_n_ctx(ctx);
  const int64_t sequenceLength =
      params.contextLength > 0
          ? std::clamp<int64_t>(params.contextLength, int64_t{8}, ctxSize)
          : std::max<int64_t>(ctxSize / 2, 8);

  int64_t datasetStride = -1;
  ggml_opt_dataset_t datasetRaw = nullptr;

  if (params.assistantLossOnly) {
    const std::string jsonContent = readTextFile(datasetPath);
    datasetRaw = common_opt_sft_dataset_init(
        ctx, jsonContent, datasetStride, params.chatTemplatePath);
  } else {
    datasetStride = std::max<int64_t>(sequenceLength / 2, int64_t{1});
    auto tokens = tokenizeDataset(ctx, datasetPath);
    const int64_t availableTokens = static_cast<int64_t>(tokens.size());
    if (availableTokens <= sequenceLength) {
      throw std::runtime_error(
          std::string(errorLabel) + " dataset does not contain enough tokens "
                                    "for the selected context length");
    }
    const int64_t maxDatasetOffset = availableTokens - sequenceLength - 1;
    if (maxDatasetOffset < datasetStride) {
      throw std::runtime_error(
          std::string(errorLabel) +
          " dataset does not contain enough tokens for the selected stride");
    }
    datasetRaw = buildNextTokenDataset(tokens, sequenceLength, datasetStride);
  }

  if (datasetRaw == nullptr) {
    throw std::runtime_error(
        std::string("Unable to construct ") + constructKind + " dataset");
  }
  return datasetRaw;
}

ggml_opt_dataset_t LlamaModel::prepareTrainingDataset(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params) {
  return prepareDatasetFromPath(
      params, params.trainDatasetDir, "Training", "finetuning");
}

ggml_opt_dataset_t LlamaModel::prepareEvalDataset(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params) {
  const std::string path = !params.evalDatasetPath.empty()
                               ? params.evalDatasetPath
                               : params.evalDatasetDir;
  return prepareDatasetFromPath(params, path, "Eval", "eval");
}

void LlamaModel::initializeLoraAdapter(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    uint32_t targetModules, llama_adapter_lora*& adapter) {
  llama_context* ctx = getContext();
  llama_model* mdl = getModel();
  if (ctx == nullptr || mdl == nullptr) {
    throw std::runtime_error("Model/context not available");
  }

  llama_lora_training_params loraParams{
      targetModules,
      params.loraRank,
      static_cast<float>(params.loraAlpha),
      static_cast<float>(params.loraDropout),
      static_cast<float>(params.loraInitStd)};

  adapter = llama_lora_training_init(ctx, mdl, &loraParams);
  if (adapter == nullptr) {
    std::string errorMsg =
        "LoRA training initialization failed. Parameters: "
        "targetModules=" +
        std::to_string(targetModules) +
        ", loraRank=" + std::to_string(params.loraRank) +
        ", loraAlpha=" + std::to_string(params.loraAlpha) +
        ", loraDropout=" + std::to_string(params.loraDropout) +
        ", loraInitStd=" + std::to_string(params.loraInitStd);
    throw std::runtime_error(errorMsg);
  }
}

llama_finetuning_helpers::LoraLrSchedulerState LlamaModel::createLrScheduler(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    int64_t totalSteps) {
  using namespace llama_finetuning_helpers;

  LoraLrScheduleType scheduleType;
  if (!parseLrScheduler(params.lrScheduler, scheduleType)) {
    throw std::runtime_error(
        "Unknown learning-rate scheduler: " + params.lrScheduler);
  }

  LoraLrSchedulerState schedulerState{};
  schedulerState.schedule = scheduleType;
  schedulerState.lrInit = static_cast<float>(params.learningRate);
  schedulerState.lrMin = static_cast<float>(params.lrMin);
  schedulerState.weightDecay = static_cast<float>(params.weightDecay);
  schedulerState.totalSteps = totalSteps;

  if (params.warmupStepsSet) {
    schedulerState.warmupSteps =
        std::clamp<int64_t>(params.warmupSteps, 0, schedulerState.totalSteps);
  } else if (params.warmupRatioSet) {
    schedulerState.warmupSteps = static_cast<int64_t>(
        static_cast<double>(schedulerState.totalSteps) * params.warmupRatio);
    schedulerState.warmupSteps = std::clamp<int64_t>(
        schedulerState.warmupSteps, 0, schedulerState.totalSteps);
  }
  schedulerState.warmupRatio =
      schedulerState.totalSteps == 0
          ? 0.0f
          : static_cast<float>(schedulerState.warmupSteps) /
                static_cast<float>(schedulerState.totalSteps);

  return schedulerState;
}

std::unique_ptr<llama_finetuning_helpers::TrainingCheckpointState>
LlamaModel::initializeCheckpointing(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    llama_adapter_lora* adapter,
    llama_finetuning_helpers::LoraLrSchedulerState* scheduler) {
  using namespace llama_finetuning_helpers;

  bool periodicCheckpointingEnabled = params.checkpointSaveSteps > 0;

  llama_context* ctx = getContext();
  llama_model* mdl = getModel();
  if (ctx == nullptr || mdl == nullptr) {
    return nullptr;
  }

  auto checkpointState = std::make_unique<TrainingCheckpointState>();
  checkpointState->ctx = ctx;
  checkpointState->model = mdl;
  checkpointState->adapter = adapter;
  checkpointState->checkpointInterval =
      periodicCheckpointingEnabled
          ? std::max<int64_t>(
                int64_t{1}, static_cast<int64_t>(params.checkpointSaveSteps))
          : 0; // 0 means only pause/resume checkpoints, no periodic ones
  checkpointState->checkpointDir =
      params.checkpointSaveDir.empty()
          ? std::filesystem::path{"./checkpoints"}
          : std::filesystem::path{params.checkpointSaveDir};
  checkpointState->scheduler = scheduler;
  checkpointState->loraRank = params.loraRank;
  checkpointState->loraAlpha = static_cast<float>(params.loraAlpha);
  checkpointState->targetModules = parseLoraModules(params.loraModules);
  checkpointState->globalStep = 0;

  std::error_code dirErr;
  std::filesystem::create_directories(checkpointState->checkpointDir, dirErr);
  if (dirErr) {
    std::ostringstream msg;
    msg << "Checkpointing disabled | directory='"
        << checkpointState->checkpointDir.string()
        << "' | error=" << dirErr.message();
    QLOG_IF(Priority::WARNING, msg.str());
    return nullptr;
  }

  if (periodicCheckpointingEnabled) {
    std::ostringstream msg;
    msg << "Checkpointing enabled | dir=" << checkpointState->checkpointDir.string()
        << " | interval=" << checkpointState->checkpointInterval;
    QLOG_IF(Priority::DEBUG, msg.str());
  } else {
    std::ostringstream msg;
    msg << "Pause/resume checkpointing enabled | dir="
        << checkpointState->checkpointDir.string();
    QLOG_IF(Priority::DEBUG, msg.str());
  }

  return checkpointState;
}

void LlamaModel::configureOptimizer(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    llama_adapter_lora* adapter,
    llama_finetuning_helpers::LoraLrSchedulerState& scheduler,
    llama_finetuning_helpers::TrainingCheckpointState* checkpointState,
    bool loadOptimizerState) {
  using namespace llama_finetuning_helpers;

  llama_context* ctx = getContext();
  llama_model* mdl = getModel();
  if (ctx == nullptr || mdl == nullptr) {
    throw std::runtime_error("Model/context not available");
  }

  llama_opt_params optParams{};
  optParams.n_ctx_train = 0;
  optParams.param_filter = llama_opt_param_filter_lora;
  optParams.param_filter_ud = adapter;
  optParams.get_opt_pars = schedulerOptimizerParams;
  optParams.get_opt_pars_ud = &scheduler;
  optParams.optimizer_type = GGML_OPT_OPTIMIZER_TYPE_ADAMW;

  std::string checkpointPathStr;
  if (loadOptimizerState && checkpointState) {
    const auto checkpointPath =
        llama_finetuning_helpers::findLatestPauseCheckpoint(
            checkpointState->checkpointDir);
    if (!checkpointPath.empty() && std::filesystem::exists(checkpointPath)) {
      checkpointPathStr = checkpointPath.string();
      optParams.checkpoint_path = checkpointPathStr.c_str();
      optParams.load_optimizer_state = true;

      // Verify optimizer.gguf exists in checkpoint directory
      const auto optimizerPath = checkpointPath / "optimizer.gguf";
      if (std::filesystem::exists(optimizerPath)) {
        QLOG_IF(
            Priority::DEBUG,
            "Optimizer checkpoint found: " + optimizerPath.string());
      } else {
        QLOG_IF(
            Priority::WARNING,
            "Optimizer checkpoint missing: " + optimizerPath.string());
      }
    } else {
      optParams.checkpoint_path = nullptr;
      optParams.load_optimizer_state = false;
    }
  } else {
    optParams.checkpoint_path = nullptr;
    optParams.load_optimizer_state = false;
  }

  optParams.assistant_loss_only = params.assistantLossOnly;

  llama_opt_cleanup(ctx);

  llama_opt_init(ctx, mdl, optParams);
  optimizerInitialized_ = true;
}

void LlamaModel::executeTrainingLoop(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    ggml_opt_dataset_t dataset, int64_t trainSplit, int64_t evalSplit,
    llama_finetuning_helpers::LoraLrSchedulerState& scheduler,
    llama_finetuning_helpers::TrainingCheckpointState* checkpointState,
    uint32_t startEpoch, bool resumingFromPause, ggml_opt_dataset_t evalDataset,
    int64_t evalDatasetSampleCount) {
  using namespace llama_finetuning_helpers;
  using OptResultPtr = std::unique_ptr<
      std::remove_pointer_t<ggml_opt_result_t>,
      decltype(&ggml_opt_result_free)>;

  llama_context* ctx = getContext();
  if (ctx == nullptr) {
    throw std::runtime_error("Context not available");
  }

  OptResultPtr trainResult(ggml_opt_result_init(), ggml_opt_result_free);
  OptResultPtr evalResult(nullptr, ggml_opt_result_free);
  const bool hasEval =
      evalSplit > 0 || (evalDataset != nullptr && evalDatasetSampleCount > 0);
  if (hasEval) {
    evalResult.reset(ggml_opt_result_init());
  }

  const int64_t idataSplit = trainSplit;
  const bool checkpointEnabled = checkpointState != nullptr;
  const auto callbackTrain = checkpointEnabled
                                 ? optEpochCallbackWrapper
                                 : ggml_opt_epoch_callback_progress_bar;

  for (uint32_t epoch = startEpoch; epoch < params.numberOfEpochs; ++epoch) {
    if (checkpointState && checkpointState->shouldExit.load()) {
      QLOG_IF(Priority::DEBUG, "Training paused");
      break;
    }

    std::ostringstream startMsg;
    startMsg << "Starting finetune epoch " << (epoch + 1) << "/"
             << params.numberOfEpochs;
    QLOG_IF(Priority::DEBUG, startMsg.str());

    if (checkpointEnabled) {
      checkpointState->currentEpoch = static_cast<int32_t>(epoch);
    }

    int64_t resumeFromBatch = -1;
    if (resumingFromPause && checkpointState &&
        checkpointState->batchOffsetWithinEpoch > 0 && epoch == startEpoch) {
      resumeFromBatch = checkpointState->batchOffsetWithinEpoch;
    }

    llama_opt_epoch(
        ctx,
        dataset,
        trainResult.get(),
        evalResult.get(),
        idataSplit,
        callbackTrain,
        evalSplit > 0 ? callbackTrain : nullptr,
        resumeFromBatch);

    if (evalDataset != nullptr && evalDatasetSampleCount > 0 &&
        (!checkpointState || !checkpointState->shouldExit.load())) {
      llama_opt_epoch(
          ctx,
          evalDataset,
          trainResult.get(),
          evalResult.get(),
          0,
          nullptr,
          callbackTrain,
          -1);
    }

    if (!checkpointState || !checkpointState->shouldExit.load()) {
      if (checkpointEnabled) {
        std::cout << "\r";
        std::cout.flush();
      }
      std::cout << std::endl;
      std::cout.flush();
    }

    if (checkpointState && checkpointState->shouldExit.load()) {
      break;
    }

    double lossValue = 0.0;
    ggml_opt_result_loss(trainResult.get(), &lossValue, nullptr);
    std::ostringstream epochMsg;
    epochMsg << "Epoch " << (epoch + 1) << " completed | loss=" << lossValue;
    if (hasEval) {
      double valLoss = 0.0;
      ggml_opt_result_loss(evalResult.get(), &valLoss, nullptr);
      epochMsg << " | val_loss=" << valLoss;
    }
    epochMsg << " | lr=" << scheduler.lastLr;
    QLOG_IF(Priority::DEBUG, epochMsg.str());
    ggml_opt_result_reset(trainResult.get());
    if (hasEval) {
      ggml_opt_result_reset(evalResult.get());
    }
  }

  if (checkpointState && checkpointState->shouldExit.load() &&
      checkpointState->pauseCheckpointSaved.load()) {
    llama_opt_cleanup(ctx);
  }

  if (checkpointState && !checkpointState->shouldExit.load()) {
    clearPauseCheckpoint(checkpointState->checkpointDir);
  }
}

void LlamaModel::saveLoraAdapter(
    llama_adapter_lora* adapter,
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params) {
  using namespace llama_finetuning_helpers;

  llama_model* mdl = getModel();
  if (mdl == nullptr) {
    throw std::runtime_error("Model not available");
  }

  const auto adapterPath = resolveAdapterOutputPath(params);
  if (!llama_lora_save_adapter(adapter, adapterPath.c_str(), mdl)) {
    throw std::runtime_error("Unable to save LoRA adapter to " + adapterPath);
  }
}

llama_finetuning_helpers::TrainingCheckpointState*
LlamaModel::getCurrentCheckpointState() const {
  return currentCheckpointState_.load(std::memory_order_acquire);
}

bool LlamaModel::isFinetuneRunning() const {
  auto* state = getCurrentCheckpointState();
  return state != nullptr &&
         state->isFinetuning.load(std::memory_order_acquire);
}

bool LlamaModel::requestPause() {
  auto* state = getCurrentCheckpointState();
  if (state == nullptr) {
    return false;
  }
  state->pauseRequested.store(true);
  llama_context* ctx = getContext();
  if (ctx != nullptr) {
    llama_opt_request_stop(ctx);
  }
  return true;
}

void LlamaModel::waitUntilFinetuningPauseComplete() {
  auto* state = getCurrentCheckpointState();
  if (state == nullptr) {
    return;
  }
  constexpr auto timeout = std::chrono::minutes(5);
  std::unique_lock lock(state->pauseDoneMutex);
  state->pauseDoneCv.wait_for(
      lock, timeout, [state] { return state->pauseWaitDone.load(); });
}

void LlamaModel::clearPauseRequest() {
  pausedCheckpointState_.reset();
  currentCheckpointState_.store(nullptr, std::memory_order_release);

  llama_context* ctx = getContext();
  if (ctx != nullptr) {
    llama_opt_reset_stop(ctx);
  }
}

#endif // STANDALONE_TEST_BUILD
