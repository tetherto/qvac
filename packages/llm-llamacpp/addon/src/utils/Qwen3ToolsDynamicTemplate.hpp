#pragma once

namespace qvac_lib_inference_addon_llama {
namespace utils {

// Uses fxed Qwen3 chat template as a base
// see QwenTemplate.hpp
//
// Changes: Tools are put in additional system prompt at the end
// in order to apply new (different) tools on each user prompt
const char* getToolsDynamicQwen3Template();

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
