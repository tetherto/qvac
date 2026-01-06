#pragma once

#include <memory>
#include <string>
#include <vector>

// Forward declare bergamot types
namespace marian {
namespace bergamot {
class BlockingService;
class TranslationModel;
class Response;
struct ResponseOptions;
} // namespace bergamot
} // namespace marian

// Wrapper for bergamot translator
struct bergamot_context {
  std::shared_ptr<marian::bergamot::BlockingService> service;
  std::shared_ptr<marian::bergamot::TranslationModel> model;

  // Runtime statistics
  double total_encode_time = 0.0;
  double total_decode_time = 0.0;
  int total_tokens = 0;

  // Configuration parameters
  int beam_size = 1;
  bool normalize = false;
  int max_length_factor = 2;
};

struct bergamot_params {
  bool use_gpu = false;
  int num_workers = 1;
  int cache_size = 0;
  std::string model_path;
  std::string src_vocab_path;
  std::string dst_vocab_path;
};

struct bergamot_batch_result {
  std::vector<std::string> translations;
  std::vector<bool>
      success;       // true if particular index is translated successfully.
  std::string error; // Error Message
};

// Initialize bergamot context from model path
bergamot_context* bergamot_init(const char* model_path, const bergamot_params& params);

// Translate text
std::string bergamot_translate(bergamot_context* ctx, const char* input);

// Translate batch of Text
bergamot_batch_result bergamot_translate_batch(
    bergamot_context* ctx, const std::vector<std::string>& texts);

// Get runtime statistics
int bergamot_get_runtime_stats(
    bergamot_context* ctx,
    double* encode_time,
    double* decode_time,
    int* total_tokens);

// Reset runtime statistics
void bergamot_reset_runtime_stats(bergamot_context* ctx);

// Free bergamot context
void bergamot_free(bergamot_context* ctx);

// Set configuration parameters
void bergamot_set_beam_size(bergamot_context* ctx, int beam_size);
void bergamot_set_normalize(bergamot_context* ctx, bool normalize);
void bergamot_set_max_length_factor(bergamot_context* ctx, int factor);
