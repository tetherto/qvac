#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <random>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include <sentencepiece_processor.h>

#include "ggml-backend.h"
#include "ggml.h"
// BEGIN: C-style performance-critical section
// This unit is intentionally kept close to the original C-style,
// low-level, performance-critical code used by the model runtime (ggml-based).
// Large-scale “modernization” (RAII, refactors, casts, array replacements,
// etc.) risks altering runtime behavior or performance characteristics. To
// avoid regressions, we suppress clang-tidy in this translation unit/header. If
// future changes are made, please validate with thorough parity tests and
// benchmarking before removing these suppressions. NOLINTBEGIN

// NOLINTBEGIN(readability-identifier-naming,modernize-use-using,cppcoreguidelines-macro-to-enum,modernize-macro-to-enum,readability-magic-numbers,cppcoreguidelines-avoid-magic-numbers,readability-uppercase-literal-suffix)
using nmt_pos = int32_t;
using nmt_token = int32_t;
using nmt_seq_id = int32_t;

enum { NMT_MAX_DECODERS = 8, NMT_MAX_NODES = 4096 };

enum e_model : std::uint8_t {
  MODEL_UNKNOWN,
  MODEL_INDICTRANS,
};

static const std::map<e_model, std::string> G_MODEL_NAME = {
    {MODEL_UNKNOWN, "unknown"},
    {MODEL_INDICTRANS, "indictrans2"},
};

enum class activation_function {
  RELU = 0,
  SILU,
};

struct nmt_hparams {
  int32_t n_vocab = 51864;
  int32_t n_encoder_ctx = 1500;
  int32_t n_encoder_heads = 6;
  int32_t n_encoder_layers = 4;
  int32_t n_decoder_ctx = 448;
  int32_t n_text_state = 384;
  int32_t n_decoder_heads = 6;
  int32_t n_decoder_layers = 4;
  int32_t n_mels = 80;
  int32_t ftype = 1;
  float eps = 1e-5F;

  int32_t n_tgt_vocab = 0;     // Target vocabulary size
  int32_t n_max_seq_len = 512; // Maximum sequence length
  int32_t d_model = 512;

  activation_function activation_func = activation_function::RELU;

  // IndicTrans2-specific parameters
  bool encoder_normalize_before = false; // Pre-normalization in encoder layers
  bool decoder_normalize_before = false; // Pre-normalization in decoder layers
  bool layernorm_embedding = false;      // Layer normalization after embeddings
  bool scale_embedding = false;          // Scale embeddings by sqrt(d_model)
  bool has_lm_head = false;
  int32_t encoder_ffn_dim = 2048; // Encoder feedforward network dimension
  int32_t decoder_ffn_dim = 2048; // Decoder feedforward network dimension
};

struct nmt_layer_decoder {
  // decoder.blocks.*.attn_ln
  struct ggml_tensor* attn_ln_0_w;
  struct ggml_tensor* attn_ln_0_b;

  // decoder.blocks.*.attn.out
  struct ggml_tensor* attn_ln_1_w;
  struct ggml_tensor* attn_ln_1_b;

  // decoder.blocks.*.attn.query
  struct ggml_tensor* attn_q_w;
  struct ggml_tensor* attn_q_b;

  // decoder.blocks.*.attn.key
  struct ggml_tensor* attn_k_w;
  struct ggml_tensor* attn_k_b;

  // decoder.blocks.*.attn.value
  struct ggml_tensor* attn_v_w;
  struct ggml_tensor* attn_v_b;

  // decoder.blocks.*.cross_attn_ln
  struct ggml_tensor* cross_attn_ln_0_w;
  struct ggml_tensor* cross_attn_ln_0_b;

  // decoder.blocks.*.cross_attn.out
  struct ggml_tensor* cross_attn_ln_1_w;
  struct ggml_tensor* cross_attn_ln_1_b;

  // decoder.blocks.*.cross_attn.query
  struct ggml_tensor* cross_attn_q_w;
  struct ggml_tensor* cross_attn_q_b;

  // decoder.blocks.*.cross_attn.key
  struct ggml_tensor* cross_attn_k_w;
  struct ggml_tensor* cross_attn_k_b;

  // decoder.blocks.*.cross_attn.value
  struct ggml_tensor* cross_attn_v_w;
  struct ggml_tensor* cross_attn_v_b;

  // decoder.blocks.*.mlp_ln
  struct ggml_tensor* mlp_ln_w;
  struct ggml_tensor* mlp_ln_b;

  // decoder.blocks.*.mlp.0
  struct ggml_tensor* mlp_0_w;
  struct ggml_tensor* mlp_0_b;

