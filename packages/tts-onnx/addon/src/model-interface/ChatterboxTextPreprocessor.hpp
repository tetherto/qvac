#pragma once

#include <filesystem>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

struct mecab_t;
struct mecab_node_t;

namespace qvac::ttslib::chatterbox::text_preprocess {

using CangjieTable = std::unordered_map<uint32_t, std::string>;

class ChatterboxTextPreprocessor {
public:
  ChatterboxTextPreprocessor() = default;
  ~ChatterboxTextPreprocessor();

  ChatterboxTextPreprocessor(const ChatterboxTextPreprocessor &) = delete;
  ChatterboxTextPreprocessor &
  operator=(const ChatterboxTextPreprocessor &) = delete;
  ChatterboxTextPreprocessor(ChatterboxTextPreprocessor &&) noexcept;
  ChatterboxTextPreprocessor &operator=(ChatterboxTextPreprocessor &&) noexcept;

  void loadCangjieTable(const std::filesystem::path &tsvPath);
  void loadMeCab(const std::filesystem::path &dicPath);
  void reset();

  size_t cangjieTableSize() const;

  std::string preprocess(const std::string &text,
                         const std::string &language) const;

  std::string decomposeKoreanToJamo(const std::string &text) const;
  std::string convertKatakanaToHiragana(const std::string &text) const;
  std::string convertChineseToCangjie(const std::string &text) const;
  std::string convertJapaneseWithMeCab(const std::string &text) const;

  static std::vector<uint32_t> decodeUtf8(const std::string &text);
  static std::string encodeCodepoint(uint32_t cp);

private:
  void appendNodeReading(const mecab_node_t *node, std::string &result) const;
  void warnMissingReading(const std::string &surface, unsigned int stat) const;
  std::string buildHiraganaFromNodes(const mecab_node_t *node) const;

  CangjieTable cangjieTable_;

  struct MeCabDeleter {
    void operator()(mecab_t *p) const;
  };
  std::unique_ptr<mecab_t, MeCabDeleter> mecabTagger_;
};

} // namespace qvac::ttslib::chatterbox::text_preprocess
