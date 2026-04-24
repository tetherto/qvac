#include "LlamaModel.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cinttypes>
#include <cmath>
#include <cstddef>
#include <filesystem>
#include <functional>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <numeric>
#include <shared_mutex>
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
#include <ggml-backend.h>
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
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ScopeGuard.hpp"
#include "utils/SharedSnapshot.hpp"

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
    const ModelMetaData& metadata, const std::optional<int>& adrenoVersion,
    const FinetuneConfigOverrides& finetuneOverrides) {

  const bool isFinetuning = finetuneOverrides.active;

  auto notUserSet = [&](const char* hyphenKey, const char* underscoreKey) {
    return configFilemap.find(hyphenKey) == configFilemap.end() &&
           configFilemap.find(underscoreKey) == configFilemap.end();
  };

  const bool isBitnet =
      metadata.hasOneBitQuantization() &&
      metadata.tryGetString("general.architecture") == "bitnet";

  if (isFinetuning) {
    configFilemap.erase("ctx_size");
    configFilemap["ctx-size"] = std::to_string(finetuneOverrides.contextLength);
    configFilemap.erase("batch_size");
    configFilemap["batch-size"] = std::to_string(finetuneOverrides.batchSize);
    configFilemap.erase("ubatch_size");
    configFilemap["ubatch-size"] =
        std::to_string(finetuneOverrides.microBatchSize);
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[LlamaModel] Finetuning: ctx-size=%" PRId64 " batch-size=%" PRId64
            " ubatch-size=%" PRId64 "\n",
            finetuneOverrides.contextLength,
            finetuneOverrides.batchSize,
            finetuneOverrides.microBatchSize));
  }

  if (isFinetuning) {
    configFilemap.erase("flash_attn");
    configFilemap["flash-attn"] = finetuneOverrides.flashAttn ? "on" : "off";
    QLOG_IF(
        Priority::INFO,
        (finetuneOverrides.flashAttn
             ? "[LlamaModel] Finetuning: enabling flash attention\n"
             : "[LlamaModel] Finetuning: disabling flash attention\n"));
  } else if (isBitnet && notUserSet("flash-attn", "flash_attn")) {
    configFilemap.erase("flash_attn");
    configFilemap["flash-attn"] = "off";
    QLOG_IF(
        Priority::INFO,
        "[LlamaModel] BitNet model detected: disabling flash attention\n");
  }

  constexpr int kAdrenoUbatchThreshold = 800;
  const bool needsUbatch = (isBitnet || isFinetuning) &&
                           adrenoVersion.has_value() &&
                           adrenoVersion.value() >= kAdrenoUbatchThreshold;
  if (needsUbatch) {
    constexpr int64_t kAdrenoUbatchCap = 128;
    if (notUserSet("ubatch-size", "ubatch_size")) {
      configFilemap["ubatch-size"] = std::to_string(kAdrenoUbatchCap);
      QLOG_IF(
          Priority::INFO,
          "[LlamaModel] Adreno 800+ (Vulkan): defaulting ubatch-size=128\n");
    } else {
      const std::string& key =
          configFilemap.count("ubatch-size") ? "ubatch-size" : "ubatch_size";
      int64_t userVal;
      try {
        userVal = std::stoll(configFilemap[key]);
      } catch (const std::exception& e) {
        QLOG_IF(
            Priority::ERROR,
            string_format(
                "[LlamaModel] Adreno 800+ (Vulkan): invalid ubatch-size "
                "\"%s\" (%s), falling back to %" PRId64 "\n",
                configFilemap[key].c_str(),
                e.what(),
                kAdrenoUbatchCap));
        userVal = kAdrenoUbatchCap;
      }
      const int64_t clamped = std::min(userVal, kAdrenoUbatchCap);
      if (clamped < userVal) {
        QLOG_IF(
            Priority::WARNING,
            string_format(
                "[LlamaModel] Adreno 800+ (Vulkan): ubatch-size=%" PRId64
                " exceeds safe maximum %" PRId64 ", clamping to %" PRId64 "\n",
                userVal,
                kAdrenoUbatchCap,
                clamped));
      }
      configFilemap.erase("ubatch_size");
      configFilemap["ubatch-size"] = std::to_string(clamped);
    }
  }

  if (isFinetuning && !finetuneOverrides.gpuSupportsF16OutProd) {
    if (notUserSet("cache-type-k", "cache_type_k")) {
      configFilemap["cache-type-k"] = "f32";
      QLOG_IF(
          Priority::INFO,
          "[LlamaModel] Finetuning: GPU lacks F16 out_prod, using f32 K for KV "
          "cache\n");
    }
    if (notUserSet("cache-type-v", "cache_type_v")) {
      configFilemap["cache-type-v"] = "f32";
      QLOG_IF(
          Priority::INFO,
          "[LlamaModel] Finetuning: GPU lacks F16 out_prod, using f32 V for KV "
          "cache\n");
    }
  }
}

LlamaModel::LlamaModel(
    std::string&& modelPath, std::string&& projectionPath,
    std::unordered_map<std::string, std::string>&& configFilemap)
    : loadingContext_(InitLoader::getLoadingContext("LlamaModel")),
      constructionArgs_{
          std::move(modelPath),
          std::move(projectionPath),
          std::move(configFilemap)} {
  setInitLoader(InitLoader::LOADER_TYPE::DELAYED);
}

void LlamaModel::reload(
    std::optional<FinetuneConfigOverrides> newFinetuneOverrides) {
  {
    std::shared_lock lock(stateMtx_);
    if (state_->asyncWeightsLoader_.isStreaming()) {
      // TODO: Make Fabric support moving/streaming existing loaded tensors
      // TODO: to a different backend.
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(ReloadNotSupportedForStreamedModel),
          "Cannot reload a model that was loaded via streamed shards; "
          "the streamed weights have already been consumed.");
    }
  }
  setInitLoader(InitLoader::LOADER_TYPE::IMMEDIATE, newFinetuneOverrides);
}

