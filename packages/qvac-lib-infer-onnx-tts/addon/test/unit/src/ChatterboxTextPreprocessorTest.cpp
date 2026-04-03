#include "src/model-interface/ChatterboxTextPreprocessor.hpp"

#include <gtest/gtest.h>

namespace qvac::ttslib::chatterbox::text_preprocess::testing {

class Utf8Test : public ::testing::Test {};

TEST_F(Utf8Test, decodesAscii) {
  auto cps = decodeUtf8("abc");
  ASSERT_EQ(cps.size(), 3u);
  EXPECT_EQ(cps[0], 'a');
  EXPECT_EQ(cps[1], 'b');
  EXPECT_EQ(cps[2], 'c');
}

TEST_F(Utf8Test, decodesMultibyteCharacters) {
  auto cps = decodeUtf8("\xED\x95\x9C");
  ASSERT_EQ(cps.size(), 1u);
  EXPECT_EQ(cps[0], 0xD55C);
}

TEST_F(Utf8Test, encodesAsciiCodepoint) {
  EXPECT_EQ(encodeCodepoint('A'), "A");
}

TEST_F(Utf8Test, encodesMultibyteCodepoint) {
  std::string encoded = encodeCodepoint(0xD55C);
  EXPECT_EQ(encoded, "\xED\x95\x9C");
}

TEST_F(Utf8Test, roundTripsText) {
  std::string original = "Hello \xED\x95\x9C\xEA\xB8\x80";
  auto cps = decodeUtf8(original);
  std::string reconstructed;
  for (auto cp : cps) {
    reconstructed += encodeCodepoint(cp);
  }
  EXPECT_EQ(reconstructed, original);
}

class KoreanJamoTest : public ::testing::Test {};

TEST_F(KoreanJamoTest, decomposesHangulSyllable) {
  std::string result = decomposeKoreanToJamo("\xED\x95\x9C");
  auto cps = decodeUtf8(result);
  ASSERT_EQ(cps.size(), 3u);
  EXPECT_EQ(cps[0], 0x1112);
  EXPECT_EQ(cps[1], 0x1161);
  EXPECT_EQ(cps[2], 0x11AB);
}

TEST_F(KoreanJamoTest, decomposesWithoutFinalConsonant) {
  std::string result = decomposeKoreanToJamo("\xEA\xB0\x80");
  auto cps = decodeUtf8(result);
  ASSERT_EQ(cps.size(), 2u);
  EXPECT_EQ(cps[0], 0x1100);
  EXPECT_EQ(cps[1], 0x1161);
}

TEST_F(KoreanJamoTest, preservesNonHangul) {
  std::string result = decomposeKoreanToJamo("Hello");
  EXPECT_EQ(result, "Hello");
}

TEST_F(KoreanJamoTest, handlesMixedText) {
  std::string input = std::string("A") + "\xED\x95\x9C" + "B";
  std::string result = decomposeKoreanToJamo(input);
  auto cps = decodeUtf8(result);
  EXPECT_EQ(cps[0], 'A');
  EXPECT_EQ(cps[1], 0x1112);
  EXPECT_EQ(cps[2], 0x1161);
  EXPECT_EQ(cps[3], 0x11AB);
  EXPECT_EQ(cps[4], 'B');
}

TEST_F(KoreanJamoTest, handlesEmptyString) {
  EXPECT_EQ(decomposeKoreanToJamo(""), "");
}

class KatakanaHiraganaTest : public ::testing::Test {};

TEST_F(KatakanaHiraganaTest, convertsKatakanaToHiragana) {
  std::string katakana = "\xE3\x82\xA2";
  std::string result = convertKatakanaToHiragana(katakana);
  auto cps = decodeUtf8(result);
  ASSERT_EQ(cps.size(), 1u);
  EXPECT_EQ(cps[0], 0x3042);
}

TEST_F(KatakanaHiraganaTest, preservesHiragana) {
  std::string hiragana = "\xE3\x81\x82";
  EXPECT_EQ(convertKatakanaToHiragana(hiragana), hiragana);
}

TEST_F(KatakanaHiraganaTest, preservesAscii) {
  EXPECT_EQ(convertKatakanaToHiragana("hello"), "hello");
}

TEST_F(KatakanaHiraganaTest, handlesMixedText) {
  std::string input = "A\xE3\x82\xA2\xE3\x81\x82";
  std::string result = convertKatakanaToHiragana(input);
  auto cps = decodeUtf8(result);
  ASSERT_EQ(cps.size(), 3u);
  EXPECT_EQ(cps[0], 'A');
  EXPECT_EQ(cps[1], 0x3042);
  EXPECT_EQ(cps[2], 0x3042);
}

TEST_F(KatakanaHiraganaTest, handlesEmptyString) {
  EXPECT_EQ(convertKatakanaToHiragana(""), "");
}

class ChineseCangjieTest : public ::testing::Test {
protected:
  CangjieTable table_;

