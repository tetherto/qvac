#include "src/model-interface/ChatterboxLanguageMode.hpp"

#include <gtest/gtest.h>

namespace qvac::ttslib::chatterbox::testing {

TEST(
    ChatterboxLanguageModeTest,
    SupportsMultilingualWhenExpectedInputNamesPresent) {
  const std::vector<std::string> inputNames = {
      "input_ids", "position_ids", "language_id"};
  EXPECT_TRUE(lang_mode::supportsMultilingualEmbedInputs(inputNames));
}

TEST(
    ChatterboxLanguageModeTest,
    SupportsMultilingualWhenInputArityLooksMultilingual) {
  const std::vector<std::string> inputNames = {"foo", "bar", "baz"};
  EXPECT_TRUE(lang_mode::supportsMultilingualEmbedInputs(inputNames));
}

TEST(
    ChatterboxLanguageModeTest,
    RejectsMultilingualWhenOnlyMonolingualInputsExist) {
  const std::vector<std::string> inputNames = {"input_ids", "attention_mask"};
  EXPECT_FALSE(lang_mode::supportsMultilingualEmbedInputs(inputNames));
}

TEST(ChatterboxLanguageModeTest, UsesMultilingualModeWhenModelSupportsIt) {
  const std::vector<std::string> inputNames = {
      "input_ids", "position_ids", "language_id"};
  EXPECT_FALSE(lang_mode::shouldUseEnglishMode(inputNames));
}

TEST(ChatterboxLanguageModeTest, UsesEnglishModeForMonolingualModel) {
  const std::vector<std::string> inputNames = {"input_ids"};
  EXPECT_TRUE(lang_mode::shouldUseEnglishMode(inputNames));
}

TEST(ChatterboxLanguageModeTest, UsesEnglishModeWhenOnlyTwoInputs) {
  const std::vector<std::string> inputNames = {"input_ids", "attention_mask"};
  EXPECT_TRUE(lang_mode::shouldUseEnglishMode(inputNames));
}

TEST(ChatterboxLanguageModeTest, TokenizationKeepsTextUnchangedInEnglishMode) {
  EXPECT_EQ(
      lang_mode::prepareTextForTokenization("Hola Mundo", "es", true),
      "Hola Mundo");
}

TEST(
    ChatterboxLanguageModeTest,
    TokenizationKeepsTextUnchangedForEnglishLanguage) {
  EXPECT_EQ(
      lang_mode::prepareTextForTokenization("Hello World", "en", false),
      "Hello World");
}

TEST(
    ChatterboxLanguageModeTest,
    TokenizationAppliesLowercaseNfkdAndSpaceTokenForOtherLanguages) {
  EXPECT_EQ(
      lang_mode::prepareTextForTokenization("Hola Mundo", "es", false),
      "[es]hola[SPACE]mundo");
}

TEST(ChatterboxLanguageModeTest, ApplyLowercaseNfkdHandlesAsciiUppercase) {
  EXPECT_EQ(lang_mode::applyLowercaseNfkd("HELLO"), "hello");
}

TEST(
    ChatterboxLanguageModeTest,
    ApplyLowercaseNfkdDecomposesAccentedCharacters) {
  EXPECT_EQ(lang_mode::applyLowercaseNfkd("Á"), "a\xCC\x81");
  EXPECT_EQ(lang_mode::applyLowercaseNfkd("Ñ"), "n\xCC\x83");
}

TEST(
    ChatterboxLanguageModeTest,
    ApplyLowercaseNfkdReturnsEmptyStringForEmptyInput) {
  EXPECT_EQ(lang_mode::applyLowercaseNfkd(""), "");
}

TEST(ChatterboxLanguageModeTest, ReplaceSpacesWithTokenReplacesEverySpace) {
  EXPECT_EQ(lang_mode::replaceSpacesWithToken("a b c"), "a[SPACE]b[SPACE]c");
}

TEST(
    ChatterboxLanguageModeTest,
    ReplaceSpacesWithTokenLeavesTextWithoutSpacesUntouched) {
  EXPECT_EQ(lang_mode::replaceSpacesWithToken("hello"), "hello");
}

TEST(
    ChatterboxLanguageModeTest,
    ReplaceSpacesWithTokenReturnsEmptyStringForEmptyInput) {
  EXPECT_EQ(lang_mode::replaceSpacesWithToken(""), "");
}

} // namespace qvac::ttslib::chatterbox::testing
