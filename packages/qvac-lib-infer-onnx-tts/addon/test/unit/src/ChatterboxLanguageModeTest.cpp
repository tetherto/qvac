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

  EXPECT_EQ(prepareTextForTokenization(text, "pt", false), "[pt]" + text);
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

TEST(ChatterboxLanguageModeTest, UsesEnglishModeForMonolingualModel) {
  const std::vector<std::string> inputNames = {"input_ids"};
  EXPECT_TRUE(lang_mode::shouldUseEnglishMode("es", inputNames));
}

TEST(ChatterboxLanguageModeTest, UsesEnglishModeWhenOnlyTwoInputs) {
  const std::vector<std::string> inputNames = {"input_ids", "attention_mask"};
  EXPECT_TRUE(lang_mode::shouldUseEnglishMode("es", inputNames));
}

TEST(ChatterboxLanguageModeTest, TokenizationPrefixTracksRuntimeLanguageMode) {
  EXPECT_EQ(lang_mode::prepareTextForTokenization("Hola mundo", "es", true),
            "Hola mundo");
  EXPECT_EQ(lang_mode::prepareTextForTokenization("Hola mundo", "es", false),
            "[es]Hola mundo");
}

} // namespace qvac::ttslib::chatterbox::testing