  // decoder.blocks.*.mlp.2
  struct ggml_tensor* mlp_1_w;
  struct ggml_tensor* mlp_1_b;
};

struct nmt_layer_encoder {
  // encoder.blocks.*.attn_ln
  struct ggml_tensor* attn_ln_0_w;
  struct ggml_tensor* attn_ln_0_b;

  // encoder.blocks.*.attn.out
  struct ggml_tensor* attn_ln_1_w;
  struct ggml_tensor* attn_ln_1_b;

  // encoder.blocks.*.attn.query
  struct ggml_tensor* attn_q_w;
  struct ggml_tensor* attn_q_b;

  // encoder.blocks.*.attn.key
  struct ggml_tensor* attn_k_w;
  struct ggml_tensor* attn_k_b;

  // encoder.blocks.*.attn.value
  struct ggml_tensor* attn_v_w;
  struct ggml_tensor* attn_v_b;

  // encoder.blocks.*.mlp_ln
  struct ggml_tensor* mlp_ln_w;
  struct ggml_tensor* mlp_ln_b;

  // encoder.blocks.*.mlp.0
  struct ggml_tensor* mlp_0_w;
  struct ggml_tensor* mlp_0_b;

  // encoder.blocks.*.mlp.2
  struct ggml_tensor* mlp_1_w;
  struct ggml_tensor* mlp_1_b;
};

struct nmt_kv_cell {
  nmt_pos pos = -1;

  std::set<nmt_seq_id> seq_id;

  [[nodiscard]] bool has_seq_id(const nmt_seq_id& seq_id_param) const {
    return seq_id.find(seq_id_param) != seq_id.end();
  }
};

struct nmt_kv_cache {
  uint32_t head = 0;
  uint32_t size = 0;

  // computed before each graph build
  uint32_t n = 0;

  std::vector<nmt_kv_cell> cells;

  struct ggml_tensor* k = nullptr;
  struct ggml_tensor* v = nullptr;

  ggml_backend_buffer_t buffer = nullptr;

  std::vector<uint8_t> ctx_buf;
};

struct nmt_config {
  int64_t beam_size = 4;            // Default beam size
  double length_penalty = 1.0;      // Default (neutral penalty)
  int64_t max_length = 512;         // Default max length
  float repetition_penalty = 1.0f;  // Default (disabled)
  int64_t no_repeat_ngram_size = 0; // Default (disabled)
  double temperature = 1.0; // Default (disables sampling for beam search)
  int64_t top_k = 0;        // Default (disabled for beam search)
  float top_p = 1.0;        // Default (disabled for nucleus sampling)
};

struct nmt_model {
  e_model type = MODEL_UNKNOWN;

  nmt_hparams hparams;

  nmt_config config;

  struct ggml_tensor* m_encoder_embeddings =
      nullptr; // encoder embeddings (shared)
  struct ggml_tensor* m_decoder_embeddings = nullptr; // decoder embeddings
  struct ggml_tensor* m_encoder_pos_emb =
      nullptr; // encoder positional embeddings
  struct ggml_tensor* m_decoder_pos_emb =
      nullptr; // decoder positional embeddings
  struct ggml_tensor* m_encoder_norm_w =
      nullptr; // encoder final layer norm weight
  struct ggml_tensor* m_encoder_norm_b =
      nullptr; // encoder final layer norm bias
  struct ggml_tensor* m_decoder_norm_w =
      nullptr; // decoder final layer norm weight
  struct ggml_tensor* m_decoder_norm_b =
      nullptr; // decoder final layer norm bias
  struct ggml_tensor* m_lm_head_w =
      nullptr; // language model head weight (often shared with embeddings)
  struct ggml_tensor* m_final_logits_bias =
      nullptr; // final logits bias (shape: 1 x vocab_size)

  // IndicTrans2-specific additional tensors
  struct ggml_tensor* m_enc_layer_norm_w =
      nullptr; // encoder layernorm_embedding weight
  struct ggml_tensor* m_enc_layer_norm_b =
      nullptr; // encoder layernorm_embedding bias
  struct ggml_tensor* m_dec_layer_norm_w =
      nullptr; // decoder layernorm_embedding weight
  struct ggml_tensor* m_dec_layer_norm_b =
      nullptr; // decoder layernorm_embedding bias

  std::vector<nmt_layer_encoder> layers_encoder;
  std::vector<nmt_layer_decoder> layers_decoder;

  // ggml context that contains all the meta information about the model tensors
  std::vector<ggml_context*> ctxs;

  // the model backend data is read-only and can be shared between processors
  std::vector<ggml_backend_buffer_t> buffers;

  // tensors
  int n_loaded = 0;
  std::map<std::string, struct ggml_tensor*> tensors;
};

