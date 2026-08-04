#include "CacheManager.hpp"

#include <array>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <system_error>
#include <unordered_set>

#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "addon/LlmErrors.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ScopeGuard.hpp"

#ifdef _WIN32
#include <windows.h>
#endif

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

namespace {

std::mutex CACHE_RESERVATION_MUTEX;
std::unordered_set<std::string> RESERVED_CACHE_ARTIFACTS;

struct SessionMetadata {
  std::array<llama_token, SESSION_METADATA_FIELD_COUNT> tokens = {};

  static SessionMetadata fromContext(const LlmContext& context) {
    SessionMetadata metadata;
    auto& tokens = metadata.tokens;
    using Field = SessionMetadataField;
    tokens[static_cast<size_t>(Field::NPast)] =
        static_cast<llama_token>(context.getNPast());
    tokens[static_cast<size_t>(Field::FirstMsgTokens)] =
        static_cast<llama_token>(context.getFirstMsgTokens());
    tokens[static_cast<size_t>(Field::CacheTokens)] =
        static_cast<llama_token>(context.getCacheTokens());
    tokens[static_cast<size_t>(Field::FirstMsgCacheTokens)] =
        static_cast<llama_token>(context.getFirstMsgCacheTokens());
    return metadata;
  }

  llama_token* data() { return tokens.data(); }
  const llama_token* data() const { return tokens.data(); }
  size_t size() const { return tokens.size(); }

  llama_token field(SessionMetadataField which) const {
    return tokens[static_cast<size_t>(which)];
  }
  llama_token nPast() const { return field(SessionMetadataField::NPast); }
  llama_token firstMsgTokens() const {
    return field(SessionMetadataField::FirstMsgTokens);
  }
  llama_token cacheTokens() const {
    return field(SessionMetadataField::CacheTokens);
  }
  llama_token firstMsgCacheTokens() const {
    return field(SessionMetadataField::FirstMsgCacheTokens);
  }

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

CacheManager::~CacheManager() { releaseTransactionReservation(); }

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
    bool loaded = loadCache();
    activeCacheSavedToDisk_ = loaded;
    committedArtifactKnownValid_ = loaded;
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

  if (llama_state_seq_load_file(
          ctx,
          sessionPath_.c_str(),
          llmContext_->getSeqId(),
          sessionMetadata.data(),
          sessionMetadata.size(),
          &nTokenCount) == 0) {
    std::string errorMsg = string_format(
        "%s: failed to load session file '%s'\n",
        __func__,
        sessionPath_.c_str());
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadSessionFile), errorMsg);
  }

  QLOG_IF(Priority::DEBUG, string_format("%s: loaded a session\n", __func__));

  // The load above already restored this sequence's KV cells. Any path that
  // rejects the session below (or returns false without accepting it) must roll
  // those cells back, otherwise a failed/declined load strands live KV under
  // getSeqId() while the caller believes nothing was loaded. Arm the rollback
  // now and dismiss it only on the single accepted path.
  ScopeGuard restoredKvGuard([this, ctx] {
    if (auto* mem = llama_get_memory(ctx); mem != nullptr) {
      llama_memory_seq_rm(mem, llmContext_->getSeqId(), -1, -1);
    }
  });

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

  if (nTokenCount < sessionMetadata.size()) {
    return false;
  }
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
  llama_memory_seq_rm(mem, -1, sessionMetadata.nPast(), -1);
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
  committedArtifactKnownValid_ = true;
}

void CacheManager::prepareTransactionCheckpoint(bool persistent) {
  releaseTransactionReservation();
  llmContext_->clearTransactionCheckpoint();
  if (!persistent || !hasActiveCache()) {
    return;
  }
  if (!reserveCacheArtifact(sessionPath_)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: cache artifact '%s' is already in use\n",
            __func__,
            sessionPath_.c_str()));
  }
  reservedTransactionPath_ = sessionPath_;
  ScopeGuard reservationGuard([this] { releaseTransactionReservation(); });
  if (llmContext_->getNPast() <= 0) {
    llmContext_->setEmptyTransactionCheckpoint();
    reservationGuard.dismiss();
    return;
  }
  if (!committedArtifactKnownValid_ || !isFileInitialized(sessionPath_)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: persistent request has no usable rollback artifact for '%s'\n",
            __func__,
            sessionPath_.c_str()));
  }
  const auto checkpoint = inspectCommittedCacheArtifact(
      sessionPath_, llama_n_ctx(llmContext_->getCtx()));
  llmContext_->setPersistentTransactionCheckpoint(
      sessionPath_, checkpoint.metadata, checkpoint.identity);
  reservationGuard.dismiss();
}

void CacheManager::markActiveCacheDirty() {
  if (hasActiveCache()) {
    activeCacheSavedToDisk_ = false;
  }
}

