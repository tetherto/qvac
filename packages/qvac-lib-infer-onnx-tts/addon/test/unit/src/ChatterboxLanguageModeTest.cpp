#include "src/model-interface/ChatterboxLanguageMode.hpp"

#include <gtest/gtest.h>

namespace qvac::ttslib::chatterbox::testing {

TEST(ChatterboxLanguageModeTest, SupportsMultilingualWhenExpectedInputNamesPresent) {
  const std::vector<std::string> inputNames = {"input_ids", "position_ids", "language_id"};
  EXPECT_TRUE(lang_mode::supportsMultilingualEmbedInputs(inputNames));
}

TEST(ChatterboxLanguageModeTest, SupportsMultilingualWhenInputArityLooksMultilingual) {
  const std::vector<std::string> inputNames = {"foo", "bar", "baz"};
  EXPECT_TRUE(lang_mode::supportsMultilingualEmbedInputs(inputNames));
}

TEST(ChatterboxLanguageModeTest, RejectsMultilingualWhenOnlyMonolingualInputsExist) {
  const std::vector<std::string> inputNames = {"input_ids", "attention_mask"};
  EXPECT_FALSE(lang_mode::supportsMultilingualEmbedInputs(inputNames));
}

TEST(ChatterboxLanguageModeTest, UsesMultilingualModeWhenModelSupportsIt) {
  const std::vector<std::string> inputNames = {"input_ids", "position_ids", "language_id"};
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

TEST(ChatterboxLanguageModeTest, TokenizationPrefixTracksRuntimeLanguageMode) {
  EXPECT_EQ(lang_mode::prepareTextForTokenization("Hola mundo", "es", true), "Hola mundo");
  EXPECT_EQ(lang_mode::prepareTextForTokenization("Hola mundo", "es", false), "[es]Hola mundo");
}

} // namespace qvac::ttslib::chatterbox::testing
