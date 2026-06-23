#include "CacheManager.hpp"

#include <array>
#include <filesystem>
#include <system_error>

#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "addon/LlmErrors.hpp"
#include "utils/LoggingMacros.hpp"

#ifdef _WIN32
#include <windows.h>
#endif

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

namespace {

struct SessionMetadata {
  std::array<llama_token, 4> tokens = {};

  static SessionMetadata fromContext(const LlmContext& context) {
    return {
        {static_cast<llama_token>(context.getNPast()),
         static_cast<llama_token>(context.getFirstMsgTokens()),
         static_cast<llama_token>(context.getCacheTokens()),
         static_cast<llama_token>(context.getFirstMsgCacheTokens())}};
  }

  llama_token* data() { return tokens.data(); }
  const llama_token* data() const { return tokens.data(); }
  size_t size() const { return tokens.size(); }

  llama_token nPast() const { return tokens[0]; }
  llama_token firstMsgTokens() const { return tokens[1]; }
  llama_token cacheTokens() const { return tokens[2]; }
  llama_token firstMsgCacheTokens() const { return tokens[3]; }

  void applyTo(LlmContext& context) const {
    context.setNPast(nPast());
    context.setFirstMsgTokens(firstMsgTokens());
    context.setCacheTokens(cacheTokens());
    context.setFirstMsgCacheTokens(firstMsgCacheTokens());
  }
};

} // namespace

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
    ParsedPromptPayload& parsedPrompt, const std::string& inputPrompt,
    std::function<ParsedPromptPayload(const std::string&)> formatPrompt,
    const std::string& cacheKey) {

  parsedPrompt = formatPrompt(inputPrompt);

  if (cacheKey.empty()) {
    if (hasActiveCache()) {
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "%s: No cacheKey provided, clearing existing cache '%s'\n",
              __func__,
              sessionPath_.c_str()));
      try {
        saveCache();
      } catch (...) {
        resetStateCallback_(true);
        invalidate();
        throw;
      }
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
    try {
      saveCache();
    } catch (...) {
      resetStateCallback_(true);
      invalidate();
      throw;
    }
  }

  resetStateCallback_(true);
  cacheUsedInLastPrompt_ = false;

  sessionPath_ = cacheKey;
  cacheDisabled_ = false;

  QLOG_IF(
      Priority::DEBUG,
      string_format(
          "%s: Cache enabled with key '%s'\n", __func__, sessionPath_.c_str()));

  try {
    bool loaded = loadCache();
    if (!loaded) {
      resetStateCallback_(true);
    }
    cacheUsedInLastPrompt_ = true;
    return loaded;
  } catch (...) {
    resetStateCallback_(true);
    invalidate();
    throw;
  }
}

