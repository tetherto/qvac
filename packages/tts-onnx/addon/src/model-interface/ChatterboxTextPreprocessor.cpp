#include "ChatterboxTextPreprocessor.hpp"

#include <iostream>
#include <sstream>
#include <stdexcept>

#include <mecab/mecab.h>

#include "FileUtils.hpp"
#include "inference-addon-cpp/Logger.hpp"

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

const uint32_t HIRAGANA_START = 0x3041;
const uint32_t HIRAGANA_END = 0x309F;

const int IPADIC_READING_FIELD_INDEX = 7;

bool isHangulSyllable(uint32_t cp) {
  return cp >= HANGUL_SYLLABLE_BASE && cp <= HANGUL_SYLLABLE_END;
}

bool isKatakana(uint32_t cp) {
  return cp >= KATAKANA_START && cp <= KATAKANA_END;
}

bool isHiragana(uint32_t cp) {
  return cp >= HIRAGANA_START && cp <= HIRAGANA_END;
}

bool isCjkIdeograph(uint32_t cp) {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
         (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0x2A700 && cp <= 0x2B73F) ||
         (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF) ||
         (cp >= 0x2CEB0 && cp <= 0x2EBEF) || (cp >= 0x30000 && cp <= 0x3134F) ||
         (cp >= 0xF900 && cp <= 0xFAFF);
}

bool isJapaneseCodepoint(uint32_t cp) {
  return isHiragana(cp) || isKatakana(cp) || isCjkIdeograph(cp);
}

bool containsJapanese(const std::string &text) {
  std::vector<uint32_t> codepoints =
      ChatterboxTextPreprocessor::decodeUtf8(text);
  for (uint32_t cp : codepoints) {
    if (isJapaneseCodepoint(cp)) {
      return true;
    }
  }
  return false;
}

void appendJamoForSyllable(uint32_t cp, std::string &result) {
  int syllableIndex = static_cast<int>(cp - HANGUL_SYLLABLE_BASE);
  int initialIdx = syllableIndex / (JAMO_MEDIAL_COUNT * JAMO_FINAL_COUNT);
  int medialIdx = (syllableIndex % (JAMO_MEDIAL_COUNT * JAMO_FINAL_COUNT)) /
                  JAMO_FINAL_COUNT;
  int finalIdx = syllableIndex % JAMO_FINAL_COUNT;

  result += ChatterboxTextPreprocessor::encodeCodepoint(JAMO_INITIAL_BASE +
                                                        initialIdx);
  result +=
      ChatterboxTextPreprocessor::encodeCodepoint(JAMO_MEDIAL_BASE + medialIdx);
  if (finalIdx > 0) {
    result += ChatterboxTextPreprocessor::encodeCodepoint(JAMO_FINAL_BASE +
                                                          finalIdx - 1);
  }
}

std::string extractReading(const char *feature) {
  int fieldIdx = 0;
  const char *start = feature;
  while (*start) {
    if (fieldIdx == IPADIC_READING_FIELD_INDEX) {
      const char *end = start;
      while (*end && *end != ',') {
        ++end;
      }
      return std::string(start, end);
    }
    if (*start == ',') {
      ++fieldIdx;
    }
    ++start;
  }
  return "";
}

} // namespace

void ChatterboxTextPreprocessor::MeCabDeleter::operator()(mecab_t *p) const {
  if (p) {
    mecab_destroy(p);
  }
}

ChatterboxTextPreprocessor::~ChatterboxTextPreprocessor() = default;

ChatterboxTextPreprocessor::ChatterboxTextPreprocessor(
    ChatterboxTextPreprocessor &&) noexcept = default;

ChatterboxTextPreprocessor &ChatterboxTextPreprocessor::operator=(
    ChatterboxTextPreprocessor &&) noexcept = default;

namespace {

int detectSequenceLength(unsigned char byte) {
  if (byte < 0x80)
    return 1;
  if ((byte & 0xE0) == 0xC0)
    return 2;
  if ((byte & 0xF0) == 0xE0)
    return 3;
  if ((byte & 0xF8) == 0xF0)
    return 4;
  return 0;
}

uint32_t extractLeadingBits(unsigned char byte, int seqLen) {
  switch (seqLen) {
  case 1:
    return byte;
  case 2:
    return byte & 0x1F;
  case 3:
    return byte & 0x0F;
  case 4:
    return byte & 0x07;
  default:
    return 0;
  }
}

uint32_t decodeCodepointAt(const unsigned char *bytes, size_t pos, size_t len,
                           int seqLen) {
  uint32_t cp = extractLeadingBits(bytes[pos], seqLen);
  for (int j = 1; j < seqLen && (pos + j) < len; ++j) {
    cp = (cp << 6) | (bytes[pos + j] & 0x3F);
  }
  return cp;
}

} // namespace

std::vector<uint32_t>
ChatterboxTextPreprocessor::decodeUtf8(const std::string &text) {
  std::vector<uint32_t> codepoints;
  const auto *bytes = reinterpret_cast<const unsigned char *>(text.data());
  size_t len = text.size();
  size_t i = 0;

  while (i < len) {
    int seqLen = detectSequenceLength(bytes[i]);
    if (seqLen == 0) {
      ++i;
      continue;
    }
    codepoints.push_back(decodeCodepointAt(bytes, i, len, seqLen));
    i += seqLen;
  }

  return codepoints;
}