void LlamaModel::setInitLoader(
    std::optional<InitLoader::LOADER_TYPE> loaderType,
    std::optional<FinetuneConfigOverrides> newFinetuneOverrides) {
  cancel();
  std::unique_lock lock(stateMtx_);
  if (newFinetuneOverrides.has_value()) {
    pendingFinetuneOverrides_ = *newFinetuneOverrides;
  }
  if (loaderType.has_value()) {
    constructionArgs_.loaderType = loaderType.value();
  }
  state_ = std::make_shared<ReloadableState>(
      constructionArgs_, loadingContext_, metadata_);
  bool callerHoldsLock =
      constructionArgs_.loaderType == InitLoader::LOADER_TYPE::IMMEDIATE;
  state_->initLoader_.init(
      constructionArgs_.loaderType,
      [this, acquireLock = !callerHoldsLock]() { this->init(acquireLock); });
}

void LlamaModel::init(bool acquireLock) {
  SharedSnapshot snap(state_, stateMtx_);
  if (!acquireLock) {
    snap.disable();
  }
  snap.lockRead();

  // Defensive guard: not reachable under normal usage because reload() is
  // only called after waitForLoadInitialization() returns, at which point the
  // delayed init callback has already completed. Protects against a misuse
  // scenario where reload() races with the initial delayed load.
  if (snap->llmContext_) {
    return;
  }

  const auto& modelPath = constructionArgs_.modelPath;
  auto configFilemap = constructionArgs_.configFilemap;

  setVerbosityLevel(configFilemap);

  if (!snap->asyncWeightsLoader_.isStreaming()) {
    if (!snap.promoteToWrite()) {
      return;
    }
    resolveShardPaths(snap->shards_, modelPath);
    snap.demoteToRead();
  }

  metadata_.parse(
      modelPath,
      snap->shards_,
      snap->asyncWeightsLoader_.isStreaming(),
      ADDON_ID);
  {
    auto fileType = metadata_.tryGetU32("general.file_type");
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[LlamaModel] general.file_type = %s\n",
            fileType.has_value() ? std::to_string(*fileType).c_str()
                                 : "unknown"));
  }

  if (!snap.promoteToWrite()) {
    return;
  }

  {
    std::string backendsDir;
    if (auto it = configFilemap.find("backendsDir");
        it != configFilemap.end()) {
      backendsDir = it->second;
      configFilemap.erase(it);
    }
    std::string openclCacheDir;
    if (auto it = configFilemap.find("openclCacheDir");
        it != configFilemap.end()) {
      openclCacheDir = it->second;
      configFilemap.erase(it);
    }
    snap->backendsHandle_ = LlamaBackendsHandle(backendsDir, openclCacheDir);
  }

  common_params params;
  std::optional<int> adrenoVersion;
  ResolvedToolsCompactConfig toolsCompactConfig;
  commonParamsParse(
      modelPath, configFilemap, params, adrenoVersion, toolsCompactConfig);

  const std::string errorWhenFailed = toString(UnableToLoadModel);
  auto streamedFiles =
      snap->asyncWeightsLoader_.extractIndividualStreamedFiles();

  snap.demoteToRead();

  common_init_result llamaInit = initFromConfig(
      params,
      modelPath,
      streamedFiles,
      snap->shards_,
      loadingContext_,
      snap->asyncWeightsLoader_.isStreaming(),
      ADDON_ID,
      errorWhenFailed);

  if (!snap.promoteToWrite()) {
    return;
  }

  // Create tools compact controller before context (contexts hold reference)
  snap->toolsCompact_ =
      std::make_unique<ToolsCompactController>(toolsCompactConfig.profile);

  snap->isTextLlm_ = constructionArgs_.projectionPath.empty();
  snap->llmContext_ = createContext(
      std::string(constructionArgs_.projectionPath),
      params,
      std::move(llamaInit),
      *snap->toolsCompact_);

  if (snap->configuredNDiscarded_ > 0 && snap->llmContext_) {
    snap->llmContext_->setNDiscarded(snap->configuredNDiscarded_);
  }

  if (snap->llmContext_) {
    snap->cacheManager_.emplace(
        snap->llmContext_.get(),
        snap->configuredNDiscarded_,
        [this](bool resetStats) { this->resetState(resetStats); });
  }
}

void LlamaModel::setWeightsForFile(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& shard) {
  std::shared_lock lock(stateMtx_);
  state_->asyncWeightsLoader_.setWeightsForFile(filename, std::move(shard));
}

bool LlamaModel::isLoaded() {
  std::shared_lock lock(stateMtx_);
  return static_cast<bool>(state_->llmContext_);
}

llama_pos LlamaModel::getNPastBeforeTools() const {
  std::shared_lock lock(stateMtx_);
  if (state_->toolsCompact_) {
    return state_->toolsCompact_->anchor();
  }
  return -1;
}

llama_context* LlamaModel::getContext() {
  if (!state_->llmContext_) {
    return nullptr;
  }
  return state_->llmContext_->getCtx();
}

llama_model* LlamaModel::getModel() {
  if (!state_->llmContext_) {
    return nullptr;
  }
  return state_->llmContext_->getModel();
}

common_params& LlamaModel::getCommonParams() {
  if (!state_->llmContext_) {
    throw std::runtime_error("Model context not initialized");
  }
  return state_->llmContext_->getParams();
}

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
  std::shared_lock lock(stateMtx_, std::try_to_lock);
  if (!lock.owns_lock()) {
    // If lock could not be acquired, it means reload
    // is in progress. It would be pointless to cancel
    // after it finishes reloading since there would be
    // nothing executing.
    return;
  }
  cancelImpl();
}

void LlamaModel::cancelImpl() const {
  if (state_ && state_->llmContext_) {
    state_->llmContext_->stop();
  }
}

std::any LlamaModel::process(const std::any& input) {
  std::shared_lock lock(stateMtx_);
  if (input.type() != typeid(Prompt)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Invalid input type");
  }
  validateBitnetQuantization();
  const auto& prompt = std::any_cast<const Prompt&>(input);
#ifndef STANDALONE_TEST_BUILD
  if (prompt.finetuningParams.has_value()) {
    FinetuneTerminalResult::Stats stats{};
    // Release the shared lock before finetune() because reload() inside it
    // acquires an exclusive lock on stateMtx_; safe since JobRunner serialises
    // all jobs onto a single worker thread.
    lock.unlock();
    std::string status =
        finetune(*prompt.finetuningParams, &stats, prompt.progressCallback);
    FinetuneTerminalResult result{"finetune", std::move(status)};
    if (stats.globalSteps > 0 || stats.epochsCompleted > 0) {
      result.stats = stats;
    }
    return std::any(std::move(result));
  }
#else
  if (prompt.finetuningParams.has_value()) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(qvac_errors::general_error::InvalidArgument),
        "Finetuning not available in standalone test build");
  }