bool CacheManager::loadCache() {
  if (cacheDisabled_ || sessionPath_.empty()) {
    return false;
  }

  auto* ctx = llmContext_->getCtx();
  size_t nTokenCount = 0;
  SessionMetadata sessionMetadata;

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
          ctx,
          sessionPath_.c_str(),
          sessionMetadata.data(),
          sessionMetadata.size(),
          &nTokenCount)) {
    std::string errorMsg = string_format(
        "%s: failed to load session file '%s'\n",
        __func__,
        sessionPath_.c_str());
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadSessionFile), errorMsg);
  }

  QLOG_IF(Priority::DEBUG, string_format("%s: loaded a session\n", __func__));

  if (nTokenCount > 1 && nTokenCount < sessionMetadata.size()) {
    std::string errorMsg = string_format(
        "%s: cache file '%s' uses an unsupported metadata layout with %zu "
        "fields\n",
        __func__,
        sessionPath_.c_str(),
        nTokenCount);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadSessionFile), errorMsg);
  }

  if (nTokenCount >= sessionMetadata.size()) {
    if (sessionMetadata.nPast() > llama_n_ctx(ctx)) {
      std::string errorMsg = string_format(
          "%s: cache file '%s' contains %zu tokens, which exceeds the current "
          "context size of %d tokens\n",
          __func__,
          sessionPath_.c_str(),
          static_cast<size_t>(sessionMetadata.nPast()),
          llama_n_ctx(ctx));
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextLengthExeeded), errorMsg);
    }
    sessionMetadata.applyTo(*llmContext_);

    if (configuredNDiscarded_ >
        llama_n_ctx(ctx) - llmContext_->getFirstMsgTokens()) {
      llmContext_->setNDiscarded(
          llama_n_ctx(ctx) - llmContext_->getFirstMsgTokens() - 1);
    } else {
      llmContext_->setNDiscarded(configuredNDiscarded_);
    }

    auto* mem = llama_get_memory(ctx);
    if (mem == nullptr) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToLoadSessionFile),
          string_format(
              "%s: llama memory is null after loading session file '%s'\n",
              __func__,
              sessionPath_.c_str()));
    }

    const llama_pos restoredNPast =
        llama_memory_seq_pos_max(mem, llmContext_->getSeqId()) + 1;
    const auto expectedNPast = static_cast<llama_pos>(sessionMetadata.nPast());
    if (restoredNPast != expectedNPast) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToLoadSessionFile),
          string_format(
              "%s: cache file '%s' restored nPast=%d, but metadata expected "
              "nPast=%d\n",
              __func__,
              sessionPath_.c_str(),
              restoredNPast,
              expectedNPast));
    }
    const llama_pos restoredCacheTokens = static_cast<llama_pos>(
        llama_memory_seq_token_count(mem, llmContext_->getSeqId()));
    const auto expectedCacheTokens =
        static_cast<llama_pos>(sessionMetadata.cacheTokens());
    if (restoredCacheTokens != expectedCacheTokens) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToLoadSessionFile),
          string_format(
              "%s: cache file '%s' restored cacheTokens=%d, but metadata "
              "expected cacheTokens=%d\n",
              __func__,
              sessionPath_.c_str(),
              restoredCacheTokens,
              expectedCacheTokens));
    }
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
  const std::string tmpPath = path + ".tmp";
  QLOG_IF(
      Priority::DEBUG,
      string_format("%s: saving cache to '%s'\n", __func__, path.c_str()));
  const SessionMetadata sessionMetadata =
      SessionMetadata::fromContext(*llmContext_);
  if (!llama_state_save_file(
          ctx,
          tmpPath.c_str(),
          sessionMetadata.data(),
          sessionMetadata.size())) {
    std::error_code ec;
    std::filesystem::remove(tmpPath, ec);
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToSaveSessionFile),
        string_format(
            "%s: failed to save session file to '%s'\n",
            __func__,
            path.c_str()));
  }
  atomicPromoteFile(tmpPath, path);
}

void CacheManager::atomicPromoteFile(
    const std::string& from, const std::string& to) {
#ifdef _WIN32
  // MoveFileExW atomically replaces the destination on NTFS — unlike
  // delete-then-rename, the old canonical file is preserved if promotion fails.
  // NOTE: path() from std::string uses the system ANSI code page on MSVC, not
  // UTF-8. Non-ASCII paths are already broken for llama_state_save_file (which
  // calls fopen with the same string), so this is a pre-existing issue across
  // the whole CacheManager — not introduced here.
  if (!MoveFileExW(
          std::filesystem::path(from).wstring().c_str(),
          std::filesystem::path(to).wstring().c_str(),
          MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    const std::error_code moveEc(
        static_cast<int>(GetLastError()), std::system_category());
    std::error_code ec;
    std::filesystem::remove(from, ec);
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToSaveSessionFile),
        string_format(
            "%s: failed to promote tmp file to '%s': %s\n",
            __func__,
            to.c_str(),
            moveEc.message().c_str()));
  }
#else
  std::error_code renameEc;
  std::filesystem::rename(from, to, renameEc);
  if (renameEc) {
    std::error_code ec;
    std::filesystem::remove(from, ec);
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToSaveSessionFile),
        string_format(
            "%s: failed to promote tmp file to '%s': %s\n",
            __func__,
            to.c_str(),
            renameEc.message().c_str()));
  }
#endif
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
