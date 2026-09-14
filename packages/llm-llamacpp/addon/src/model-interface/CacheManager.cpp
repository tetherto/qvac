#include "CacheManager.hpp"

#include <filesystem>
#include <system_error>

#include <inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"
#include "utils/LoggingMacros.hpp"

#ifdef _WIN32
#include <windows.h>
#endif

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

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
  // Keep every cache entry point on the driver's virtual lifecycle. The
  // derived context also owns the MTP draft state, which a target-only restore
  // cannot synchronize.
  return llmContext_->loadCache(sessionPath_);
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
  QLOG_IF(
      Priority::DEBUG,
      string_format("%s: saving cache to '%s'\n", __func__, path.c_str()));
  llmContext_->saveCache(path);
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
}

bool CacheManager::isCacheDisabled() const { return cacheDisabled_; }

bool CacheManager::hasActiveCache() const {
  return !cacheDisabled_ && !sessionPath_.empty();
}
bool CacheManager::wasCacheUsedInLastPrompt() const {
  return cacheUsedInLastPrompt_;
}
