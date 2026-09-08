#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "LogSafeString.hpp"

namespace qvac_lib_inference_addon_llama {
namespace utils {

/**
 * @brief Whether a window of recent output has hit a stop string.
 *
 * The two lists match by deliberately different rules, which is the whole
 * reason this lives in one shared function instead of being open-coded in
 * each LLM context:
 *
 *  - `antipromptsLower` are caller-supplied antiprompts (the load-time
 *    `params_.antiprompt`), matched case-insensitively so a caller does not
 *    have to enumerate every casing a model might emit. Entries must already
 *    be lowercased by the caller, which keeps the fold off this hot path.
 *
 *  - `templateStops` are protocol delimiters the chat template produced
 *    (fabric's PEG auto-parser pushes `"</assistant>"` for laguna_glm_thinking
 *    templates), matched byte-for-byte. Case-folding them would be wrong, not
 *    merely lax: llama-server terminates on an exact `text.find(word)`, and a
 *    folded `</assistant>` also fires on a `</ASSISTANT>` the template never
 *    emits — truncating ordinary content that happens to name the tag in
 *    upper case.
 *
 * Matching scans the whole window rather than its tail because one token can
 * decode to many characters, so a short stop like "\n" may sit at the start of
 * such a token, far from the string's end.
 */
inline bool matchesAnyStopString(
    std::string_view recentOutput,
    const std::vector<std::string>& antipromptsLower,
    const std::vector<std::string>& templateStops) {
  // Folded once, and only when there is something to compare against it: a
  // model whose template supplies stops but whose caller supplied no
  // antiprompts pays no allocation here.
  if (!antipromptsLower.empty()) {
    const std::string recentLower = toLowerAscii(recentOutput);
    for (const std::string& antiprompt : antipromptsLower) {
      if (recentLower.find(antiprompt) != std::string::npos) {
        return true;
      }
    }
  }
  for (const std::string& stop : templateStops) {
    if (recentOutput.find(stop) != std::string_view::npos) {
      return true;
    }
  }
  return false;
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
