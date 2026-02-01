#pragma once

#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <onnxruntime_cxx_api.h>

namespace qvac::ttslib::tashkeel {

/**
 * TashkeelDiacritizer - Arabic text diacritization using ONNX model
 *
 * Adds Arabic diacritical marks (harakat) to undiacritized Arabic text.
 * Based on libtashkeel: https://github.com/mush42/libtashkeel
 */
class TashkeelDiacritizer {
public:
  static constexpr size_t CHAR_LIMIT = 12000;
  static constexpr char PAD_CHAR = '_';
  static constexpr char NUMERAL_SYMBOL = '#';

  TashkeelDiacritizer();
  ~TashkeelDiacritizer();

  /**
   * Initialize the diacritizer with the model directory path
   * @param modelDir Path to directory containing model.onnx and JSON maps
   * @return true if initialization succeeded
   */
  bool initialize(const std::string &modelDir);

  /**
   * Check if the diacritizer is initialized
   */
  bool isInitialized() const { return initialized_; }

  /**
   * Add diacritics to Arabic text
   * @param text Input Arabic text (may be partially diacritized)
   * @param taskeen_threshold Optional threshold for sukoon insertion (0.0-1.0)
   * @return Diacritized text
   */
  std::string diacritize(const std::string &text,
                         std::optional<float> taskeen_threshold = 0.8f);

  /**
   * Check if a character is an Arabic diacritic
   */
  static bool isDiacriticChar(char32_t c);

  /**
   * Check if a character is an Arabic numeral
   */
  static bool isNumeral(char32_t c);

private:
  // JSON map loading
  bool loadInputIdMap(const std::string &path);
  bool loadTargetIdMap(const std::string &path);
  bool loadHintIdMap(const std::string &path);

  // Text preprocessing
  std::pair<std::u32string, std::unordered_set<char32_t>>
  toValidChars(const std::u32string &text);
  std::pair<std::u32string, std::vector<std::u32string>>
  extractCharsAndDiacritics(const std::u32string &text,
                            bool normalizeDiacritics = true);

  // ID conversion
  std::vector<int64_t> inputToIds(const std::u32string &text);
  std::vector<int64_t> hintToIds(const std::vector<std::u32string> &diacritics);
  std::vector<std::u32string>
  targetToDiacritics(const std::vector<uint8_t> &targetIds);

  // Inference
  std::pair<std::vector<uint8_t>, std::vector<float>>
  infer(const std::vector<int64_t> &inputIds,
        const std::vector<int64_t> &diacIds, int64_t seqLength);

  // Post-processing
  std::string
  annotateTextWithDiacritics(const std::u32string &inputText,
                             const std::vector<std::u32string> &diacritics,
                             const std::unordered_set<char32_t> &removedChars);

  std::string annotateTextWithDiacriticsTaskeen(
      const std::u32string &inputText,
      const std::vector<std::u32string> &diacritics,
      const std::unordered_set<char32_t> &removedChars,
      const std::vector<float> &logits, float threshold);

  // UTF-8 <-> UTF-32 conversion
  static std::u32string utf8ToUtf32(const std::string &utf8);
  static std::string utf32ToUtf8(const std::u32string &utf32);
  static std::string utf32CharToUtf8(char32_t c);

  // ONNX Runtime
  std::unique_ptr<Ort::Env> env_;
  std::unique_ptr<Ort::Session> session_;
  Ort::MemoryInfo memoryInfo_{nullptr};

  // Character maps
  std::unordered_map<char32_t, int> inputIdMap_;
  std::unordered_map<int, std::u32string> idTargetMap_;
  std::unordered_map<std::u32string, int> hintIdMap_;
  std::unordered_set<int> targetIdMetaChars_;

  // Diacritic normalization map
  std::unordered_map<std::u32string, std::u32string> normalizedDiacMap_;

  bool initialized_ = false;

  // Arabic diacritics (harakat) Unicode codepoints
  static const std::unordered_set<char32_t> ARABIC_DIACRITICS;
  static const std::unordered_set<char32_t> HARAKAT_CHARS;
  static const std::unordered_set<char32_t> NUMERALS;
  static constexpr char32_t SUKOON = 0x0652;
};

} // namespace qvac::ttslib::tashkeel
