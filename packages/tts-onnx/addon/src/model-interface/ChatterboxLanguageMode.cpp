#include "ChatterboxLanguageMode.hpp"

#include <algorithm>
#include <cstdlib>
#include <stdexcept>

#include <utf8proc.h>

namespace qvac::ttslib::chatterbox::lang_mode {

namespace {

constexpr size_t kMinMultilingualInputArity = 3;
constexpr const char *kSpaceToken = "[SPACE]";
constexpr size_t kMaxUtf8CharBytes = 4;

bool containsInputName(const std::vector<std::string> &inputNames,
                       const std::string &target) {
  return std::find(inputNames.begin(), inputNames.end(), target) !=
         inputNames.end();
}

std::string foldToLowercaseUtf8(const utf8proc_uint8_t *normalized) {
  std::string result;
  const auto *cursor = normalized;
  utf8proc_ssize_t remaining =
      static_cast<utf8proc_ssize_t>(std::char_traits<char>::length(
          reinterpret_cast<const char *>(normalized)));
  while (remaining > 0) {
    utf8proc_int32_t codepoint = 0;
    const utf8proc_ssize_t advance =
        utf8proc_iterate(cursor, remaining, &codepoint);
    if (advance <= 0) {
      break;
    }
    const utf8proc_int32_t lower = utf8proc_tolower(codepoint);
    utf8proc_uint8_t buffer[kMaxUtf8CharBytes];
    const utf8proc_ssize_t encoded = utf8proc_encode_char(lower, buffer);
    if (encoded > 0) {
      result.append(reinterpret_cast<const char *>(buffer),
                    static_cast<size_t>(encoded));
    }
    cursor += advance;
    remaining -= advance;
  }
  return result;
}

} // namespace

bool supportsMultilingualEmbedInputs(
    const std::vector<std::string> &inputNames) {
  const bool hasPositionIds = containsInputName(inputNames, "position_ids");
  const bool hasLanguageId = containsInputName(inputNames, "language_id");
  return (hasPositionIds && hasLanguageId) ||
         inputNames.size() >= kMinMultilingualInputArity;
}

bool shouldUseEnglishMode(const std::string &requestedLanguage,
                          const std::vector<std::string> &embedInputNames) {
  if (requestedLanguage == "en") {
    return true;
  }
  return !supportsMultilingualEmbedInputs(embedInputNames);
}

std::string applyLowercaseNfkd(const std::string &text) {
  utf8proc_uint8_t *normalized =
      utf8proc_NFKD(reinterpret_cast<const utf8proc_uint8_t *>(text.c_str()));
  if (normalized == nullptr) {
    throw std::runtime_error("utf8proc_NFKD failed for text normalization");
  }
  std::string result = foldToLowercaseUtf8(normalized);
  std::free(normalized);
  return result;
}

std::string replaceSpacesWithToken(const std::string &text) {
  std::string result;
  result.reserve(text.size());
  for (const char ch : text) {
    if (ch == ' ') {
      result += kSpaceToken;
    } else {
      result += ch;
    }
  }
  return result;
}

std::string prepareTextForTokenization(const std::string &text,
                                       const std::string &language,
                                       const bool isEnglishMode) {
  if (isEnglishMode || language == "en") {
    return text;
  }
  const std::string normalized = applyLowercaseNfkd(text);
  const std::string prefixed = "[" + language + "]" + normalized;
  return replaceSpacesWithToken(prefixed);
}

} // namespace qvac::ttslib::chatterbox::lang_mode
