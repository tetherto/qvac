#include "CacheManager.hpp"

#include <filesystem>
#include <system_error>

#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "addon/LlmErrors.hpp"
#include "model-interface/CacheLedger.hpp"
#include "model-interface/SequenceDriver.hpp"
#include "model-interface/SlotStateCache.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ScopeGuard.hpp"

#ifdef _WIN32
#include <windows.h>
#endif

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;
namespace cache = qvac_lib_inference_addon_llama::cache;

CacheManager::CacheManager(
    LlmContext* llmContext, std::function<void(bool)> resetStateCallback)
    : llmContext_(llmContext),
      resetStateCallback_(std::move(resetStateCallback)) {}

bool CacheManager::isFileInitialized(const std::filesystem::path& path) {
  std::error_code errorCode;
  auto size = std::filesystem::file_size(path, errorCode);
  if (errorCode) {
    return false;
  }
  return size != 0;
}

bool CacheManager::isFileMissingOrEmpty(const std::filesystem::path& path) {
  std::error_code directoryErrorCode;
  if (std::filesystem::is_directory(path, directoryErrorCode)) {
    return false;
  }

  std::error_code errorCode;
  auto size = std::filesystem::file_size(path, errorCode);
  if (!errorCode) {
    return size == 0;
  }
  return errorCode == std::errc::no_such_file_or_directory ||
         errorCode == std::errc::not_a_directory;
}

bool CacheManager::isParentDirectoryMissing(const std::filesystem::path& path) {
  const auto parent = path.parent_path();
  if (parent.empty()) {
    return false;
  }

  std::error_code errorCode;
  const bool exists = std::filesystem::exists(parent, errorCode);
  return !errorCode && !exists;
}

bool CacheManager::handleCache(
    ParsedPromptPayload& parsedPrompt, const std::string& inputPrompt,
    std::function<ParsedPromptPayload(const std::string&)> formatPrompt,
    const std::string& cacheKey, bool ephemeral) {

  parsedPrompt = formatPrompt(inputPrompt);

  if (cacheKey.empty()) {
    if (hasActiveCache()) {
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "%s: No cacheKey provided, clearing existing cache '%s'\n",
              __func__,
              sessionPath_.c_str()));
      saveActiveCacheForTransition();
      invalidate();
    }
    cacheUsedInLastPrompt_ = false;
    return false;
  }

  if (!cacheDisabled_ && sessionPath_ == cacheKey) {
    if (discardActiveCacheIfBackingStoreMissing()) {
      cacheUsedInLastPrompt_ = false;
    } else {
      cacheUsedInLastPrompt_ = true;
      activeCacheDirty_ = true;
      activeEphemeral_ = ephemeral;
      return false;
    }
  }

  if (hasActiveCache() && sessionPath_ != cacheKey) {
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "%s: Switching from cache '%s' to '%s', saving old cache\n",
            __func__,
            sessionPath_.c_str(),
            cacheKey.c_str()));
    saveActiveCacheForTransition();
  } else {
    resetStateCallback_(true);
  }

  cacheUsedInLastPrompt_ = false;

  sessionPath_ = cacheKey;
  cacheDisabled_ = false;

  QLOG_IF(
      Priority::DEBUG,
      string_format(
          "%s: Cache enabled with key '%s'\n", __func__, sessionPath_.c_str()));

  try {
    // RAM tier first (set by `restoreFromRamTier`), then the file.
    bool loaded = restoreFromRamTier();
    if (!loaded) {
      loaded = loadCache();
      activeCacheSavedToDisk_ = loaded;
    }
    if (!loaded) {
      resetStateCallback_(true);
    }
    cacheUsedInLastPrompt_ = true;
    // The request about to run adds turns the file does not have.
    activeCacheDirty_ = true;
    activeEphemeral_ = ephemeral;
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
  // A ledger has at most one entry per context position (media occupies many
  // positions but one entry). Leave a little headroom for the fixed header.
  std::vector<llama_token> stateTokens(
      cache::LEDGER_HEADER_WORDS +
      cache::LEDGER_ENTRY_WORDS * (static_cast<size_t>(llama_n_ctx(ctx)) + 1));

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

  if (llama_state_seq_load_file(
          ctx,
          sessionPath_.c_str(),
          llmContext_->getSeqId(),
          stateTokens.data(),
          stateTokens.size(),
          &nTokenCount) == 0) {
    std::string errorMsg = string_format(
        "%s: failed to load session file '%s'\n",
        __func__,
        sessionPath_.c_str());
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadSessionFile), errorMsg);
  }

  QLOG_IF(Priority::DEBUG, string_format("%s: loaded a session\n", __func__));

  stateTokens.resize(nTokenCount);
  const bool accepted = acceptLoadedState(stateTokens, sessionPath_);
  if (accepted) {
    activeCacheDirty_ = false;
  }
  return accepted;
}

