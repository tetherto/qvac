#include "src/model-interface/ChatterboxTextPreprocessor.hpp"

#include <gtest/gtest.h>

namespace qvac::ttslib::chatterbox::text_preprocess::testing {

using Preprocessor = ChatterboxTextPreprocessor;

namespace {

std::string asUtf8String(const char8_t *text) {
  return std::string(reinterpret_cast<const char *>(text));
}

} // namespace

class Utf8Test : public ::testing::Test {};

TEST_F(Utf8Test, decodesAscii) {
  auto cps = Preprocessor::decodeUtf8("abc");
  ASSERT_EQ(cps.size(), 3u);
  EXPECT_EQ(cps[0], 'a');
  EXPECT_EQ(cps[1], 'b');
  EXPECT_EQ(cps[2], 'c');
}

TEST_F(Utf8Test, decodesMultibyteCharacters) {
  auto cps = Preprocessor::decodeUtf8("\xED\x95\x9C");
  ASSERT_EQ(cps.size(), 1u);
  EXPECT_EQ(cps[0], 0xD55C);
}

TEST_F(Utf8Test, encodesAsciiCodepoint) {
  EXPECT_EQ(Preprocessor::encodeCodepoint('A'), "A");
}

TEST_F(Utf8Test, encodesMultibyteCodepoint) {
  std::string encoded = Preprocessor::encodeCodepoint(0xD55C);
  EXPECT_EQ(encoded, "\xED\x95\x9C");
}

TEST_F(Utf8Test, roundTripsText) {
  std::string original = "Hello \xED\x95\x9C\xEA\xB8\x80";
  auto cps = Preprocessor::decodeUtf8(original);
  std::string reconstructed;
  for (auto cp : cps) {
    reconstructed += Preprocessor::encodeCodepoint(cp);
  }
  EXPECT_EQ(reconstructed, original);
}

class KoreanJamoTest : public ::testing::Test {
protected:
  Preprocessor preprocessor_;
};

TEST_F(KoreanJamoTest, decomposesHangulSyllable) {
  std::string result = preprocessor_.decomposeKoreanToJamo("\xED\x95\x9C");
  auto cps = Preprocessor::decodeUtf8(result);
  ASSERT_EQ(cps.size(), 3u);
  EXPECT_EQ(cps[0], 0x1112);
  EXPECT_EQ(cps[1], 0x1161);
  EXPECT_EQ(cps[2], 0x11AB);
}

TEST_F(KoreanJamoTest, decomposesWithoutFinalConsonant) {
  std::string result = preprocessor_.decomposeKoreanToJamo("\xEA\xB0\x80");
  auto cps = Preprocessor::decodeUtf8(result);
  ASSERT_EQ(cps.size(), 2u);
  EXPECT_EQ(cps[0], 0x1100);
  EXPECT_EQ(cps[1], 0x1161);
}

TEST_F(KoreanJamoTest, preservesNonHangul) {
  std::string result = preprocessor_.decomposeKoreanToJamo("Hello");
  EXPECT_EQ(result, "Hello");
}

TEST_F(KoreanJamoTest, handlesMixedText) {
  std::string input = std::string("A") + "\xED\x95\x9C" + "B";
  std::string result = preprocessor_.decomposeKoreanToJamo(input);
  auto cps = Preprocessor::decodeUtf8(result);
  EXPECT_EQ(cps[0], 'A');
  EXPECT_EQ(cps[1], 0x1112);
  EXPECT_EQ(cps[2], 0x1161);
  EXPECT_EQ(cps[3], 0x11AB);
  EXPECT_EQ(cps[4], 'B');
}

TEST_F(KoreanJamoTest, handlesEmptyString) {
  EXPECT_EQ(preprocessor_.decomposeKoreanToJamo(""), "");
}

class KatakanaHiraganaTest : public ::testing::Test {
protected:
  Preprocessor preprocessor_;
};

TEST_F(KatakanaHiraganaTest, convertsKatakanaToHiragana) {
  std::string katakana = "\xE3\x82\xA2";
  std::string result = preprocessor_.convertKatakanaToHiragana(katakana);
  auto cps = Preprocessor::decodeUtf8(result);
  ASSERT_EQ(cps.size(), 1u);
  EXPECT_EQ(cps[0], 0x3042);
}

TEST_F(KatakanaHiraganaTest, preservesHiragana) {
  std::string hiragana = "\xE3\x81\x82";
  EXPECT_EQ(preprocessor_.convertKatakanaToHiragana(hiragana), hiragana);
}

TEST_F(KatakanaHiraganaTest, preservesAscii) {
  EXPECT_EQ(preprocessor_.convertKatakanaToHiragana("hello"), "hello");
}

TEST_F(KatakanaHiraganaTest, handlesMixedText) {
  std::string input = "A\xE3\x82\xA2\xE3\x81\x82";
  std::string result = preprocessor_.convertKatakanaToHiragana(input);
  auto cps = Preprocessor::decodeUtf8(result);
  ASSERT_EQ(cps.size(), 3u);
  EXPECT_EQ(cps[0], 'A');
  EXPECT_EQ(cps[1], 0x3042);
  EXPECT_EQ(cps[2], 0x3042);
}

TEST_F(KatakanaHiraganaTest, handlesEmptyString) {
  EXPECT_EQ(preprocessor_.convertKatakanaToHiragana(""), "");
}

class ChineseCangjieTest : public ::testing::Test {
protected:
  Preprocessor preprocessor_;
};

TEST_F(ChineseCangjieTest, convertsCjkCharacter) {
  Preprocessor p;
  std::string result = p.convertChineseToCangjie("hello");
  EXPECT_EQ(result, "hello");
}

TEST_F(ChineseCangjieTest, preservesNonCjk) {
  EXPECT_EQ(preprocessor_.convertChineseToCangjie("hello"), "hello");
}

TEST_F(ChineseCangjieTest, passesUnknownCjkThrough) {
  std::string input = "\xE4\xB8\xAD";
  std::string result = preprocessor_.convertChineseToCangjie(input);
  EXPECT_EQ(result, input);
}

class PreprocessDispatchTest : public ::testing::Test {
protected:
  Preprocessor preprocessor_;
};

TEST_F(PreprocessDispatchTest, dispatchesKorean) {
  std::string result = preprocessor_.preprocess("\xEA\xB0\x80", "ko");
  auto cps = Preprocessor::decodeUtf8(result);
  ASSERT_EQ(cps.size(), 2u);
  EXPECT_EQ(cps[0], 0x1100);
  EXPECT_EQ(cps[1], 0x1161);
}

TEST_F(PreprocessDispatchTest, dispatchesJapaneseKatakanaWithoutMeCab) {
  std::string katakana = "\xE3\x82\xA2";
  std::string result = preprocessor_.preprocess(katakana, "ja");
  auto cps = Preprocessor::decodeUtf8(result);
  ASSERT_EQ(cps.size(), 1u);
  EXPECT_EQ(cps[0], 0x3042);
}

TEST_F(PreprocessDispatchTest, passesHebrewThrough) {
  std::string hebrew = "\xD7\xA9\xD7\x9C\xD7\x95\xD7\x9D";
  std::string result = preprocessor_.preprocess(hebrew, "he");
  EXPECT_EQ(result, hebrew);
}

TEST_F(PreprocessDispatchTest, passesEnglishThrough) {
  std::string result = preprocessor_.preprocess("Hello", "en");
  EXPECT_EQ(result, "Hello");
}

TEST_F(PreprocessDispatchTest, passesSpanishThrough) {
  std::string result = preprocessor_.preprocess("Hola mundo", "es");
  EXPECT_EQ(result, "Hola mundo");
}

TEST_F(PreprocessDispatchTest, passesPortugueseDiacriticsThrough) {
  const std::string portuguese =
      asUtf8String(u8"Olá mundo! Essa é uma demonstração de síntese de texto "
                   u8"para voz usando Chatterbox");
  const std::string result = preprocessor_.preprocess(portuguese, "pt");
  EXPECT_EQ(result, portuguese);
}

} // namespace qvac::ttslib::chatterbox::text_preprocess::testing