#endif
  return processPrompt(prompt);
}

LlamaModel::ResolvedPrompt
LlamaModel::resolveChatAndTools(const Prompt& prompt) {
  ResolvedPrompt resolved;
  if (state_->cacheManager_.has_value()) {
    ParsedPromptPayload parsedPrompt;
    resolved.isCacheLoaded = state_->cacheManager_->handleCache(
        parsedPrompt,
        prompt.input,
        [this](const std::string& inputPrompt) {
          return this->formatPrompt(inputPrompt);
        },
        prompt.cacheKey);
    resolved.chatMsgs = std::move(parsedPrompt.chatMsgs);
    resolved.tools = std::move(parsedPrompt.tools);
    resolved.layout = std::move(parsedPrompt.layout);
    resolved.shouldResetAfterInference =
        state_->cacheManager_->isCacheDisabled() ||
        !state_->cacheManager_->wasCacheUsedInLastPrompt();
  } else {
    ParsedPromptPayload parsedPrompt = formatPrompt(prompt.input);
    resolved.chatMsgs = std::move(parsedPrompt.chatMsgs);
    resolved.tools = std::move(parsedPrompt.tools);
    resolved.layout = std::move(parsedPrompt.layout);
    resolved.shouldResetAfterInference = true;
  }
  return resolved;
}

std::string LlamaModel::processPrompt(const Prompt& prompt) {
  std::shared_lock lock(stateMtx_);
  return processPromptImpl(prompt);
}

std::string LlamaModel::processPromptImpl(const Prompt& prompt) {
  state_->lastRunWasPrefill_ = prompt.prefill;

  // Reset per-inference slide counter so it doesn't leak across runs
  state_->llmContext_->resetNSlides();

  for (const auto& media : prompt.media) {
    loadMedia(media);
  }

  std::string out;
  ResolvedPrompt resolved = resolveChatAndTools(prompt);

  if (resolved.shouldResetAfterInference &&
      state_->llmContext_->getNPast() > 0) {
    resetState(true);
  }

  bool hasKvCacheContext = resolved.isCacheLoaded;
  if (state_->llmContext_->getNPast() > 0) {
    hasKvCacheContext = true;
  }

  state_->toolsCompact_->validatePrompt(
      resolved.chatMsgs, resolved.tools, resolved.layout, hasKvCacheContext);

  if (resolved.chatMsgs.empty() && resolved.tools.empty()) {
    QLOG_IF(Priority::INFO, "No messages to process - returning early\n");
    return out;
  }

  auto restore =
      state_->llmContext_->applyGenerationParams(prompt.generationParams);
  ScopeGuard paramsGuard([&] { restore(); });

  bool evalOk =
      resolved.tools.empty()
          ? state_->llmContext_->evalMessage(
                resolved.chatMsgs, resolved.isCacheLoaded, prompt.prefill)
          : state_->llmContext_->evalMessageWithTools(
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
  bool needsOutputCapture = state_->toolsCompact_->enabled();
  auto callback = prompt.outputCallback;
  if (!prompt.outputCallback) {
    callback = [&](const std::string& token) { oss << token; };
  } else if (needsOutputCapture) {
    callback = [&](const std::string& token) {
      oss << token;
      prompt.outputCallback(token);
    };
  }

  if (!state_->llmContext_->generateResponse(callback)) {
    resetState();
    std::string errorMsg = string_format("%s: context overflow\n", __func__);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextOverflow), errorMsg);
  }

  if (!prompt.outputCallback) {
    out = oss.str();
  }

  // Post-generation tools trim decision via controller
  std::string ossStr;
  if (needsOutputCapture && prompt.outputCallback) {
    // Only materialize a second copy when output streamed via callback.
    ossStr = oss.str();
  }
  const std::string& outputToCheck =
      needsOutputCapture ? (prompt.outputCallback ? ossStr : out) : out;
  auto decision = state_->toolsCompact_->onGenerationComplete(
      outputToCheck,
      state_->llmContext_->getNPast(),
      state_->llmContext_->getFirstMsgTokens());
  if (decision.trim) {
    state_->llmContext_->removeLastNTokens(decision.tokensToRemoveFromTail);
    if (decision.clampFirstMsgTokensToNPast &&
        state_->llmContext_->getFirstMsgTokens() >
            state_->llmContext_->getNPast()) {
      state_->llmContext_->setFirstMsgTokens(state_->llmContext_->getNPast());
    }
  }
  if (prompt.saveCacheToDisk && state_->cacheManager_.has_value() &&
      state_->cacheManager_->hasActiveCache()) {
    state_->cacheManager_->saveCache();
  }

  if (resolved.shouldResetAfterInference) {
    resetState(false);
  }
  return out;
}

qvac_lib_inference_addon_cpp::RuntimeStats LlamaModel::runtimeStats() const {
  std::shared_lock lock(stateMtx_);
  auto perfData = llama_perf_context(state_->llmContext_->getCtx());
  constexpr double kMillisInSecond = 1000.0;

  double timeToFirstToken =
      state_->lastRunWasPrefill_ ? 0.0 : perfData.t_p_eval_ms;
  double tokensPerSecond =
      (!state_->lastRunWasPrefill_ && perfData.t_eval_ms > 0)
          ? kMillisInSecond / perfData.t_eval_ms * perfData.n_eval
          : 0.0;

  int32_t generatedTokens = state_->lastRunWasPrefill_ ? 0 : perfData.n_eval;
  int32_t promptTokens = state_->lastRunWasPrefill_ ? 0 : perfData.n_p_eval;
  llama_perf_context_reset(state_->llmContext_->getCtx());

  int32_t contextSlides = state_->llmContext_->getNSlides();

  return {
      {"TTFT", timeToFirstToken},
      {"TPS", tokensPerSecond},
      {"CacheTokens", state_->llmContext_->getNPast()},
      {"generatedTokens", generatedTokens},
      {"promptTokens", promptTokens},
      {"contextSlides", static_cast<int64_t>(contextSlides)},
      {"backendDevice", runtimeBackendDevice_}};
}