bool CacheManager::acceptLoadedState(
    std::vector<llama_token>& stateTokens, const std::string& source) {
  auto* ctx = llmContext_->getCtx();
  // The load above already restored this sequence's KV cells. Any path that
  // rejects the session below (or returns false without accepting it) must roll
  // those cells back, otherwise a failed/declined load strands live KV under
  // getSeqId() while the caller believes nothing was loaded. Arm the rollback
  // now and dismiss it only on the single accepted path.
  ScopeGuard restoredKvGuard([this, ctx] {
    if (auto* mem = llama_get_memory(ctx); mem != nullptr) {
      llama_memory_seq_rm(mem, llmContext_->getSeqId(), -1, -1);
    }
    llmContext_->setNPast(0);
    llmContext_->setCacheTokens(0);
    llmContext_->clearCacheReconciliationState();
  });

  // Old addon files carried only positional metadata. They are valid state
  // files but not self-describing, so reject them as a cold miss after
  // clearing the state tentatively restored by llama.cpp.
  if (!cache::hasMarker(stateTokens.data(), stateTokens.size())) {
    llmContext_->clearCacheReconciliationState();
    return false;
  }
  try {
    llmContext_->restoreCacheStateTokens(stateTokens);
  } catch (const std::exception& ex) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: cache file '%s' contains a malformed current-format "
            "ledger: %s\n",
            __func__,
            source.c_str(),
            ex.what()));
  }
  if (llmContext_->getNPast() > llama_n_ctx(ctx)) {
    std::string errorMsg = string_format(
        "%s: cache file '%s' contains %zu tokens, which exceeds the current "
        "context size of %d tokens\n",
        __func__,
        source.c_str(),
        static_cast<size_t>(llmContext_->getNPast()),
        llama_n_ctx(ctx));
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextLengthExeeded), errorMsg);
  }
  auto* mem = llama_get_memory(ctx);
  if (mem == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: llama memory is null after loading session file '%s'\n",
            __func__,
            source.c_str()));
  }

  const llama_pos restoredNPast =
      llama_memory_seq_pos_max(mem, llmContext_->getSeqId()) + 1;
  const auto expectedNPast = llmContext_->getNPast();
  if (restoredNPast != expectedNPast) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: cache file '%s' restored nPast=%d, but metadata expected "
            "nPast=%d\n",
            __func__,
            source.c_str(),
            restoredNPast,
            expectedNPast));
  }
  const llama_pos restoredCacheTokens = static_cast<llama_pos>(
      llama_memory_seq_token_count(mem, llmContext_->getSeqId()));
  const auto expectedCacheTokens = llmContext_->getCacheTokens();
  if (restoredCacheTokens != expectedCacheTokens) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: cache file '%s' restored cacheTokens=%d, but metadata "
            "expected cacheTokens=%d\n",
            __func__,
            source.c_str(),
            restoredCacheTokens,
            expectedCacheTokens));
  }
  // Trim only this context's sequence: on a parallel model the others hold
  // batch conversations kept for their next request.
  llama_memory_seq_rm(mem, llmContext_->getSeqId(), expectedNPast, -1);
  restoredKvGuard.dismiss();
  return true;
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
  activeCacheSavedToDisk_ = true;
  activeCacheDirty_ = false;
}

