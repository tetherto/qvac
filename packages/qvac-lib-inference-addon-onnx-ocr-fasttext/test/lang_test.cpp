#include "pipeline/Lang.hpp"

#include <string>
#include <tuple>

#include <gtest/gtest.h>

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

TEST(ValidateUnknownLanguages, Empty) { validateUnknownLanguages({}); }

TEST(ValidateUnknownLanguages, Single) {
  // Latin
  validateUnknownLanguages(std::vector<std::string>{"af"});
  validateUnknownLanguages(std::vector<std::string>{"hu"});
  // Arabic
  validateUnknownLanguages(std::vector<std::string>{"fa"});
  validateUnknownLanguages(std::vector<std::string>{"ug"});
  // Bengali
  validateUnknownLanguages(std::vector<std::string>{"bn"});
  validateUnknownLanguages(std::vector<std::string>{"mni"});
  // Cyrillic
  validateUnknownLanguages(std::vector<std::string>{"uk"});
  validateUnknownLanguages(std::vector<std::string>{"inh"});
  // Devanagari
  validateUnknownLanguages(std::vector<std::string>{"ne"});
  validateUnknownLanguages(std::vector<std::string>{"mai"});
  // other
  validateUnknownLanguages(std::vector<std::string>{"th"});
  validateUnknownLanguages(std::vector<std::string>{"ko"});
}

TEST(ValidateUnknownLanguages, MultipleInSameGroup) {
  // Latin
  validateUnknownLanguages(std::vector<std::string>{"af", "hu"});
  // Arabic
  validateUnknownLanguages(std::vector<std::string>{"fa", "ug"});
  // Bengali
  validateUnknownLanguages(std::vector<std::string>{"bn", "mni"});
  // Cyrillic
  validateUnknownLanguages(std::vector<std::string>{"uk", "inh"});
  // Devanagari
  validateUnknownLanguages(std::vector<std::string>{"ne", "mai"});
  // other
  validateUnknownLanguages(std::vector<std::string>{"th", "ko"});
}

TEST(ValidateUnknownLanguages, MultipleGroups) {
  validateUnknownLanguages(std::vector<std::string>{"af", "hu", "fa", "ug",
                                                    "bn", "mni", "uk", "inh",
                                                    "ne", "mai", "th", "ko"});
}

TEST(ValidateUnknownLanguages, InvalidLanguageAlone) {
  EXPECT_THROW(validateUnknownLanguages(std::vector<std::string>{"zz"}),
               std::invalid_argument);
}

TEST(ValidateUnknownLanguages, ValidAndInvalidLanguages) {
  EXPECT_THROW(
      validateUnknownLanguages(std::vector<std::string>{"af", "ug", "zz"}),
      std::invalid_argument);

  EXPECT_THROW(
      validateUnknownLanguages(std::vector<std::string>{"af", "zz", "ug"}),
      std::invalid_argument);
}

TEST(GetCharsInfoFromLangList, Empty) {
  std::u32string_view characters;
  std::vector<bool> ignoreCharacters;
  bool leftToRight;

  std::tie(characters, ignoreCharacters, leftToRight) =
      getCharsInfoFromLangList({});

  EXPECT_FALSE(characters.empty());
  EXPECT_EQ(characters.size(), ignoreCharacters.size());

  EXPECT_TRUE(leftToRight);
}

TEST(GetCharsInfoFromLangList, English) {
  std::u32string_view characters;
  std::vector<bool> ignoreCharacters;
  bool leftToRight;

  std::tie(characters, ignoreCharacters, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"en"});

  EXPECT_FALSE(characters.empty());
  EXPECT_EQ(characters.size(), ignoreCharacters.size());

  EXPECT_TRUE(leftToRight);
}

TEST(GetCharsInfoFromLangList, EnglishIsValidWithAnyLanguageGroup) {
  getCharsInfoFromLangList(
      std::vector<std::string>{"en", "af", "it", "no", "sw"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "th"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "ch_tra"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "ch_sim"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "ja"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "ko"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "ta"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "te"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "kn"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "bn", "as"});

  getCharsInfoFromLangList(
      std::vector<std::string>{"en", "ar", "fa", "ur", "ug"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "hi", "mr", "ne"});

  getCharsInfoFromLangList(std::vector<std::string>{"en", "ru", "rs_cyrillic",
                                                    "be", "bg", "uk", "mn"});
}

TEST(GetCharsInfoFromLangList, MixingLanguageGroups) {
  EXPECT_THROW(
      getCharsInfoFromLangList(std::vector<std::string>{"it", "ja", "sw"}),
      std::invalid_argument);

  EXPECT_THROW(
      getCharsInfoFromLangList(std::vector<std::string>{"ch_tra", "th", "en"}),
      std::invalid_argument);

  EXPECT_THROW(
      getCharsInfoFromLangList(std::vector<std::string>{"en", "ko", "ch_sim"}),
      std::invalid_argument);

  EXPECT_THROW(getCharsInfoFromLangList(std::vector<std::string>{"ru", "ta"}),
               std::invalid_argument);

  EXPECT_THROW(
      getCharsInfoFromLangList(std::vector<std::string>{"en", "kn", "te"}),
      std::invalid_argument);

  EXPECT_THROW(
      getCharsInfoFromLangList(std::vector<std::string>{"fa", "ur", "hi"}),
      std::invalid_argument);

  EXPECT_THROW(
      getCharsInfoFromLangList(std::vector<std::string>{"mr", "uk", "ne"}),
      std::invalid_argument);
}

TEST(GetCharsInfoFromLangList, LeftToRight) {
  bool leftToRight;

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"en", "hu"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"th"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"ch_tra"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"ch_sim"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"ja"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"ko"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"ta"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"te"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"kn"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"bn", "as"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) =
      getCharsInfoFromLangList(std::vector<std::string>{"hi", "ne"});
  EXPECT_TRUE(leftToRight);

  std::tie(std::ignore, std::ignore, leftToRight) = getCharsInfoFromLangList(
      std::vector<std::string>{"ru", "rs_cyrillic", "be"});
  EXPECT_TRUE(leftToRight);

  // Arabic, Farsi, Uyghur and Urdu are written right to left.
  std::tie(std::ignore, std::ignore, leftToRight) = getCharsInfoFromLangList(
      std::vector<std::string>{"ar", "fa", "ug", "ur"});
  EXPECT_FALSE(leftToRight);
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
