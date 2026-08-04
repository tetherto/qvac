#pragma once

#include <cstdint>

#include <llama.h>

namespace qvac_lib_inference_addon_llama {

struct SessionCheckpointMetadata {
  llama_pos nPast = 0;
  llama_pos firstMsgTokens = 0;
  llama_pos cacheTokens = 0;
  llama_pos firstMsgCacheTokens = 0;
};

struct CacheArtifactIdentity {
  uintmax_t fileSize = 0;
  int64_t modifiedTicks = 0;

  bool operator==(const CacheArtifactIdentity&) const = default;
};

} // namespace qvac_lib_inference_addon_llama
