#pragma once

#include <filesystem>
#include <functional>
#include <string>
#include <vector>

#include <llama.h>

#include "LlmContext.hpp"
#include "common/chat.h"

class CacheManager {
public:
  CacheManager(
      LlmContext* llmContext, llama_pos configuredNDiscarded,
      std::function<void(bool)> resetStateCallback);

  bool handleCache(
      std::vector<common_chat_msg>& chatMsgs,
      std::vector<common_chat_tool>& tools, const std::string& inputPrompt,
      std::function<std::pair<
          std::vector<common_chat_msg>, std::vector<common_chat_tool>>(
          const std::string&)>
          formatPrompt);

  bool loadCache();
  void saveCache();
  bool isCacheDisabled() const;
  bool hasActiveCache() const;
  bool wasCacheUsedInLastPrompt() const;

private:
  static bool isFileInitialized(const std::filesystem::path& path);

  LlmContext* llmContext_;
  llama_pos configuredNDiscarded_;
  std::function<void(bool)> resetStateCallback_;
  std::string sessionPath_;
  bool cacheDisabled_ = true;
  bool cacheUsedInLastPrompt_ = false;
};