struct nmt_vocab {
  using id = int32_t;
  using token = std::string;

  std::map<token, id> src_token_to_id;
  std::map<id, token> src_id_to_token;
  std::map<token, id> tgt_token_to_id;
  std::map<id, token> tgt_id_to_token;

  std::vector<int32_t> bad_word_ids;

  std::unique_ptr<sentencepiece::SentencePieceProcessor> src_processor;
  std::unique_ptr<sentencepiece::SentencePieceProcessor> tgt_processor;
  id bos_token_id = 1;
  bool has_sentencepiece_processors = false;
};

// replace std::pair by using customized pair struct (reason: std::pair is very
// slow)
template <typename A, typename B> struct nmt_pair {
  A first;
  B second;

  // Define a constructor that takes two arguments.
  nmt_pair(const A& firstValue, const B& secondValue)
      : first(firstValue), second(secondValue) {}
  // Define a constructor that takes no argument.
  nmt_pair() : first(A()), second(B()) {}
};

struct nmt_sched {
  ggml_backend_sched_t sched = nullptr;

  std::vector<uint8_t> meta;
};

struct nmt_decoder {
  // the currently generated sequence of tokens
  // nmt_sequence sequence;

  // grammar parse state of generated sequence of tokens
  // nmt_grammar  grammar;

  int i_batch = 0; // the index of the token in the current batch
  int seek_delta =
      0; // the window shift found so far based on the decoded timestamp tokens

  bool failed = false;    // has the current segment failed to decode?
  bool completed = false; // has the decoder completed the current segment?
  bool has_ts = false; // have we already sampled a non-beg timestamp token for
                       // the current segment?

  // new token probs, logits and logprobs after the last nmt_decode
  // (1-dimensional array: [n_vocab])
  std::vector<float> probs;
  std::vector<float> logits;
  std::vector<float> logprobs;

  // work container used to avoid memory allocations
  std::vector<nmt_pair<float, nmt_vocab::id>> logits_id;
  std::vector<nmt_pair<int, float>> sorted_probs;

  mutable std::mt19937 rng; // used for sampling at t > 0.0
};

struct nmt_batch {
  int32_t n_tokens;

  nmt_token* token;
  nmt_pos* pos;
  int32_t* n_seq_id;   // always 1, here for consistency with llama.cpp
  nmt_seq_id** seq_id; // null terminated
  int8_t* logits;
};

struct nmt_state {
  int64_t t_sample_us = 0;
  int64_t t_encode_us = 0;
  int64_t t_decode_us = 0;
  int64_t t_batchd_us = 0;
  int64_t t_prompt_us = 0;
  int64_t t_mel_us = 0;

  int32_t n_sample = 0; // number of tokens sampled
  int32_t n_encode = 0; // number of encoder calls
  int32_t n_decode =
      0; // number of decoder calls with n_tokens == 1  (text-generation)
  int32_t n_batchd =
      0; // number of decoder calls with n_tokens <  16 (batch decoding)
  int32_t n_prompt =
      0; // number of decoder calls with n_tokens >  1  (prompt encoding)
  int32_t n_fail_p = 0; // number of logprob threshold failures
  int32_t n_fail_h = 0; // number of entropy threshold failures

  nmt_kv_cache kv_self;
  nmt_kv_cache kv_cross;
  // number of decoders for which we have constructed the KV cache
  int32_t kv_self_n_dec = 0;

  nmt_batch batch{};

  nmt_decoder decoders
      [NMT_MAX_DECODERS]; // NOLINT(modernize-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays,hicpp-avoid-c-arrays)

  std::vector<ggml_backend_t> backends;

  // - stores meta info about the intermediate tensors into the `meta` buffers
  nmt_sched sched_conv;
  nmt_sched sched_encode;
  nmt_sched sched_cross;
  nmt_sched sched_decode;

  // result of the encoder

  struct ggml_tensor* input_embeddings = nullptr;
  struct ggml_tensor* logits_tensor = nullptr;
  struct ggml_tensor* embd_enc = nullptr;

  // This is to surcomvent an issue where accessing embd_enc in docoder was not
  // working The buffer was somehow changed.
  std::vector<float> encoder_result;

  // helpers for GPU offloading
  std::vector<float> inp_mel;
  std::vector<float> inp_mask;

  // decode output (2-dimensional array: [n_tokens][n_vocab])
  std::vector<float> logits;

  // std::vector<nmt_segment> result_all;
  std::vector<nmt_token> prompt_past;

  int lang_id = 0; // english by default

  std::string path_model; // populated by nmt_init_from_file_with_params()

  // [EXPERIMENTAL] token-level timestamps data
  int64_t t_beg = 0;
  int64_t t_last = 0;

