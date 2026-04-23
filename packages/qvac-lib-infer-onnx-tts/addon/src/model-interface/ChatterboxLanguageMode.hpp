#pragma once

#include <algorithm>
#include <string>
#include <vector>

namespace qvac::ttslib::chatterbox::lang_mode {

inline bool
supportsMultilingualEmbedInputs(const std::vector<std::string> &inputNames) {
  const bool hasPositionIds = std::find(inputNames.begin(), inputNames.end(),
                                        "position_ids") != inputNames.end();
  const bool hasLanguageId = std::find(inputNames.begin(), inputNames.end(),
                                       "language_id") != inputNames.end();
  return (hasPositionIds && hasLanguageId) || inputNames.size() >= 3;
}

inline bool
shouldUseEnglishMode(const std::string &requestedLanguage,
                     const std::vector<std::string> &embedInputNames) {
  if (requestedLanguage == "en") {
    return true;
  }
  return !supportsMultilingualEmbedInputs(embedInputNames);
}

inline std::string prepareTextForTokenization(const std::string &text,
                                              const std::string &language,
                                              const bool isEnglishMode) {
  if (isEnglishMode || language == "en") {
    return text;
  }
  return "[" + language + "]" + text;
}

} // namespace qvac::ttslib::chatterbox::lang_mode