std::string ChatterboxTextPreprocessor::encodeCodepoint(uint32_t cp) {
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

std::string ChatterboxTextPreprocessor::decomposeKoreanToJamo(
    const std::string &text) const {
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

std::string ChatterboxTextPreprocessor::convertKatakanaToHiragana(
    const std::string &text) const {
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

std::string ChatterboxTextPreprocessor::convertChineseToCangjie(
    const std::string &text) const {
  std::vector<uint32_t> codepoints = decodeUtf8(text);
  std::string result;
  result.reserve(text.size() * 3);

  for (uint32_t cp : codepoints) {
    if (isCjkIdeograph(cp)) {
      auto it = cangjieTable_.find(cp);
      if (it != cangjieTable_.end()) {
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

void ChatterboxTextPreprocessor::loadCangjieTable(
    const std::filesystem::path &tsvPath) {
  cangjieTable_.clear();
  std::string content = qvac::ttslib::loadFileBytes(tsvPath.string());
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
    if (charCp.size() == 1 &&
        cangjieTable_.find(charCp[0]) == cangjieTable_.end()) {
      cangjieTable_[charCp[0]] = code;
    }
  }
}

void ChatterboxTextPreprocessor::loadMeCab(
    const std::filesystem::path &dicPath) {
  std::filesystem::path rcPath = dicPath / "mecabrc";
  std::cerr << ">>> [MECAB-CPP] loadMeCab called with dicPath='"
            << dicPath.string() << "' rcPath='" << rcPath.string() << "'"
            << std::endl;
  std::vector<std::string> argsStorage = {"mecab", "-r", rcPath.string(), "-d",
                                          dicPath.string()};
  std::vector<char *> argv;
  argv.reserve(argsStorage.size());
  for (std::string &arg : argsStorage) {
    argv.push_back(arg.data());
  }
  mecabTagger_.reset(mecab_new(static_cast<int>(argv.size()), argv.data()));
  if (!mecabTagger_) {
    const char *err = mecab_strerror(nullptr);
    std::string detail = err != nullptr ? err : "unknown";
    std::cerr << ">>> [MECAB-CPP] mecab_new FAILED: " << detail << std::endl;
    throw std::runtime_error("Failed to create MeCab tagger with dictionary: " +
                             dicPath.string() + " (" + detail + ")");
  }
  std::cerr << ">>> [MECAB-CPP] mecab_new OK, tagger=" << mecabTagger_.get()
            << std::endl;
}

void ChatterboxTextPreprocessor::reset() {
  cangjieTable_.clear();
  mecabTagger_.reset();
}

size_t ChatterboxTextPreprocessor::cangjieTableSize() const {
  return cangjieTable_.size();
}

namespace {

bool isContentNode(const mecab_node_t *node) {
  return node->stat != MECAB_BOS_NODE && node->stat != MECAB_EOS_NODE;
}

bool hasReading(const std::string &reading) {
  return !reading.empty() && reading != "*";
}

} // namespace

void ChatterboxTextPreprocessor::appendNodeReading(const mecab_node_t *node,
                                                   std::string &result) const {
  std::string reading = extractReading(node->feature);
  if (hasReading(reading)) {
    result += convertKatakanaToHiragana(reading);
    return;
  }
  std::string surface(node->surface, node->length);
  warnMissingReading(surface, node->stat);
  result += surface;
}

void ChatterboxTextPreprocessor::warnMissingReading(const std::string &surface,
                                                    unsigned int stat) const {
  if (!containsJapanese(surface)) {
    return;
  }
  std::ostringstream ss;
  ss << "MeCab: missing reading for Japanese surface '" << surface
     << "' (stat=" << stat
     << "); dictionary may be corrupt or out of date. Falling back to surface "
        "form, which will likely produce [UNK] tokens.";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING, ss.str());
}

std::string ChatterboxTextPreprocessor::buildHiraganaFromNodes(
    const mecab_node_t *node) const {
  std::string result;
  for (; node; node = node->next) {
    if (isContentNode(node)) {
      appendNodeReading(node, result);
    }
  }
  return result;
}

std::string ChatterboxTextPreprocessor::convertJapaneseWithMeCab(
    const std::string &text) const {
  std::cerr << ">>> [MECAB-CPP] convertJapaneseWithMeCab input='" << text
            << "' tagger=" << mecabTagger_.get() << std::endl;
  if (!mecabTagger_) {
    std::string fallback = convertKatakanaToHiragana(text);
    std::cerr << ">>> [MECAB-CPP] NO TAGGER, fallback='" << fallback << "'"
              << std::endl;
    return fallback;
  }

  const mecab_node_t *node =
      mecab_sparse_tonode(mecabTagger_.get(), text.c_str());
  if (!node) {
    std::string fallback = convertKatakanaToHiragana(text);
    std::cerr << ">>> [MECAB-CPP] mecab_sparse_tonode returned NULL, fallback='"
              << fallback << "'" << std::endl;
    return fallback;
  }

  std::string result = buildHiraganaFromNodes(node);
  std::cerr << ">>> [MECAB-CPP] convertJapaneseWithMeCab output='" << result
            << "'" << std::endl;
  return result;
}

std::string
ChatterboxTextPreprocessor::preprocess(const std::string &text,
                                       const std::string &language) const {
  if (language == "ko") {
    return decomposeKoreanToJamo(text);
  }
  if (language == "ja") {
    return convertJapaneseWithMeCab(text);
  }
  if (language == "zh") {
    return convertChineseToCangjie(text);
  }
  return text;
}

} // namespace qvac::ttslib::chatterbox::text_preprocess
