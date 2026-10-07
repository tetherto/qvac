#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <llama.h>

#include "LlmContext.hpp"
#include "MediaLoadOrder.hpp"
#include "common/chat.h"

struct ParsedPromptPayload {
  std::vector<common_chat_msg> chatMsgs;
  std::vector<common_chat_tool> tools;
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

namespace qvac_lib_inference_addon_llama::batching {
class SlotStateCache;
struct SlotStateCacheEntry;
} // namespace qvac_lib_inference_addon_llama::batching

class CacheManager {
public:
  CacheManager(
      LlmContext* llmContext, std::function<void(bool)> resetStateCallback);

  bool handleCache(
      ParsedPromptPayload& parsedPrompt, const std::string& inputPrompt,
      std::function<ParsedPromptPayload(const std::string&)> formatPrompt,
      const std::string& cacheKey = "", bool ephemeral = false);

  bool loadCache();
  void saveCache();
  void invalidate();
  bool isCacheDisabled() const;
  bool hasActiveCache() const;
  bool wasCacheUsedInLastPrompt() const;
  static void atomicPromoteFile(const std::string& from, const std::string& to);
  /// The file at `path` (or its directory) is gone or empty: a caller that
  /// deleted it dropped the conversation it held.
  static bool persistedBackingStoreMissing(const std::string& path);

  /// Host-RAM tier shared with the batch scheduler (`cache_ram_mib`). When
  /// enabled, a key switch or a request without `cacheKey` moves the active
  /// conversation there instead of writing its file, and switching back
  /// restores it from there.
  void setRamTier(
      std::shared_ptr<qvac_lib_inference_addon_llama::batching::SlotStateCache>
          ramTier);

  /// Writes the active conversation to its file if it has unsaved turns and
  /// is not ephemeral. Run when the model is reloaded or unloaded.
  void flushForUnload();

  /// `flushForUnload` for a reset the caller must not survive silently
  /// (finetune): same conditions, but a failed write throws.
  void saveBeforeReset();

  enum class SaveOutcome { NotHere, Written, Current };

  /// The caller's explicit save (`saveCache`): writes the active conversation
  /// to its file when it is `cacheKey` and the file does not already hold it,
  /// ephemeral or not. A failed write throws `UnableToSaveSessionFile` and
  /// keeps the conversation, still marked unsaved.
  SaveOutcome saveForCaller(const std::string& cacheKey);

  /// The caller's explicit discard (`discardCache`): drops the active
  /// conversation when it is `cacheKey`, and its RAM-tier entry, without
  /// writing either.
  void discard(const std::string& cacheKey);

private:
  /// The active conversation has turns its file lacks and may be written:
  /// dirty, not ephemeral, not empty, and its file was not deleted.
  bool hasTurnsToFlush();
  void saveActiveCacheForTransition();
  /// Moves the active conversation into the RAM tier; false when the tier is
  /// off or the state does not fit it.
  bool moveActiveCacheToRamTier();
  /// Restores `sessionPath_` from `entry`, already taken from the RAM tier;
  /// false when there is none or it is not usable.
  bool restoreFromRamTier(
      std::optional<
          qvac_lib_inference_addon_llama::batching::SlotStateCacheEntry>
          entry);
  /// Checks a state just put in memory against its ledger `stateTokens` and
  /// adopts it, rolling the sequence back when it does not match. False for a
  /// pre-ledger state; throws for a malformed one.
  bool acceptLoadedState(
      std::vector<llama_token>& stateTokens, const std::string& source);
  bool discardActiveCacheIfBackingStoreMissing();
  void writeCacheFile(const std::string& path);
  static bool isFileInitialized(const std::filesystem::path& path);
  static bool isFileMissingOrEmpty(const std::filesystem::path& path);
  static bool isParentDirectoryMissing(const std::filesystem::path& path);

  LlmContext* llmContext_;
  std::function<void(bool)> resetStateCallback_;
  std::string sessionPath_;
  bool cacheDisabled_ = true;
  bool cacheUsedInLastPrompt_ = false;
  bool activeCacheSavedToDisk_ = false;
  /// The active conversation has turns its file does not hold. Set whenever a
  /// keyed request runs on it, cleared by a save or a load.
  bool activeCacheDirty_ = false;
  /// The active conversation's last request set `ephemeral`: it is never
  /// written automatically, so setting it aside drops it (or moves it to the
  /// RAM tier, which drops it in turn).
  bool activeEphemeral_ = false;
  std::shared_ptr<qvac_lib_inference_addon_llama::batching::SlotStateCache>
      ramTier_;
};
