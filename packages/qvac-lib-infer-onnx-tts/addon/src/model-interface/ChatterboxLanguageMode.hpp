#pragma once

#include <string>
#include <vector>

namespace qvac::ttslib::chatterbox::lang_mode {

bool supportsMultilingualEmbedInputs(
    const std::vector<std::string> &inputNames);

bool shouldUseEnglishMode(const std::string &requestedLanguage,
                          const std::vector<std::string> &embedInputNames);

std::string applyLowercaseNfkd(const std::string &text);

std::string replaceSpacesWithToken(const std::string &text);

std::string prepareTextForTokenization(const std::string &text,
                                       const std::string &language,
                                       bool isEnglishMode);

} // namespace qvac::ttslib::chatterbox::lang_mode