qvac_lib_inference_addon_cpp::RuntimeStats
LlamaModel::runtimeDebugStats() const {
  std::shared_lock lock(stateMtx_);
  const int64_t firstMsgTokens =
      state_->llmContext_
          ? static_cast<int64_t>(state_->llmContext_->getFirstMsgTokens())
          : 0LL;
  auto snapshot = state_->toolsCompact_
                      ? state_->toolsCompact_->debugSnapshot()
                      : ToolsCompactController::DebugSnapshot{};
  return {
      {"nPastBeforeTools", static_cast<int64_t>(snapshot.nPastBeforeTools)},
      {"firstMsgTokens", firstMsgTokens},
      {"toolsTrimmed", snapshot.lastToolsTrimmed ? 1LL : 0LL}};
}

// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
LlamaModel::ResolvedToolsCompactConfig
LlamaModel::resolveToolsCompactConfig(bool toolsCompactRequested) const {
  if (!toolsCompactRequested) {
    return {};
  }

  auto arch = metadata_.tryGetString("general.architecture");
  auto modelName = metadata_.tryGetString("general.name");
  auto marker = qvac_lib_inference_addon_llama::utils::
      selectToolsCompactMarkerForModelMetadata(arch, modelName);

  if (!marker.has_value()) {
    return {
        .resolution = ToolsCompactResolution::RequestedUnsupported,
        .profile = std::nullopt};
  }

  ToolsCompactProfile profile;
  profile.toolCallStartMarker = marker.value();
  return {
      .resolution = ToolsCompactResolution::RequestedSupported,
      .profile = std::move(profile)};
}

