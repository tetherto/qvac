#pragma once

#include <string>
#include <unordered_map>
#include <vector>

namespace qvac::ttslib::chatterbox::text_preprocess {

using CangjieTable = std::unordered_map<uint32_t, std::string>;

std::string preprocessText(const std::string &text, const std::string &language,
                           const CangjieTable &cangjieTable);

std::string decomposeKoreanToJamo(const std::string &text);

std::string convertKatakanaToHiragana(const std::string &text);

std::string convertChineseToCangjie(const std::string &text,
                                    const CangjieTable &table);

CangjieTable loadCangjieTable(const std::string &tsvPath);

std::vector<uint32_t> decodeUtf8(const std::string &text);

std::string encodeCodepoint(uint32_t cp);

} // namespace qvac::ttslib::chatterbox::text_preprocess