void CacheManager::saveActiveCacheForTransition() {
  if (discardActiveCacheIfBackingStoreMissing()) {
    return;
  }
  // Nothing committed (e.g. its only request rolled back): nothing to keep.
  if (llmContext_->getNPast() == 0) {
    resetStateCallback_(true);
    return;
  }
  // With the RAM tier on, the conversation moves there and its file is only
  // written when the tier has to let it go or the model is unloaded.
  if (moveActiveCacheToRamTier()) {
    resetStateCallback_(true);
    return;
  }
  // Never written automatically: dropped.
  if (activeEphemeral_) {
    resetStateCallback_(true);
    return;
  }
  // Nothing ran since the file was last written or loaded, and it is still
  // there: it is current. A file replaced by anything else is saved again,
  // so its failure is reported instead of the conversation being dropped.
  if (!activeCacheDirty_ && activeCacheSavedToDisk_ &&
      isFileInitialized(sessionPath_)) {
    resetStateCallback_(true);
    return;
  }

  try {
    saveCache();
    resetStateCallback_(true);
  } catch (...) {
    if (discardActiveCacheIfBackingStoreMissing()) {
      return;
    }
    resetStateCallback_(true);
    invalidate();
    throw;
  }
}

bool CacheManager::moveActiveCacheToRamTier() {
  if (!ramTier_ || !ramTier_->enabled()) {
    return false;
  }
  try {
    llama_context* ctx = llmContext_->getCtx();
    const llama_seq_id seq = llmContext_->getSeqId();
    qvac_lib_inference_addon_llama::batching::SlotStateCacheEntry entry;
    const size_t size = llama_state_seq_get_size_ext(ctx, seq, 0);
    if (size == 0) {
      return false;
    }
    entry.state.resize(size);
    if (llama_state_seq_get_data_ext(ctx, entry.state.data(), size, seq, 0) !=
        size) {
      return false;
    }
    entry.ledgerWords = llmContext_->cacheStateTokens();
    entry.dirty = activeCacheDirty_;
    entry.activeCacheSavedToDisk = activeCacheSavedToDisk_;
    entry.ephemeral = activeEphemeral_;
    auto* driver = dynamic_cast<SequenceDriver*>(llmContext_);
    if (driver != nullptr) {
      entry.checkpoints = driver->releaseCheckpoints();
    }
    if (ramTier_->insert(sessionPath_, std::move(entry))) {
      return true;
    }
    // Too large for the tier: give the checkpoints back and save normally.
    if (driver != nullptr) {
      driver->adoptCheckpoints(std::move(entry.checkpoints));
    }
    return false;
  } catch (const std::bad_alloc&) {
    return false;
  }
}

bool CacheManager::restoreFromRamTier() {
  if (!ramTier_ || !ramTier_->enabled()) {
    return false;
  }
  std::optional<qvac_lib_inference_addon_llama::batching::SlotStateCacheEntry>
      entry = ramTier_->take(sessionPath_);
  if (!entry.has_value()) {
    return false;
  }
  if (entry->activeCacheSavedToDisk &&
      persistedBackingStoreMissing(sessionPath_)) {
    return false;
  }
  llama_context* ctx = llmContext_->getCtx();
  const llama_seq_id seq = llmContext_->getSeqId();
  resetStateCallback_(true);
  if (llama_state_seq_set_data_ext(
          ctx, entry->state.data(), entry->state.size(), seq, 0) == 0) {
    resetStateCallback_(true);
    return false;
  }
  try {
    if (!acceptLoadedState(entry->ledgerWords, sessionPath_ + " (RAM)")) {
      return false;
    }
  } catch (const std::exception& ex) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: dropping RAM-tier state for '%s': %s\n",
            __func__,
            sessionPath_.c_str(),
            ex.what()));
    return false;
  }
  if (auto* driver = dynamic_cast<SequenceDriver*>(llmContext_);
      driver != nullptr) {
    driver->adoptCheckpoints(std::move(entry->checkpoints));
  }
  activeCacheSavedToDisk_ = entry->activeCacheSavedToDisk;
  activeCacheDirty_ = entry->dirty;
  return true;
}

