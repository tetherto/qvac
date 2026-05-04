#pragma once

#include <memory>
#include <string>
#include <vector>

// Forward declare bergamot types
namespace marian::bergamot {
class BlockingService;
class TranslationModel;
class Response;
struct ResponseOptions;
} // namespace marian::bergamot

// Wrapper for bergamot translator
struct bergamot_context { // NOLINT(readability-identifier-naming)
  std::shared_ptr<marian::bergamot::BlockingService> service;
  std::shared_ptr<marian::bergamot::TranslationModel> model;

  // Runtime statistics
  double total_encode_time = 0.0;
  double total_decode_time = 0.0;
  int total_tokens = 0;
};

struct bergamot_params { // NOLINT(readability-identifier-naming)
  bool use_gpu = false;
  int num_workers = 1;
  int cache_size = 0;
  int beam_size = 1;
  int normalize = 1; // 1 for true, 0 for false
  double max_length_factor =
      2.5; // NOLINT(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
  std::string model_path;
  std::string src_vocab_path;
  std::string dst_vocab_path;
};

struct bergamot_batch_result { // NOLINT(readability-identifier-naming)
  std::vector<std::string> translations;
  std::vector<bool>
      success;       // true if particular index is translated successfully.
  std::string error; // Error Message
};

// Initialize bergamot context from model path
bergamot_context*
bergamotInit(const char* modelPath, const bergamot_params& params);

// Translate text
std::string bergamotTranslate(bergamot_context* ctx, const char* input);

// Translate batch of Text
bergamot_batch_result bergamotTranslateBatch(
    bergamot_context* ctx, const std::vector<std::string>& texts);

// Get runtime statistics
int bergamotGetRuntimeStats(
    bergamot_context* ctx, double* encodeTime, double* decodeTime,
    int* totalTokens);

// Reset runtime statistics
void bergamotResetRuntimeStats(bergamot_context* ctx);

// Free bergamot context
void bergamotFree(bergamot_context* ctx);
