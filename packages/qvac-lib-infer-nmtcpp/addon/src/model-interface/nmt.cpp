// NOLINTBEGIN
// This file contains low-level performance-critical code that interfaces with C
// libraries (ggml) It intentionally uses C-style patterns for performance and
// compatibility reasons Suppressing linting warnings as they would require
// architectural changes that could affect performance

#include "nmt.hpp"

#include <algorithm>
#include <cassert>
#include <sstream>

#include <ggml-backend.h>
#include <ggml.h>

#include "ggml-alloc.h"
#include "ggml-cpp.h"
// Only include Vulkan header if Vulkan support is actually built
#if (defined(__linux__) || defined(__ANDROID__)) && defined(GGML_USE_VULKAN)
#include "ggml-vulkan.h"
#endif
#ifdef _MSC_VER
#include <codecvt>
#endif
#include <cstdarg>
#include <cstring>

#include "nmt_beam_search.hpp"
#include "nmt_graph_decoder.hpp"
#include "nmt_graph_encoder.hpp"
#include "nmt_state_backend.hpp"
#include "nmt_tokenization.hpp"
#include "nmt_utils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#ifdef _WIN32
#include <windows.h>
#endif

void nmt_free(struct nmt_context* ctx) {
  if (ctx) {
    for (ggml_context* context : ctx->model.ctxs) {
      ggml_free(context);
    }

    for (ggml_backend_buffer_t buf : ctx->model.buffers) {
      ggml_backend_buffer_free(buf);
    }

    nmt_free_state(ctx->state);

    delete ctx;
  }
}

struct nmt_context_params nmt_context_default_params() {
  struct nmt_context_params result = {
      /*.use_gpu              =*/false,
      /*.flash_attn           =*/false,
      /*.gpu_device           =*/0,
  };
  return result;
}

// typedef struct nmt_aheads {
//     size_t n_heads;
//     const nmt_ahead * heads;
// } nmt_aheads;

const char* nmt_model_type_readable(struct nmt_context* ctx) {
  // clang-format off
    switch (ctx->model.type) {
        case e_model::MODEL_INDICTRANS: return "indictrans2";
        default: return "unknown";
    }
  // clang-format on
}

int nmt_model_n_vocab(struct nmt_context* ctx) {
  return ctx->model.hparams.n_vocab;
}

bool nmt_model_is_indictrans(struct nmt_context* ctx) {
  return ctx->model.type == MODEL_INDICTRANS;
}

const char* nmt_get_output(struct nmt_context* ctx) {
  return ctx->state->result_all.c_str();
}

static int nmt_decode_sample(struct nmt_context* ctx, int max_tokens) {
  ctx->state->decoder_inputs = {ctx->vocab.bos_token_id};
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[DECODE] Decoder initialized with BOS token ID: " +
          std::to_string(ctx->vocab.bos_token_id));
  bool should_stop = false;

  while (!should_stop && ctx->state->decoder_inputs.size() < max_tokens) {
    nmt_batch_prep_legacy(
        ctx->state->batch,
        ctx->state->decoder_inputs.data() + ctx->state->decoder_inputs.size() -
            1,
        1,
        ctx->state->decoder_inputs.size() - 1,
        0);

    if (!nmt_decode_internal(*ctx, ctx->state->batch, *ctx->state)) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Failed to run decoder");
      return -1;
    }
    ctx->state->n_decode += 1;

    nmt_vocab::id next_token = ctx->state->decoder_inputs.back();

    if (next_token == 2) {
      should_stop = true;
    }
  }

  return 0;
}

static int nmt_process_chunk(struct nmt_context* ctx) {
  struct nmt_state* state = ctx->state;

  int64_t t_chunk_start = get_time_us();

  int64_t t_start_us = get_time_us();
  if (!nmt_encode_internal(*ctx, *ctx->state)) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "Failed to run encoder.");
    return -1;
  }
  int64_t t_encode_us = get_time_us() - t_start_us;
  ctx->state->t_encode_us += t_encode_us;
  ctx->state->n_encode += 1;

  nmt_batch_free(ctx->state->batch);
  ctx->state->batch = nmt_batch_init(ctx->model.hparams.n_decoder_ctx, 1);

  const int beam_size = ctx->model.config.beam_size;
  int max_tokens = 50;
  max_tokens = ctx->model.config.max_length > 0 ? ctx->model.config.max_length
                                                : max_tokens;

  t_start_us = get_time_us();

  int result = 0;
  if (beam_size <= 1) {
    result = nmt_decode_sample(ctx, max_tokens);
  } else {
    result = nmt_decode_beam_search(ctx, beam_size, max_tokens);
  }

  if (result != 0) {
    return result;
  }

  ctx->state->t_decode_us += get_time_us() - t_start_us;

  nmt_kv_cache_clear(state->kv_cross);
  nmt_kv_cache_clear(state->kv_self);

  state->result_all += detokenize_sentencepiece(ctx);

  return 0;
}

int nmt_full(struct nmt_context* ctx, const char* input_text) {
  struct nmt_state* state = ctx->state;
  ctx->state->result_all.clear();

  if (nmt_tokenize_input(ctx, input_text) < 0) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "Failed to tokenize input");
    return -1;
  }

  // Log first few encoder tokens
  std::ostringstream token_log;
  token_log << "[ENCODE] First encoder tokens: [";
  for (size_t i = 0; i < std::min(size_t(10), state->text_tokens.size()); i++) {
    if (i > 0)
      token_log << ", ";
    token_log << state->text_tokens[i];
  }
  token_log << "]";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, token_log.str());

  for (size_t i = 0; i < state->text_tokens.size() -
                             (state->text_tokens.back() == 0 ? 1 : 0);) {
    state->text_tokens_begin = i;
    const size_t remaining_tokens = state->text_tokens.size() - i;
    state->tokens_to_process = static_cast<int32_t>(std::min(
        remaining_tokens,
        static_cast<size_t>(ctx->model.hparams.n_encoder_ctx)));

    int result = nmt_process_chunk(ctx);
    if (result != 0) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Failed to process chunk");
      return result;
    }

    // Advance by the number of tokens we just processed.
    i += state->tokens_to_process + 1;
  }

  return 0;
}

// NOLINTEND