void CacheManager::flushForUnload() {
  if (!hasActiveCache() || !activeCacheDirty_ || activeEphemeral_ ||
      llmContext_->getNPast() == 0 ||
      discardActiveCacheIfBackingStoreMissing()) {
    return;
  }
  try {
    saveCache();
  } catch (const std::exception& ex) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: could not save '%s' at unload: %s\n",
            __func__,
            sessionPath_.c_str(),
            ex.what()));
  }
}

CacheManager::SaveOutcome
CacheManager::saveForCaller(const std::string& cacheKey) {
  if (!hasActiveCache() || sessionPath_ != cacheKey) {
    return SaveOutcome::NotHere;
  }
  if (!activeCacheDirty_ && activeCacheSavedToDisk_ &&
      isFileInitialized(sessionPath_)) {
    return SaveOutcome::Current;
  }
  saveCache();
  return SaveOutcome::Written;
}

void CacheManager::setRamTier(
    std::shared_ptr<qvac_lib_inference_addon_llama::batching::SlotStateCache>
        ramTier) {
  ramTier_ = std::move(ramTier);
}

bool CacheManager::persistedBackingStoreMissing(const std::string& path) {
  return isParentDirectoryMissing(path) || isFileMissingOrEmpty(path);
}

bool CacheManager::discardActiveCacheIfBackingStoreMissing() {
  if (!hasActiveCache()) {
    return false;
  }
  const bool parentMissing =
      activeCacheSavedToDisk_ && isParentDirectoryMissing(sessionPath_);
  const bool persistedFileMissing =
      activeCacheSavedToDisk_ && isFileMissingOrEmpty(sessionPath_);
  if (!parentMissing && !persistedFileMissing) {
    return false;
  }

  QLOG_IF(
      Priority::DEBUG,
      string_format(
          "%s: active cache backing store was removed, dropping stale cache "
          "'%s'\n",
          __func__,
          sessionPath_.c_str()));
  resetStateCallback_(true);
  invalidate();
  return true;
}

void CacheManager::writeCacheFile(const std::string& path) {
  llama_context* ctx = llmContext_->getCtx();
  const std::string tmpPath = path + ".tmp";
  QLOG_IF(
      Priority::DEBUG,
      string_format("%s: saving cache to '%s'\n", __func__, path.c_str()));
  const std::vector<llama_token> stateTokens = llmContext_->cacheStateTokens();
  if (llama_state_seq_save_file(
          ctx,
          tmpPath.c_str(),
          llmContext_->getSeqId(),
          stateTokens.data(),
          stateTokens.size()) == 0) {
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
  std::error_code directoryEc;
  if (std::filesystem::is_directory(to, directoryEc)) {
    std::error_code removeEc;
    std::filesystem::remove(from, removeEc);
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToSaveSessionFile),
        string_format(
            "%s: failed to promote tmp file to '%s': destination is a "
            "directory\n",
            __func__,
            to.c_str()));
  }

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
  activeCacheSavedToDisk_ = false;
  activeCacheDirty_ = false;
  activeEphemeral_ = false;
}

bool CacheManager::isCacheDisabled() const { return cacheDisabled_; }

bool CacheManager::hasActiveCache() const {
  return !cacheDisabled_ && !sessionPath_.empty();
}
bool CacheManager::wasCacheUsedInLastPrompt() const {
  return cacheUsedInLastPrompt_;
}
