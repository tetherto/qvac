#pragma once

#include <filesystem>
#include <functional>
#include <string>
#include <vector>

#include <llama.h>

#include "LlmContext.hpp"
#include "ToolsCompactController.hpp"
#include "common/chat.h"

struct ParsedPromptPayload {
  std::vector<common_chat_msg> chatMsgs;
  std::vector<common_chat_tool> tools;
  PromptLayout layout;
};

class CacheManager {
public:
  CacheManager(
      LlmContext* llmContext, llama_pos configuredNDiscarded,
      std::function<void(bool)> resetStateCallback);

  bool handleCache(
      ParsedPromptPayload& parsedPrompt, const std::string& inputPrompt,
      std::function<ParsedPromptPayload(const std::string&)> formatPrompt,
      const std::string& cacheKey = "");

  bool loadCache();
  void saveCache();
  void invalidate();
  bool isCacheDisabled() const;
  bool hasActiveCache() const;
  bool wasCacheUsedInLastPrompt() const;

private:
  void writeCacheFile(const std::string& path);
  static bool isFileInitialized(const std::filesystem::path& path);

  LlmContext* llmContext_;
  llama_pos configuredNDiscarded_;
  std::function<void(bool)> resetStateCallback_;
  std::string sessionPath_;
  bool cacheDisabled_ = true;
  bool cacheUsedInLastPrompt_ = false;
};
