#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>
#include <vector>

#include <llama.h>

#include "LlmContext.hpp"
#include "MediaLoadOrder.hpp"
#include "ToolsCompactController.hpp"
#include "common/chat.h"

struct ParsedPromptPayload {
  std::vector<common_chat_msg> chatMsgs;
  std::vector<common_chat_tool> tools;
  PromptLayout layout;
  /// Absolute file paths of string-mode media messages, in prompt order. The
  /// single-prompt path collects them here; `formatPrompt` only collects them
  /// and never loads media itself. Both paths now load via `mediaPlan`.
  std::vector<std::string> mediaPaths;
  /// Every media marker in prompt order, byte buffers and paths interleaved as
  /// they appear in the prompt. Used by both the single-prompt and batch paths
  /// to load media in the same order the MTMD markers are emitted, so bitmaps
  /// bind to the correct markers (see `computeMediaLoadOrder`).
  std::vector<PlannedMedia> mediaPlan;
};

struct CommittedCacheCheckpoint {
  qvac_lib_inference_addon_llama::SessionCheckpointMetadata metadata;
  qvac_lib_inference_addon_llama::CacheArtifactIdentity identity;
};

class CacheManager {
public:
  CacheManager(
      LlmContext* llmContext, llama_pos configuredNDiscarded,
      std::function<void(bool)> resetStateCallback);
  ~CacheManager();

  bool handleCache(
      ParsedPromptPayload& parsedPrompt, const std::string& inputPrompt,
      std::function<ParsedPromptPayload(const std::string&)> formatPrompt,
      const std::string& cacheKey = "");

  bool loadCache();
  void saveCache();
  void prepareTransactionCheckpoint(bool persistent);
  void markActiveCacheDirty();
  void invalidate();
  bool isCacheDisabled() const;
  bool hasActiveCache() const;
  bool wasCacheUsedInLastPrompt() const;
  static void atomicPromoteFile(const std::string& from, const std::string& to);
  static CommittedCacheCheckpoint inspectCommittedCacheArtifact(
      const std::string& path, llama_pos maxContext);
  static bool reserveCacheArtifact(const std::string& path);
  static void releaseCacheArtifact(const std::string& path) noexcept;
  void releaseTransactionReservation() noexcept;

private:
  void saveActiveCacheForTransition();
  bool discardActiveCacheIfBackingStoreMissing();
  void writeCacheFile(const std::string& path);
  static bool isFileInitialized(const std::filesystem::path& path);
  static bool isFileMissingOrEmpty(const std::filesystem::path& path);
  static bool isParentDirectoryMissing(const std::filesystem::path& path);

  LlmContext* llmContext_;
  llama_pos configuredNDiscarded_;
  std::function<void(bool)> resetStateCallback_;
  std::string sessionPath_;
  bool cacheDisabled_ = true;
  bool cacheUsedInLastPrompt_ = false;
  bool activeCacheSavedToDisk_ = false;
  bool committedArtifactKnownValid_ = false;
  std::string reservedTransactionPath_;
};
