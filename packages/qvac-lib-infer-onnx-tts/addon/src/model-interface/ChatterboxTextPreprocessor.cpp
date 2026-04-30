#include "ChatterboxTextPreprocessor.hpp"
#include "FileUtils.hpp"

#include <sstream>
#include <stdexcept>

namespace qvac::ttslib::chatterbox::text_preprocess {

namespace {

const uint32_t HANGUL_SYLLABLE_BASE = 0xAC00;
const uint32_t HANGUL_SYLLABLE_END = 0xD7A3;
const int JAMO_INITIAL_COUNT = 19;
const int JAMO_MEDIAL_COUNT = 21;
const int JAMO_FINAL_COUNT = 28;

const uint32_t JAMO_INITIAL_BASE = 0x1100;
const uint32_t JAMO_MEDIAL_BASE = 0x1161;
const uint32_t JAMO_FINAL_BASE = 0x11A8;

const uint32_t KATAKANA_START = 0x30A1;
const uint32_t KATAKANA_END = 0x30F6;
const uint32_t KATAKANA_TO_HIRAGANA_OFFSET = 0x60;

bool isHangulSyllable(uint32_t cp) {
  return cp >= HANGUL_SYLLABLE_BASE && cp <= HANGUL_SYLLABLE_END;
}

bool isKatakana(uint32_t cp) {
  return cp >= KATAKANA_START && cp <= KATAKANA_END;
}

bool isCjkIdeograph(uint32_t cp) {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
         (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0x2A700 && cp <= 0x2B73F) ||
         (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF) ||
         (cp >= 0x2CEB0 && cp <= 0x2EBEF) || (cp >= 0x30000 && cp <= 0x3134F) ||
         (cp >= 0xF900 && cp <= 0xFAFF);
}

void appendJamoForSyllable(uint32_t cp, std::string &result) {
  int syllableIndex = static_cast<int>(cp - HANGUL_SYLLABLE_BASE);
  int initialIdx = syllableIndex / (JAMO_MEDIAL_COUNT * JAMO_FINAL_COUNT);
  int medialIdx = (syllableIndex % (JAMO_MEDIAL_COUNT * JAMO_FINAL_COUNT)) /
                  JAMO_FINAL_COUNT;
  int finalIdx = syllableIndex % JAMO_FINAL_COUNT;

  result += encodeCodepoint(JAMO_INITIAL_BASE + initialIdx);
  result += encodeCodepoint(JAMO_MEDIAL_BASE + medialIdx);
  if (finalIdx > 0) {
    result += encodeCodepoint(JAMO_FINAL_BASE + finalIdx - 1);
  }
}

} // namespace

std::vector<uint32_t> decodeUtf8(const std::string &text) {
  std::vector<uint32_t> codepoints;
  const auto *bytes = reinterpret_cast<const unsigned char *>(text.data());
  size_t len = text.size();
  size_t i = 0;

  while (i < len) {
    uint32_t cp = 0;
    int seqLen = 0;

    if (bytes[i] < 0x80) {
      cp = bytes[i];
      seqLen = 1;
    } else if ((bytes[i] & 0xE0) == 0xC0) {
      cp = bytes[i] & 0x1F;
      seqLen = 2;
    } else if ((bytes[i] & 0xF0) == 0xE0) {
      cp = bytes[i] & 0x0F;
      seqLen = 3;
    } else if ((bytes[i] & 0xF8) == 0xF0) {
      cp = bytes[i] & 0x07;
      seqLen = 4;
    } else {
      ++i;
      continue;
    }

    for (int j = 1; j < seqLen && (i + j) < len; ++j) {
      cp = (cp << 6) | (bytes[i + j] & 0x3F);
    }

    codepoints.push_back(cp);
    i += seqLen;
  }

  return codepoints;
}

std::string encodeCodepoint(uint32_t cp) {
  std::string result;
  if (cp < 0x80) {
    result += static_cast<char>(cp);
  } else if (cp < 0x800) {
    result += static_cast<char>(0xC0 | (cp >> 6));
    result += static_cast<char>(0x80 | (cp & 0x3F));
  } else if (cp < 0x10000) {
    result += static_cast<char>(0xE0 | (cp >> 12));
    result += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    result += static_cast<char>(0x80 | (cp & 0x3F));
  } else {
    result += static_cast<char>(0xF0 | (cp >> 18));
    result += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
    result += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    result += static_cast<char>(0x80 | (cp & 0x3F));
  }
  return result;
}

std::string decomposeKoreanToJamo(const std::string &text) {
  std::vector<uint32_t> codepoints = decodeUtf8(text);
  std::string result;
  result.reserve(text.size() * 2);

  for (uint32_t cp : codepoints) {
    if (isHangulSyllable(cp)) {
      appendJamoForSyllable(cp, result);
    } else {
      result += encodeCodepoint(cp);
    }
  }

  return result;
}

std::string convertKatakanaToHiragana(const std::string &text) {
  std::vector<uint32_t> codepoints = decodeUtf8(text);
  std::string result;
  result.reserve(text.size());

  for (uint32_t cp : codepoints) {
    if (isKatakana(cp)) {
      result += encodeCodepoint(cp - KATAKANA_TO_HIRAGANA_OFFSET);
    } else {
      result += encodeCodepoint(cp);
    }
  }

  return result;
}

std::string convertChineseToCangjie(const std::string &text,
                                    const CangjieTable &table) {
  std::vector<uint32_t> codepoints = decodeUtf8(text);
  std::string result;
  result.reserve(text.size() * 3);

  for (uint32_t cp : codepoints) {
    if (isCjkIdeograph(cp)) {
      auto it = table.find(cp);
      if (it != table.end()) {
        result += it->second;
      } else {
        result += encodeCodepoint(cp);
      }
    } else {
      result += encodeCodepoint(cp);
    }
  }

  return result;
}

CangjieTable loadCangjieTable(const std::string &tsvPath) {
  CangjieTable table;
  std::string content = qvac::ttslib::loadFileBytes(tsvPath);
  std::istringstream stream(content);
  std::string line;

  while (std::getline(stream, line)) {
    if (line.empty()) {
      continue;
    }
    size_t tabPos = line.find('\t');
    if (tabPos == std::string::npos) {
      continue;
    }

    std::string character = line.substr(0, tabPos);
    std::string code = line.substr(tabPos + 1);

    std::vector<uint32_t> charCp = decodeUtf8(character);
    if (charCp.size() == 1 && table.find(charCp[0]) == table.end()) {
      table[charCp[0]] = code;
    }
  }

  return table;
}

std::string preprocessText(const std::string &text, const std::string &language,
                           const CangjieTable &cangjieTable) {
  if (language == "ko") {
    return decomposeKoreanToJamo(text);
  }
  if (language == "ja") {
    return convertKatakanaToHiragana(text);
  }
  if (language == "zh") {
    return convertChineseToCangjie(text, cangjieTable);
  }
  return text;
}

} // namespace qvac::ttslib::chatterbox::text_preprocess
