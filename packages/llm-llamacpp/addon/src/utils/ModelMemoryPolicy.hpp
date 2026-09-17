#pragma once

namespace qvac_lib_inference_addon_llama::utils {

// Full-state snapshots are required by recurrent and hybrid models, and by
// DeepSeek V4 whose compressed cache has the same checkpoint/restore
// requirement despite not reporting either model predicate.
[[nodiscard]] inline bool needsFullStateSnapshot(
    bool isRecurrent, bool isHybrid, bool isDeepSeekV4) noexcept {
  return isRecurrent || isHybrid || isDeepSeekV4;
}

} // namespace qvac_lib_inference_addon_llama::utils
