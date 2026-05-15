#include "src/model-interface/ChatterboxLanguageMode.hpp"

#include <gtest/gtest.h>

namespace qvac::ttslib::chatterbox::lang_mode::testing {

namespace {

std::string asUtf8String(const char8_t *text) {
  return std::string(reinterpret_cast<const char *>(text));
}

} // namespace

TEST(ChatterboxLanguageModeTest, prefixesPortugueseInMultilingualMode) {
  const std::string text =
      asUtf8String(u8"Olá mundo! Essa é uma demonstração de síntese de texto "
                   u8"para voz usando Chatterbox");
  const std::string expected = "[pt]" + text;

  EXPECT_EQ(prepareTextForTokenization(text, "pt", false), expected);
}

TEST(ChatterboxLanguageModeTest, keepsPortugueseUnchangedInEnglishMode) {
  const std::string text = asUtf8String(u8"Olá mundo!");

  EXPECT_EQ(prepareTextForTokenization(text, "pt", true), text);
}

TEST(ChatterboxLanguageModeTest, detectsMultilingualEmbedInputs) {
  const std::vector<std::string> inputNames = {"input_ids", "position_ids",
                                               "language_id"};

  EXPECT_TRUE(supportsMultilingualEmbedInputs(inputNames));
  EXPECT_FALSE(shouldUseEnglishMode("pt", inputNames));
}

} // namespace qvac::ttslib::chatterbox::lang_mode::testing

namespace qvac::ttslib::chatterbox::testing {

TEST(ChatterboxLanguageModeTest,
     SupportsMultilingualWhenExpectedInputNamesPresent) {
  const std::vector<std::string> inputNames = {"input_ids", "position_ids",
                                               "language_id"};
  EXPECT_TRUE(lang_mode::supportsMultilingualEmbedInputs(inputNames));
}

TEST(ChatterboxLanguageModeTest,
     SupportsMultilingualWhenInputArityLooksMultilingual) {
  const std::vector<std::string> inputNames = {"foo", "bar", "baz"};
  EXPECT_TRUE(lang_mode::supportsMultilingualEmbedInputs(inputNames));
}

TEST(ChatterboxLanguageModeTest,
     RejectsMultilingualWhenOnlyMonolingualInputsExist) {
  const std::vector<std::string> inputNames = {"input_ids", "attention_mask"};
  EXPECT_FALSE(lang_mode::supportsMultilingualEmbedInputs(inputNames));
}

TEST(ChatterboxLanguageModeTest, UsesMultilingualModeWhenModelSupportsIt) {
  const std::vector<std::string> inputNames = {"input_ids", "position_ids",
                                               "language_id"};
  EXPECT_FALSE(lang_mode::shouldUseEnglishMode("es", inputNames));
}

TEST(ChatterboxLanguageModeTest,
     UsesEnglishModeWhenRequestedLanguageIsEnglish) {
  const std::vector<std::string> inputNames = {"input_ids", "position_ids",
                                               "language_id"};
  EXPECT_TRUE(lang_mode::shouldUseEnglishMode("en", inputNames));
}

TEST(ChatterboxLanguageModeTest, UsesEnglishModeForMonolingualModel) {
  const std::vector<std::string> inputNames = {"input_ids"};
  EXPECT_TRUE(lang_mode::shouldUseEnglishMode("es", inputNames));
}

TEST(ChatterboxLanguageModeTest, UsesEnglishModeWhenOnlyTwoInputs) {
  const std::vector<std::string> inputNames = {"input_ids", "attention_mask"};
  EXPECT_TRUE(lang_mode::shouldUseEnglishMode("es", inputNames));
}

TEST(ChatterboxLanguageModeTest, TokenizationKeepsTextUnchangedInEnglishMode) {
  EXPECT_EQ(lang_mode::prepareTextForTokenization("Hola Mundo", "es", true),
            "Hola Mundo");
}

TEST(ChatterboxLanguageModeTest,
     TokenizationKeepsTextUnchangedForEnglishLanguage) {
  EXPECT_EQ(lang_mode::prepareTextForTokenization("Hello World", "en", false),
            "Hello World");
}

TEST(ChatterboxLanguageModeTest,
     TokenizationAppliesLowercaseNfkdAndSpaceTokenForJapanese) {
  EXPECT_EQ(lang_mode::prepareTextForTokenization("Hola Mundo", "ja", false),
            "[ja]hola[SPACE]mundo");
}

TEST(ChatterboxLanguageModeTest,
     TokenizationKeepsCasingAndSpacesForNonJapaneseMultilingualLanguages) {
  EXPECT_EQ(lang_mode::prepareTextForTokenization("Hola Mundo", "es", false),
            "[es]Hola Mundo");
  EXPECT_EQ(lang_mode::prepareTextForTokenization("Bonjour le monde", "fr",
                                                  false),
            "[fr]Bonjour le monde");
}

TEST(ChatterboxLanguageModeTest, ApplyLowercaseNfkdHandlesAsciiUppercase) {
  EXPECT_EQ(lang_mode::applyLowercaseNfkd("HELLO"), "hello");
}

TEST(ChatterboxLanguageModeTest,
     ApplyLowercaseNfkdDecomposesAccentedCharacters) {
  EXPECT_EQ(lang_mode::applyLowercaseNfkd("Á"), "a\xCC\x81");
  EXPECT_EQ(lang_mode::applyLowercaseNfkd("Ñ"), "n\xCC\x83");
}

TEST(ChatterboxLanguageModeTest,
     ApplyLowercaseNfkdReturnsEmptyStringForEmptyInput) {
  EXPECT_EQ(lang_mode::applyLowercaseNfkd(""), "");
}

TEST(ChatterboxLanguageModeTest, ReplaceSpacesWithTokenReplacesEverySpace) {
  EXPECT_EQ(lang_mode::replaceSpacesWithToken("a b c"), "a[SPACE]b[SPACE]c");
}

TEST(ChatterboxLanguageModeTest,
     ReplaceSpacesWithTokenLeavesTextWithoutSpacesUntouched) {
  EXPECT_EQ(lang_mode::replaceSpacesWithToken("hello"), "hello");
}

TEST(ChatterboxLanguageModeTest,
     ReplaceSpacesWithTokenReturnsEmptyStringForEmptyInput) {
  EXPECT_EQ(lang_mode::replaceSpacesWithToken(""), "");
}

} // namespace qvac::ttslib::chatterbox::testing
