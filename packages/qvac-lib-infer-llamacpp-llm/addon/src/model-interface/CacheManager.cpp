#include "CacheManager.hpp"

#include <filesystem>
#include <system_error>

#include <llama.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

CacheManager::CacheManager(
    LlmContext* llmContext, llama_pos configuredNDiscarded,
    std::function<void(bool)> resetStateCallback)
    : llmContext_(llmContext), configuredNDiscarded_(configuredNDiscarded),
      resetStateCallback_(std::move(resetStateCallback)) {}

bool CacheManager::isFileInitialized(const std::filesystem::path& path) {
  std::error_code errorCode;
  auto size = std::filesystem::file_size(path, errorCode);
  if (errorCode) {
    return false;
  }
  return size != 0;
}

bool CacheManager::handleCache(
    std::vector<common_chat_msg>& chatMsgs,
    std::vector<common_chat_tool>& tools, const std::string& inputPrompt,
    std::function<
        std::pair<std::vector<common_chat_msg>, std::vector<common_chat_tool>>(
            const std::string&)>
        formatPrompt,
    const std::string& cacheKey) {

  auto formatted = formatPrompt(inputPrompt);
  chatMsgs = std::move(formatted.first);
  tools = std::move(formatted.second);

  if (cacheKey.empty()) {
    if (hasActiveCache()) {
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "%s: No cacheKey provided, clearing existing cache '%s'\n",
              __func__,
              sessionPath_.c_str()));
      saveCache();
      resetStateCallback_(true);
      sessionPath_.clear();
      cacheDisabled_ = true;
    }
    cacheUsedInLastPrompt_ = false;
    return false;
  }

  if (!cacheDisabled_ && sessionPath_ == cacheKey) {
    cacheUsedInLastPrompt_ = true;
    return false;
  }

  if (hasActiveCache() && sessionPath_ != cacheKey) {
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "%s: Switching from cache '%s' to '%s', saving old cache\n",
            __func__,
            sessionPath_.c_str(),
            cacheKey.c_str()));
    saveCache();
  }

  resetStateCallback_(true);
  cacheUsedInLastPrompt_ = false;

  sessionPath_ = cacheKey;
  cacheDisabled_ = false;

  QLOG_IF(
      Priority::DEBUG,
      string_format(
          "%s: Cache enabled with key '%s'\n", __func__, sessionPath_.c_str()));

  bool loaded = loadCache();
  cacheUsedInLastPrompt_ = true;
  return loaded;
}

bool CacheManager::loadCache() {
  if (cacheDisabled_ || sessionPath_.empty()) {
    return false;
  }

  auto* ctx = llmContext_->getCtx();
  size_t nTokenCount = 0;
  llama_token sessionTokens[2] = {0, 0};

  QLOG_IF(
      Priority::DEBUG,
      string_format(
          "%s: attempting to load saved session from '%s'\n",
          __func__,
          sessionPath_.c_str()));
  if (!isFileInitialized(sessionPath_)) {
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "%s: session file does not exist or is empty\n", __func__));
    return false;
  }

  if (!llama_state_load_file(
          ctx, sessionPath_.c_str(), sessionTokens, 2, &nTokenCount)) {
    std::string errorMsg = string_format(
        "%s: failed to load session file '%s'\n",
        __func__,
        sessionPath_.c_str());
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadSessionFile), errorMsg);
  }

  QLOG_IF(Priority::DEBUG, string_format("%s: loaded a session\n", __func__));

  if (nTokenCount > 1) {
    if (sessionTokens[0] > llama_n_ctx(ctx)) {
      std::string errorMsg = string_format(
          "%s: cache file '%s' contains %zu tokens, which exceeds the current "
          "context size of %d tokens\n",
          __func__,
          sessionPath_.c_str(),
          static_cast<size_t>(sessionTokens[0]),
          llama_n_ctx(ctx));
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextLengthExeeded), errorMsg);
    }
    llmContext_->setNPast(sessionTokens[0]);
    llmContext_->setFirstMsgTokens(sessionTokens[1]);

    if (configuredNDiscarded_ >
        llama_n_ctx(ctx) - llmContext_->getFirstMsgTokens()) {
      llmContext_->setNDiscarded(
          llama_n_ctx(ctx) - llmContext_->getFirstMsgTokens() - 1);
    } else {
      llmContext_->setNDiscarded(configuredNDiscarded_);
    }

    auto* mem = llama_get_memory(ctx);
    llama_memory_seq_rm(mem, -1, sessionTokens[0], -1);
    return true;
  }
  return false;
}

void CacheManager::saveCache() {
  if (cacheDisabled_ || sessionPath_.empty()) {
    std::string errorMsg = string_format(
        "%s: Cannot save cache - caching disabled or no session path set\n",
        __func__);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(InvalidInputFormat), errorMsg);
  }
  writeCacheFile(sessionPath_);
}

void CacheManager::writeCacheFile(const std::string& path) {
  llama_context* ctx = llmContext_->getCtx();
  QLOG_IF(
      Priority::DEBUG,
      string_format("%s: saving cache to '%s'\n", __func__, path.c_str()));
  llama_token sessionTokens[2] = {
      static_cast<llama_token>(llmContext_->getNPast()),
      static_cast<llama_token>(llmContext_->getFirstMsgTokens())};
  llama_state_save_file(ctx, path.c_str(), sessionTokens, 2);
}

void CacheManager::invalidate() {
  sessionPath_.clear();
  cacheDisabled_ = true;
  cacheUsedInLastPrompt_ = false;
}

bool CacheManager::isCacheDisabled() const { return cacheDisabled_; }

bool CacheManager::hasActiveCache() const {
  return !cacheDisabled_ && !sessionPath_.empty();
}
bool CacheManager::wasCacheUsedInLastPrompt() const {
  return cacheUsedInLastPrompt_;
}
