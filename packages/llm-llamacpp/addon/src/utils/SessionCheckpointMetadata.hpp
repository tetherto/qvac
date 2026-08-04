#pragma once

#include <llama.h>

namespace qvac_lib_inference_addon_llama {

struct SessionCheckpointMetadata {
  llama_pos nPast = 0;
  llama_pos firstMsgTokens = 0;
  llama_pos cacheTokens = 0;
  llama_pos firstMsgCacheTokens = 0;
};

} // namespace qvac_lib_inference_addon_llama
