#pragma once

#include <span>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

/**
 * @brief validates whether the language list has unknown/unsupported languages
 *
 * @param langList : the language list received for model creation
 */
void validateUnknownLanguages(std::span<const std::string> langList);

/**
 * @brief gets the set of language group characters and a vector with whether they should be ignored for that particular langList
 *
 * @param langList : the language list received for model creation
 * @returns std::tuple<std::u32string_view, std::vector<bool>, bool> : respectively
 *  - set of characters for that language group, outputed by the recognizer inference
 *  - a vector indicating positions of characters that should be ignored when decoding recognizer inference results
 *  - whether script is written left to right
 */
std::tuple<std::u32string_view, std::vector<bool>, bool> getCharsInfoFromLangList(std::span<const std::string> langList);

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
