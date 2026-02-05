#pragma once

#include <string>

#include "common/common.h"

// Forward declarations from llama.h
struct llama_model;
struct llama_context;
struct llama_vocab;

namespace qvac_lib_inference_addon_llama {
namespace utils {

struct Qwen3ReasoningState {
  bool inside_reasoning = false;
  llama_token cached_close_tag_token = LLAMA_TOKEN_NULL;
  llama_token cached_newline_token = LLAMA_TOKEN_NULL;
  std::string recent_output_buffer;

  static constexpr size_t BUFFER_SIZE = 50;
};

/**
 * Initializes Qwen3 reasoning state by caching token IDs.
 * Should be called once during context initialization for Qwen3 models.
 */
void initializeQwen3ReasoningState(
    ::llama_context* lctx, Qwen3ReasoningState& state);

/**
 * Updates Qwen3 reasoning state buffer for tag detection.
 * Lightweight function that should be called for every token.
 */
void updateQwen3ReasoningBuffer(
    const std::string& tokenStr, Qwen3ReasoningState& state);

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
