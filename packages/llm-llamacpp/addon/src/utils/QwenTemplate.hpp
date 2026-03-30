#pragma once

namespace qvac_lib_inference_addon_llama {
namespace utils {

// Fixed Qwen3 chat template compatible with llama.cpp's Jinja implementation
// Source: llama.cpp/models/templates/Qwen-Qwen3-0.6B.jinja (with all fixes
// applied)
//
// Fixes applied:
// 1. Replaced Python .lstrip()/.rstrip()/.strip() with | trim filter
// 2. Simplified reasoning_content rendering to always show when present
const char* getFixedQwen3Template();

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