  void SetUp() override {
    table_[0x65E5] = "a";
    table_[0x6708] = "b";
  }
};

TEST_F(ChineseCangjieTest, convertsCjkCharacter) {
  std::string input = "\xE6\x97\xA5";
  std::string result = convertChineseToCangjie(input, table_);
  EXPECT_EQ(result, "a");
}

TEST_F(ChineseCangjieTest, preservesNonCjk) {
  EXPECT_EQ(convertChineseToCangjie("hello", table_), "hello");
}

TEST_F(ChineseCangjieTest, handlesMixedText) {
  std::string input = "X\xE6\x97\xA5Y\xE6\x9C\x88Z";
  std::string result = convertChineseToCangjie(input, table_);
  EXPECT_EQ(result, "XaYbZ");
}

TEST_F(ChineseCangjieTest, passesUnknownCjkThrough) {
  std::string input = "\xE4\xB8\xAD";
  std::string result = convertChineseToCangjie(input, table_);
  EXPECT_EQ(result, input);
}

TEST_F(ChineseCangjieTest, handlesEmptyTable) {
  CangjieTable empty;
  std::string input = "\xE6\x97\xA5";
  std::string result = convertChineseToCangjie(input, empty);
  EXPECT_EQ(result, input);
}

class PreprocessDispatchTest : public ::testing::Test {
protected:
  CangjieTable table_;

  void SetUp() override { table_[0x65E5] = "a"; }
};

TEST_F(PreprocessDispatchTest, dispatchesKorean) {
  std::string result = preprocessText("\xEA\xB0\x80", "ko", table_);
  auto cps = decodeUtf8(result);
  ASSERT_EQ(cps.size(), 2u);
  EXPECT_EQ(cps[0], 0x1100);
  EXPECT_EQ(cps[1], 0x1161);
}

TEST_F(PreprocessDispatchTest, dispatchesJapanese) {
  std::string katakana = "\xE3\x82\xA2";
  std::string result = preprocessText(katakana, "ja", table_);
  auto cps = decodeUtf8(result);
  ASSERT_EQ(cps.size(), 1u);
  EXPECT_EQ(cps[0], 0x3042);
}

TEST_F(PreprocessDispatchTest, dispatchesChinese) {
  std::string result = preprocessText("\xE6\x97\xA5", "zh", table_);
  EXPECT_EQ(result, "a");
}

TEST_F(PreprocessDispatchTest, passesHebrewThrough) {
  std::string hebrew = "\xD7\xA9\xD7\x9C\xD7\x95\xD7\x9D";
  std::string result = preprocessText(hebrew, "he", table_);
  EXPECT_EQ(result, hebrew);
}

TEST_F(PreprocessDispatchTest, passesEnglishThrough) {
  std::string result = preprocessText("Hello", "en", table_);
  EXPECT_EQ(result, "Hello");
}

TEST_F(PreprocessDispatchTest, passesSpanishThrough) {
  std::string result = preprocessText("Hola mundo", "es", table_);
  EXPECT_EQ(result, "Hola mundo");
}

} // namespace qvac::ttslib::chatterbox::text_preprocess::testing