void CacheManager::saveActiveCacheForTransition() {
  if (discardActiveCacheIfBackingStoreMissing()) {
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
  const SessionMetadata sessionMetadata =
      SessionMetadata::fromContext(*llmContext_);
  if (llama_state_seq_save_file(
          ctx,
          tmpPath.c_str(),
          llmContext_->getSeqId(),
          sessionMetadata.data(),
          sessionMetadata.size()) == 0) {
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

CommittedCacheCheckpoint CacheManager::inspectCommittedCacheArtifact(
    const std::string& path, llama_pos maxContext) {
  std::error_code sizeEc;
  const auto fileSizeBefore = std::filesystem::file_size(path, sizeEc);
  const auto modifiedBefore = std::filesystem::last_write_time(path, sizeEc);
  constexpr uintmax_t metadataBytes =
      sizeof(uint32_t) * 3 + sizeof(llama_token) * SESSION_METADATA_FIELD_COUNT;
  if (sizeEc || fileSizeBefore <= metadataBytes) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: checkpoint state payload is missing in '%s'\n",
            __func__,
            path.c_str()));
  }
  std::ifstream in(path, std::ios::binary);
  uint32_t magic = 0;
  uint32_t version = 0;
  uint32_t count = 0;
  SessionMetadata metadata;
  in.read(reinterpret_cast<char*>(&magic), sizeof(magic));
  in.read(reinterpret_cast<char*>(&version), sizeof(version));
  in.read(reinterpret_cast<char*>(&count), sizeof(count));
  if (!in || magic != LLAMA_STATE_SEQ_MAGIC ||
      version != LLAMA_STATE_SEQ_VERSION ||
      count != SESSION_METADATA_FIELD_COUNT) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: invalid checkpoint metadata in '%s'\n",
            __func__,
            path.c_str()));
  }
  in.read(
      reinterpret_cast<char*>(metadata.data()),
      static_cast<std::streamsize>(sizeof(llama_token) * metadata.size()));
  if (!in) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: truncated checkpoint metadata in '%s'\n",
            __func__,
            path.c_str()));
  }
  const qvac_lib_inference_addon_llama::SessionCheckpointMetadata result{
      .nPast = static_cast<llama_pos>(metadata.nPast()),
      .firstMsgTokens = static_cast<llama_pos>(metadata.firstMsgTokens()),
      .cacheTokens = static_cast<llama_pos>(metadata.cacheTokens()),
      .firstMsgCacheTokens =
          static_cast<llama_pos>(metadata.firstMsgCacheTokens())};
  const bool valid =
      result.nPast >= 0 && result.nPast <= maxContext &&
      result.firstMsgTokens >= 0 && result.firstMsgTokens <= result.nPast &&
      result.cacheTokens >= result.nPast && result.cacheTokens <= maxContext &&
      result.firstMsgCacheTokens >= result.firstMsgTokens &&
      result.firstMsgCacheTokens <= result.cacheTokens;
  if (!valid) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: out-of-range checkpoint metadata in '%s'\n",
            __func__,
            path.c_str()));
  }
  const auto fileSizeAfter = std::filesystem::file_size(path, sizeEc);
  const auto modifiedAfter = std::filesystem::last_write_time(path, sizeEc);
  if (sizeEc || fileSizeAfter != fileSizeBefore ||
      modifiedAfter != modifiedBefore) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "%s: checkpoint artifact changed during inspection: '%s'\n",
            __func__,
            path.c_str()));
  }
  return {
      .metadata = result,
      .identity =
          {
              .fileSize = fileSizeAfter,
              .modifiedTicks = static_cast<int64_t>(
                  modifiedAfter.time_since_epoch().count()),
          },
  };
}

bool CacheManager::reserveCacheArtifact(const std::string& path) {
  std::scoped_lock lock(CACHE_RESERVATION_MUTEX);
  return RESERVED_CACHE_ARTIFACTS.insert(path).second;
}

void CacheManager::releaseCacheArtifact(const std::string& path) noexcept {
  if (path.empty()) {
    return;
  }
  std::scoped_lock lock(CACHE_RESERVATION_MUTEX);
  RESERVED_CACHE_ARTIFACTS.erase(path);
}

void CacheManager::releaseTransactionReservation() noexcept {
  releaseCacheArtifact(reservedTransactionPath_);
  reservedTransactionPath_.clear();
}

void CacheManager::invalidate() {
  releaseTransactionReservation();
  sessionPath_.clear();
  cacheDisabled_ = true;
  cacheUsedInLastPrompt_ = false;
  activeCacheSavedToDisk_ = false;
  committedArtifactKnownValid_ = false;
}

bool CacheManager::isCacheDisabled() const { return cacheDisabled_; }

bool CacheManager::hasActiveCache() const {
  return !cacheDisabled_ && !sessionPath_.empty();
}
bool CacheManager::wasCacheUsedInLastPrompt() const {
  return cacheUsedInLastPrompt_;
}