// NOLINTNEXTLINE(readability-convert-member-functions-to-static,readability-function-cognitive-complexity)
void LlamaModel::commonParamsParse(
    const std::string& modelPath,
    std::unordered_map<std::string, std::string>& configFilemap,
    common_params& params, std::optional<int>& outAdrenoVersion,
    ResolvedToolsCompactConfig& outToolsCompactConfig) {

  std::vector<std::string> configVector;
  outToolsCompactConfig = ResolvedToolsCompactConfig{};

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
        state_->configuredNDiscarded_ = static_cast<llama_pos>(parsed);
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

  // parse tools_compact flag from config
  bool toolsCompactRequested = false;
  if (auto iter = configFilemap.find("tools_compact");
      iter != configFilemap.end()) {
    std::string val = iter->second;
    std::transform(val.begin(), val.end(), val.begin(), ::tolower);
    toolsCompactRequested = (val == "true");
    configFilemap.erase(iter);
  }

  outToolsCompactConfig = resolveToolsCompactConfig(toolsCompactRequested);
  if (outToolsCompactConfig.resolution ==
      ToolsCompactResolution::RequestedUnsupported) {
    QLOG_IF(
        Priority::WARNING,
        "[LlamaModel] tools_compact is not supported for this model "
        "architecture, ignoring\n");
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
        &outAdrenoVersion,
        pendingFinetuneOverrides_.active);

    if (chosenBackend.first == BackendType::GPU) {
      params.mmproj_backend = chosenBackend.second;
#ifdef __ANDROID__
      params.mmproj_use_gpu = false;
#else
      params.mmproj_use_gpu = true;
#endif
      params.split_mode = LLAMA_SPLIT_MODE_NONE;
      runtimeBackendDevice_ = 1;
    } else if (chosenBackend.first == BackendType::CPU) {
      params.mmproj_use_gpu = false;
      runtimeBackendDevice_ = 0;
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

  tuneConfigMap(
      configFilemap, metadata_, outAdrenoVersion, pendingFinetuneOverrides_);

  // Handle both reverse-prompt variants
  for (const std::string& key : {"reverse-prompt", "reverse_prompt"}) {
    if (auto iter = configFilemap.find(key); iter != configFilemap.end()) {
      auto listString = iter->second;
      std::vector<std::string> list = split(listString, ',');
      for (const auto& item : list) {
        params.antiprompt.push_back(item);
      }
      if (list.empty() && !listString.empty()) {
        params.antiprompt.push_back(listString);
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
  params.training = pendingFinetuneOverrides_.active;
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
ParsedPromptPayload LlamaModel::formatPrompt(const std::string& input) {
  if (input.empty()) {
    state_->llmContext_->resetMedia();
    std::string errorMsg = string_format("%s: empty prompt\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }
  ParsedPromptPayload parsed;
  std::vector<common_chat_msg>& chatMsgs = parsed.chatMsgs;
  std::vector<common_chat_tool>& tools = parsed.tools;

  picojson::value chatJson;
  std::string err = picojson::parse(chatJson, input);

  if (err.empty() && chatJson.is<picojson::array>()) {
    auto& obj = chatJson.get<picojson::array>();

    // Build PromptLayout for tools_compact validation
    PromptLayout layout;
    layout.totalItems = obj.size();

    int addMediaPlaceholder = 0;
    bool isNextUser = false;
    for (size_t i = 0; i < obj.size(); ++i) {
      const auto& subObj = obj[i];
      if (subObj.is<picojson::object>()) {
        picojson::object jsonObj = subObj.get<picojson::object>();

        if (jsonObj.find("type") != jsonObj.end() &&
            jsonObj["type"].get<std::string>() == "function") {
          if (!layout.firstToolIdx.has_value()) {
            layout.firstToolIdx = i;
          }
          layout.lastToolIdx = i;
          layout.toolCount++;

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

        // Track last anchor (user/tool) message index for tools_compact
        if (newMsg.role == "user" || newMsg.role == "tool") {
          layout.lastAnchorIdx = i;
        }

        // Track if the very last array item is a user message
        if (newMsg.role == "user" && i == obj.size() - 1) {
          layout.lastItemIsUserMsg = true;
        }

        if (jsonObj.find("content") == jsonObj.end()) {
          const char* errorMsg = "content is required in the input\n";
          throw qvac_errors::StatusError(
              ADDON_ID, toString(NoContentProvided), errorMsg);
        }
        auto content = jsonObj["content"].get<std::string>();

        if (jsonObj.find("type") != jsonObj.end() &&
            jsonObj["type"].get<std::string>() == "media") {
          if (state_->isTextLlm_) {
            const char* errorMsg = "Media not supported by text-only models";
            throw qvac_errors::StatusError(
                ADDON_ID, toString(MediaNotSupported), errorMsg);
          }

          if (!content.empty()) {
            state_->llmContext_->loadMedia(content);
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
          state_->llmContext_->resetMedia();
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

    parsed.layout = std::move(layout);

    if (addMediaPlaceholder > 0) {
      state_->llmContext_->resetMedia();
      std::string errorMsg =
          string_format("%s: No request for media was made\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(MediaRequestNotProvided), errorMsg);
    }
  }
  if (!err.empty()) {
    state_->llmContext_->resetMedia();
    std::string errorMsg =
        string_format("%s: Invalid input format: %s\n", __func__, err.c_str());
    throw qvac_errors::StatusError(
        ADDON_ID, toString(InvalidInputFormat), errorMsg);
  }
  return parsed;
}

void LlamaModel::resetState(bool resetStats) {
  state_->llmContext_->setNDiscarded(state_->configuredNDiscarded_);
  state_->llmContext_->resetState(resetStats);
}

std::unique_ptr<LlmContext> LlamaModel::createContext(
    std::string&& projectionPath, common_params& params,
    common_init_result&& llamaInit, ToolsCompactController& tools) {
  if (!projectionPath.empty()) {
    params.mmproj.path = std::move(projectionPath);
    return std::make_unique<MtmdLlmContext>(
        params, std::move(llamaInit), tools);
  }
  return std::make_unique<TextLlmContext>(params, std::move(llamaInit), tools);
}

bool LlamaModel::loadMedia(const std::vector<uint8_t>& input) {
  if (state_->isTextLlm_) {
    QLOG_IF(Priority::ERROR, "Media not supported by text-only models");
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(MediaNotSupported),
        "Media not supported by text-only models");
  }
  state_->llmContext_->loadMedia(input);
  return true;
}

bool LlamaModel::isBitnetModel() const {
  return metadata_.hasOneBitQuantization();
}

void LlamaModel::validateBitnetQuantization() {
  llama_model* mdl = getModel();
  if (mdl == nullptr) {
    return;
  }

  char arch[64] = {0};
  int len =
      llama_model_meta_val_str(mdl, "general.architecture", arch, sizeof(arch));
  if (len <= 0 || len >= static_cast<int>(sizeof(arch))) {
    return;
  }

  std::string archStr(arch, static_cast<size_t>(len));
  if (archStr == "bitnet" && !isBitnetModel()) {
    auto fileType = metadata_.tryGetU32("general.file_type");
    throw std::runtime_error(
        "Bitnet models are only supported with TQ1_0 or TQ2_0 quantization "
        "(file_type=" +
        std::to_string(fileType.value_or(0)) + ")");
  }
}

static bool gpuSupportsOutProdF16() {
  ggml_backend_dev_t gpu =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
  if (gpu == nullptr) {
    return true;
  }

  constexpr int64_t ne0 = 4;
  constexpr int64_t ne1 = 3;
  constexpr int64_t k = 2;

  struct ggml_tensor src0 = {};
  struct ggml_tensor src1 = {};
  struct ggml_tensor dst = {};

  src0.type = GGML_TYPE_F16;
  src1.type = GGML_TYPE_F32;
  dst.type = GGML_TYPE_F32;

  src0.ne[0] = ne0;
  src0.ne[1] = k;
  src0.ne[2] = 1;
  src0.ne[3] = 1;
  src1.ne[0] = ne1;
  src1.ne[1] = k;
  src1.ne[2] = 1;
  src1.ne[3] = 1;
  dst.ne[0] = ne0;
  dst.ne[1] = ne1;
  dst.ne[2] = 1;
  dst.ne[3] = 1;

  src0.nb[0] = sizeof(ggml_fp16_t);
  src0.nb[1] = src0.nb[0] * ne0;
  src0.nb[2] = src0.nb[1] * k;
  src0.nb[3] = src0.nb[2];

  src1.nb[0] = sizeof(float);
  src1.nb[1] = src1.nb[0] * ne1;
  src1.nb[2] = src1.nb[1] * k;
  src1.nb[3] = src1.nb[2];

  dst.nb[0] = sizeof(float);
  dst.nb[1] = dst.nb[0] * ne0;
  dst.nb[2] = dst.nb[1] * ne1;
  dst.nb[3] = dst.nb[2];

  dst.op = GGML_OP_OUT_PROD;
  dst.src[0] = &src0;
  dst.src[1] = &src1;

  if (ggml_backend_dev_type(gpu) == GGML_BACKEND_DEVICE_TYPE_GPU &&
      !ggml_backend_dev_supports_op(gpu, &dst)) {
    return false;
  }
  return true;
}

// Finetuning implementation
#ifndef STANDALONE_TEST_BUILD
std::string LlamaModel::finetune(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    FinetuneTerminalResult::Stats* outStats,
    LlamaModel::ProgressCallback progressCallback) {
  using namespace llama_finetuning_helpers;

  validateModelForFinetuning();

  {
    std::shared_lock lock(stateMtx_);
    if (state_->cacheManager_.has_value() &&
        state_->cacheManager_->hasActiveCache()) {
      state_->cacheManager_->saveCache();
    }
  }

  // Always reload: ensures tuneConfigMap applies finetuning-specific config
  // (e.g. flash-attn off, ubatch sizing) and gives a clean llama_context.
  // TODO: investigate recreating the context without a full weights reload
  // to reduce latency when the backend itself does not change.
  reload(FinetuneConfigOverrides{
      .active = true,
      .batchSize = params.batchSize,
      .microBatchSize = params.microBatchSize,
      .contextLength = params.contextLength,
      .gpuSupportsF16OutProd = gpuSupportsOutProdF16(),
      .flashAttn = params.flashAttn});

  llama_context* ctx = getContext();
  llama_model* mdl = getModel();
  if (ctx == nullptr || mdl == nullptr) {
    throw std::runtime_error(
        "Finetune error: model/context not available after reload.");
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
            : std::max<int64_t>(ctxSize, 8);
    const int64_t microBatchSize =
        params.microBatchSize > 0 ? params.microBatchSize : 1;

    const int64_t requestedMicroBatch =
        microBatchSize > 0 ? microBatchSize : int64_t{1};
    int64_t actualMicroBatch =
        std::min<int64_t>(requestedMicroBatch, datasetSampleCount);
    actualMicroBatch = std::max<int64_t>(
        int64_t{1}, std::gcd(datasetSampleCount, actualMicroBatch));

    double validationSplit = 0.05;
    const bool hasSeparateEvalDataset =
        !params.evalDatasetPath.empty() &&
        params.evalDatasetPath != params.trainDatasetDir;
    if (params.useEvalDatasetForValidation && hasSeparateEvalDataset) {
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

    const int64_t ubatchPerSample = std::max<int64_t>(
        int64_t{1},
        static_cast<int64_t>(llama_n_ctx(ctx)) /
            static_cast<int64_t>(llama_n_ubatch(ctx)));
    const int64_t stepsPerEpoch =
        std::max<int64_t>(int64_t{1}, trainSplit * ubatchPerSample);
    // The LR scheduler advances once per optimizer step (once per sample),
    // not once per micro-batch callback, so use trainSplit directly.
    const int64_t schedulerTotalSteps = std::max<int64_t>(
        int64_t{1}, static_cast<int64_t>(params.numberOfEpochs) * trainSplit);

    auto schedulerState = createLrScheduler(params, schedulerTotalSteps);

    CheckpointMetadata resumeMeta{};
    bool resumingFromPause = false;
    std::filesystem::path pausePath;
    uint32_t resumeStartEpoch = 0;
    int64_t resumeBatchCursor = -1;

    if (allowResumeFromPause) {
      pausePath =
          llama_finetuning_helpers::findLatestPauseCheckpoint(checkpointDir);

      if (!pausePath.empty() && pauseCheckpointExists(checkpointDir)) {
        const auto metadataPath = pausePath / "metadata.txt";
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

    llama_adapter_lora* adapter = nullptr;
    if (resumingFromPause) {
      const auto adapterPath = (pausePath / "model.gguf").string();
      adapter = llama_adapter_lora_init(mdl, adapterPath.c_str());
      if (adapter == nullptr) {
        throw std::runtime_error(
            "Failed to load LoRA adapter from checkpoint: " + adapterPath);
      }
      llama_clear_adapter_lora(ctx);
      if (llama_set_adapter_lora(ctx, adapter, 1.0f) < 0) {
        llama_adapter_lora_free(adapter);
        throw std::runtime_error(
            "Failed to attach resumed LoRA adapter to context");
      }
    } else {
      uint32_t targetModules = parseLoraModules(params.loraModules);
      initializeLoraAdapter(params, targetModules, adapter);
    }
    std::unique_ptr<llama_adapter_lora, decltype(&llama_adapter_lora_free)>
        adapterPtr(adapter, llama_adapter_lora_free);

    clearPausedCheckpointStateShared();
    clearCurrentCheckpointStateShared();

    auto checkpointState =
        initializeCheckpointing(params, adapterPtr.get(), &schedulerState);

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
        if (resumeMeta.resumeEpoch >= 0) {
          resumeStartEpoch = static_cast<uint32_t>(resumeMeta.resumeEpoch);
          resumeBatchCursor = resumeMeta.resumeBatch;
        } else {
          resumeStartEpoch = static_cast<uint32_t>(resumeMeta.epoch);
          resumeBatchCursor = -1;
        }
        checkpointState->batchOffsetWithinEpoch = resumeBatchCursor;

        const int64_t epochStartStep =
            static_cast<int64_t>(resumeStartEpoch) * stepsPerEpoch;
        const int64_t ibatchAtPause = resumeMeta.globalStep - epochStartStep;
        const int64_t firstIbatchOnResume =
            (resumeBatchCursor >= 0) ? (resumeBatchCursor + 1) * ubatchPerSample
                                     : 0;
        checkpointState->resumeGlobalStepSkip =
            std::max(int64_t{0}, ibatchAtPause - firstIbatchOnResume);

        std::ostringstream batchOffsetMsg;
        batchOffsetMsg << "Resuming from epoch " << (resumeStartEpoch + 1)
                       << " | idata batch cursor=" << resumeBatchCursor
                       << " | globalStep skip="
                       << checkpointState->resumeGlobalStepSkip;
        QLOG_IF(Priority::DEBUG, batchOffsetMsg.str());

        if (checkpointState->resumeGlobalStepSkip > 0) {
          std::ostringstream skipMsg;
          skipMsg << "Replaying " << checkpointState->resumeGlobalStepSkip
                  << " pre-pause micro-batches";
          QLOG_IF(Priority::INFO, skipMsg.str());
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

    if (checkpointState) {
      checkpointState->pauseWaitDone.store(false);
      checkpointState->progressCallback = progressCallback;
      if (progressCallback) {
        checkpointState->suppressProgressBar = true;
      }
      setCurrentCheckpointStateShared(checkpointState);
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
          resumingFromPause ? resumeStartEpoch : 0,
          resumingFromPause,
          evalDatasetPtr.get(),
          evalDatasetSampleCount,
          outStats);
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
        setPausedCheckpointStateShared(checkpointState);
      } else {
        clearPausedCheckpointStateShared();
      }
      clearCurrentCheckpointStateShared();
    }

    if (!wasPaused) {
      saveLoraAdapter(adapterPtr.get(), params);

      const auto adapterPath =
          llama_finetuning_helpers::resolveAdapterOutputPath(params);
      QLOG_IF(Priority::DEBUG, "LoRA adapter saved to: " + adapterPath);
      QLOG_IF(Priority::DEBUG, "Finetune completed successfully");
    }

    const std::string status = wasPaused ? "PAUSED" : "COMPLETED";
    reload(FinetuneConfigOverrides{});
    return status;
  } catch (...) {
    auto state = getCurrentCheckpointStateShared();
    if (state) {
      state->setIdle();
      state->pauseWaitDone.store(true);
      state->pauseDoneCv.notify_all();
    }
    auto pausedState = getPausedCheckpointStateShared();
    if (pausedState) {
      pausedState->setIdle();
    }
    llama_finetuning_helpers::clearCurrentCheckpointState();
    clearCurrentCheckpointStateShared();
    try {
      reload(FinetuneConfigOverrides{});
    } catch (...) {
      QLOG_IF(Priority::ERROR, "Failed to reload model after finetuning error");
    }
    throw;
  }
}

void LlamaModel::validateModelForFinetuning() {
  auto fileType = metadata_.tryGetU32("general.file_type");
  if (fileType.has_value()) {
    const uint32_t ft = *fileType;
    constexpr std::array<llama_ftype, 6> kSupportedQuants = {
        LLAMA_FTYPE_ALL_F32,
        LLAMA_FTYPE_MOSTLY_F16,
        LLAMA_FTYPE_MOSTLY_Q4_0,
        LLAMA_FTYPE_MOSTLY_Q8_0,
        LLAMA_FTYPE_MOSTLY_TQ1_0,
        LLAMA_FTYPE_MOSTLY_TQ2_0};
    const bool supportedQuant =
        std::ranges::any_of(kSupportedQuants, [ft](auto q) { return q == ft; });
    if (!supportedQuant) {
      throw std::runtime_error(
          "Finetuning is not supported for this quantization type "
          "(file_type=" +
          std::to_string(ft) +
          "). Supported: F32, F16, Q4_0, Q8_0, TQ1_0, TQ2_0");
    }
  }

  if (auto unsupported =
          backend_selection::getUnknownFinetuneArchitecture(&metadata_)) {
    throw std::runtime_error(
        "Finetuning is not supported for architecture: " + unsupported.value());
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

  if (params.weightDecay < 0.0) {
    throw std::runtime_error("Weight decay must be non-negative");
  }

  if (params.lrMin < 0.0) {
    throw std::runtime_error("Minimum learning rate must be non-negative");
  }

  LoraLrScheduleType scheduleType;
  if (parseLrScheduler(params.lrScheduler, scheduleType)) {
    if (scheduleType != LoraLrScheduleType::Constant &&
        params.lrMin > params.learningRate) {
      throw std::runtime_error(
          "lrMin cannot exceed learningRate for " + params.lrScheduler +
          " scheduler");
    }
  }

  if (params.batchSize > 0 && params.microBatchSize > 0) {
    if (params.microBatchSize > params.batchSize) {
      throw std::runtime_error("microBatchSize must be <= batchSize");
    }
    if (params.batchSize % params.microBatchSize != 0) {
      throw std::runtime_error("batchSize must be divisible by microBatchSize");
    }
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
          : std::max<int64_t>(ctxSize, 8);

  const int64_t datasetStride =
      std::max<int64_t>(sequenceLength / 2, int64_t{1});
  ggml_opt_dataset_t datasetRaw = nullptr;

  if (params.assistantLossOnly) {
    const std::string jsonContent = readTextFile(datasetPath);
    datasetRaw = common_opt_sft_dataset_init(
        ctx, jsonContent, datasetStride, params.chatTemplatePath);
  } else {
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
  return prepareDatasetFromPath(params, params.evalDatasetPath, "Eval", "eval");
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
      0.0f,
      static_cast<float>(params.loraInitStd),
      params.loraSeed};

  adapter = llama_lora_training_init(ctx, mdl, &loraParams);
  if (adapter == nullptr) {
    std::string errorMsg =
        "LoRA training initialization failed. Parameters: "
        "targetModules=" +
        std::to_string(targetModules) +
        ", loraRank=" + std::to_string(params.loraRank) +
        ", loraAlpha=" + std::to_string(params.loraAlpha) +
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
  schedulerState.currentStep = 0;
  schedulerState.lastLr =
      schedulerLrForStep(schedulerState, schedulerState.currentStep);

  return schedulerState;
}

std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
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

  auto checkpointState = std::make_shared<TrainingCheckpointState>();
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
    throw std::runtime_error(
        "Checkpoint directory creation failed: directory='" +
        checkpointState->checkpointDir.string() +
        "' error=" + dirErr.message());
  }

  if (periodicCheckpointingEnabled) {
    std::ostringstream msg;
    msg << "Checkpointing enabled | dir="
        << checkpointState->checkpointDir.string()
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

  llama_opt_params optParams = llama_opt_default_params();
  optParams.param_filter = llama_opt_param_filter_lora;
  optParams.get_opt_pars = schedulerOptimizerParams;
  optParams.get_opt_pars_ud = &scheduler;
  optParams.optimizer_type = GGML_OPT_OPTIMIZER_TYPE_ADAMW;

  std::string checkpointPathStr;
  if (loadOptimizerState && checkpointState) {
    const auto checkpointPath =
        llama_finetuning_helpers::findLatestPauseCheckpoint(
            checkpointState->checkpointDir);
    if (!checkpointPath.empty() && std::filesystem::exists(checkpointPath)) {
      const auto optimizerPath = checkpointPath / "optimizer.gguf";
      if (std::filesystem::exists(optimizerPath) &&
          std::filesystem::is_regular_file(optimizerPath)) {
        checkpointPathStr = optimizerPath.string();
        optParams.checkpoint_path = checkpointPathStr.c_str();
        optParams.load_optimizer_state = true;
        QLOG_IF(
            Priority::DEBUG,
            "Optimizer checkpoint found: " + optimizerPath.string());
      } else {
        QLOG_IF(
            Priority::WARNING,
            "Optimizer checkpoint missing: " + optimizerPath.string());
        optParams.checkpoint_path = nullptr;
        optParams.load_optimizer_state = false;
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

  {
    std::ostringstream optimizerMsg;
    optimizerMsg << "Optimizer config | n_ctx_train=" << optParams.n_ctx_train
                 << " | model_ctx=" << llama_n_ctx(ctx)
                 << " | assistant_loss_only="
                 << (optParams.assistant_loss_only ? "true" : "false");
    QLOG_IF(Priority::DEBUG, optimizerMsg.str());
  }

  llama_opt_cleanup(ctx);

  llama_opt_init(ctx, mdl, optParams);
}

void LlamaModel::executeTrainingLoop(
    const qvac_lib_inference_addon_llama::LlamaFinetuningParams& params,
    ggml_opt_dataset_t dataset, int64_t trainSplit, int64_t evalSplit,
    llama_finetuning_helpers::LoraLrSchedulerState& scheduler,
    llama_finetuning_helpers::TrainingCheckpointState* checkpointState,
    uint32_t startEpoch, bool resumingFromPause, ggml_opt_dataset_t evalDataset,
    int64_t evalDatasetSampleCount, FinetuneTerminalResult::Stats* outStats) {
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

  double lastTrainLoss = 0.0;
  double lastTrainLossUnc = 0.0;
  double lastValLoss = 0.0;
  double lastValLossUnc = 0.0;
  double lastTrainAccuracy = 0.0;
  double lastTrainAccuracyUnc = 0.0;
  double lastValAccuracy = 0.0;
  double lastValAccuracyUnc = 0.0;
  int32_t completedEpochs = static_cast<int32_t>(startEpoch);

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
    if (resumingFromPause && checkpointState && epoch == startEpoch) {
      resumeFromBatch = checkpointState->batchOffsetWithinEpoch;
    }

    llama_opt_epoch_resume(
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
          callbackTrain);
    }

    if (!checkpointState || !checkpointState->shouldExit.load()) {
      const bool usingJsProgress =
          checkpointState && checkpointState->suppressProgressBar;
      if (!usingJsProgress) {
        if (checkpointEnabled) {
          std::cout << "\r";
          std::cout.flush();
        }
        std::cout << std::endl;
        std::cout.flush();
      }
    }

    ggml_opt_result_loss(trainResult.get(), &lastTrainLoss, &lastTrainLossUnc);
    ggml_opt_result_accuracy(
        trainResult.get(), &lastTrainAccuracy, &lastTrainAccuracyUnc);

    if (checkpointState && checkpointState->shouldExit.load()) {
      break;
    }

    if (hasEval) {
      ggml_opt_result_loss(evalResult.get(), &lastValLoss, &lastValLossUnc);
      ggml_opt_result_accuracy(
          evalResult.get(), &lastValAccuracy, &lastValAccuracyUnc);
    }

    completedEpochs = static_cast<int32_t>(epoch + 1);
    std::ostringstream epochMsg;
    epochMsg << "Epoch " << (epoch + 1)
             << " completed | loss=" << lastTrainLoss;
    if (hasEval) {
      epochMsg << " | val_loss=" << lastValLoss;
    }
    epochMsg << " | lr=" << scheduler.lastLr;
    QLOG_IF(Priority::DEBUG, epochMsg.str());
    ggml_opt_result_reset(trainResult.get());
    if (hasEval) {
      ggml_opt_result_reset(evalResult.get());
    }
  }

  if (outStats) {
    outStats->trainLoss = lastTrainLoss;
    outStats->trainLossUncertainty = lastTrainLossUnc;
    outStats->valLoss = lastValLoss;
    outStats->valLossUncertainty = lastValLossUnc;
    outStats->trainAccuracy = lastTrainAccuracy;
    outStats->trainAccuracyUncertainty = lastTrainAccuracyUnc;
    outStats->valAccuracy = lastValAccuracy;
    outStats->valAccuracyUncertainty = lastValAccuracyUnc;
    outStats->learningRate = static_cast<double>(scheduler.lastLr);
    outStats->epochsCompleted = completedEpochs;
    outStats->globalSteps = checkpointState ? checkpointState->globalStep : 0;
  }

  if (checkpointState && checkpointState->shouldExit.load() &&
      checkpointState->pauseCheckpointSaved.load()) {
    llama_opt_cleanup(ctx);
  }

  if (checkpointState && !checkpointState->shouldExit.load()) {
    clearPauseCheckpoint(checkpointState->checkpointDir);
  }

  if (outStats != nullptr && startEpoch >= params.numberOfEpochs &&
      checkpointState != nullptr && checkpointState->globalStep > 0) {
    outStats->globalSteps = checkpointState->globalStep;
    outStats->epochsCompleted = static_cast<int32_t>(params.numberOfEpochs);
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

std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
LlamaModel::getCurrentCheckpointStateShared() const {
  std::scoped_lock lock(checkpointStateMutex_);
  return currentCheckpointState_;
}

void LlamaModel::setCurrentCheckpointStateShared(
    std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState> state) {
  std::scoped_lock lock(checkpointStateMutex_);
  currentCheckpointState_ = std::move(state);
}

void LlamaModel::clearCurrentCheckpointStateShared() {
  std::scoped_lock lock(checkpointStateMutex_);
  currentCheckpointState_.reset();
}

std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState>
LlamaModel::getPausedCheckpointStateShared() const {
  std::scoped_lock lock(checkpointStateMutex_);
  return pausedCheckpointState_;
}

void LlamaModel::setPausedCheckpointStateShared(
    std::shared_ptr<llama_finetuning_helpers::TrainingCheckpointState> state) {
  std::scoped_lock lock(checkpointStateMutex_);
  pausedCheckpointState_ = std::move(state);
}

void LlamaModel::clearPausedCheckpointStateShared() {
  std::scoped_lock lock(checkpointStateMutex_);
  pausedCheckpointState_.reset();
}

bool LlamaModel::isFinetuneRunning() const {
  auto state = getCurrentCheckpointStateShared();
  return state != nullptr &&
         state->isFinetuning.load(std::memory_order_acquire);
}

bool LlamaModel::requestPause() {
  auto state = getCurrentCheckpointStateShared();
  if (state == nullptr) {
    return false;
  }
  state->pauseRequested.store(true);
  return true;
}

void LlamaModel::waitUntilFinetuningPauseComplete() {
  auto state = getCurrentCheckpointStateShared();
  if (state == nullptr) {
    return;
  }

  constexpr auto timeout = std::chrono::minutes(5);
  std::unique_lock lock(state->pauseDoneMutex);
  state->pauseDoneCv.wait_for(lock, timeout, [&state] {
    return state->pauseWaitDone.load(std::memory_order_acquire) &&
           state->isIdle.load(std::memory_order_acquire);
  });
}

void LlamaModel::clearPauseRequest() {
  clearPausedCheckpointStateShared();
  clearCurrentCheckpointStateShared();

  llama_context* ctx = getContext();
  if (ctx != nullptr) {
    llama_opt_reset_stop(ctx);
  }
}

#endif // STANDALONE_TEST_BUILD