  nmt_token tid_last{};

  std::vector<float> energy; // PCM signal energy
  float no_speech_prob = 0.0F;

  // [EXPERIMENTAL] Token-level timestamps with DTW
  // nmt_aheads_masks aheads_masks;
  ggml_tensor* aheads_cross_QKs = nullptr;
  std::vector<float> aheads_cross_QKs_data;

  // [EXPERIMENTAL] speed-up techniques
  int32_t exp_n_encoder_ctx = 0; // 0 - use default

  std::vector<nmt_token> text_tokens;

  int text_tokens_begin = 0;
  int tokens_to_process = 512;

  std::vector<int32_t> decoder_inputs;
  std::string result_all;
};

struct nmt_context_params {
  bool use_gpu;
  bool flash_attn;
  int gpu_device;
};

struct nmt_context {
  int64_t t_load_us = 0;
  int64_t t_start_us = 0;

  ggml_type wtype = ggml_type::GGML_TYPE_F32; // weight type (FP32 / FP16 / QX)
  ggml_type itype =
      ggml_type::GGML_TYPE_F16; // intermediate type (FP32 or FP16)

  nmt_context_params params{};

  nmt_model model;
  nmt_vocab vocab;

  nmt_state* state = nullptr;

  std::string path_model; // populated by nmt_init_from_file_with_params()

  void setBeamSize(int64_t beam_size) {
    if (beam_size < 0) {
      throw std::runtime_error("Invalid beam size.");
    }
    model.config.beam_size = beam_size;
  }

  void setLengthPenalty(double length_penalty) {
    if (length_penalty < 0.0f) {
      throw std::runtime_error("Invalid length penalty.");
    }
    model.config.length_penalty = length_penalty;
  }

  void setMaxLength(int64_t max_length) {
    if (max_length < 0 || max_length > 512) {
      throw std::runtime_error("Invalid max length");
    }
    model.config.max_length = max_length;
  }

  void setRepetitionPenalty(double repetition_penalty) {
    if (repetition_penalty < 0.0f || repetition_penalty > 2.0f) {
      throw std::runtime_error("Invalid repetition penalty.");
    }
    model.config.repetition_penalty = repetition_penalty;
  }

  void setNoRepeatNgramSize(int64_t no_repeat_ngram_size) {
    if (no_repeat_ngram_size < 0.0f || no_repeat_ngram_size > 10) {
      throw std::runtime_error("Invalid no repeat ngram size.");
    }
    model.config.no_repeat_ngram_size = no_repeat_ngram_size;
  }

  void setTemperature(double temperature) {
    if (temperature < 0.0f || temperature > 2.0f) {
      throw std::runtime_error("Invalid temperature.");
    }
    model.config.temperature = temperature;
  }

  void setTopK(int64_t top_k) {
    if (top_k < 0 || top_k > vocab.src_token_to_id.size()) {
      throw std::runtime_error("Invalid top_k");
    }
    model.config.top_k = top_k;
  }

  void setTopP(double top_p) {
    if (top_p < 0.0f || top_p > 1.0f) {
      throw std::runtime_error("Invalid top_p value.");
    }
    model.config.top_p = top_p;
  }
};

typedef struct nmt_model_loader {
  void* context;

  size_t (*read)(void* ctx, void* output, size_t read_size);
  bool (*eof)(void* ctx);
  void (*close)(void* ctx);
} nmt_model_loader;

int nmt_encode(struct nmt_context* ctx);

int nmt_full(struct nmt_context* ctx, const char* inputText);

int nmt_token_count(struct nmt_context* ctx, const char* text);

const char* nmt_get_output(struct nmt_context* ctx);

int nmt_get_runtime_stats(
    struct nmt_context* ctx, double* encodeTime, double* decodeTime,
    int* totalTokens);

void nmt_reset_runtime_stats(struct nmt_context* ctx);

void nmt_reset_state(struct nmt_context* ctx);

struct nmt_context* nmt_init_from_file_with_params(
    const char* pathModel, struct nmt_context_params params);

struct nmt_context_params nmt_context_default_params();

const char* nmt_model_type_readable(struct nmt_context* ctx);

int nmt_model_n_vocab(struct nmt_context* ctx);

bool nmt_model_is_indictrans(struct nmt_context* ctx);

void nmt_free(struct nmt_context* ctx);

// NOLINTEND(readability-identifier-naming,modernize-use-using,cppcoreguidelines-macro-to-enum,modernize-macro-to-enum,readability-magic-numbers,cppcoreguidelines-avoid-magic-numbers,readability-uppercase-literal-suffix)
// NOLINTEND
// END: C-style performance-critical section
