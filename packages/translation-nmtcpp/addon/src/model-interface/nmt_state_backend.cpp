// NOLINTBEGIN
#include "nmt_state_backend.hpp"

#include <cstdint>
#include <sstream>
#include <vector>

#include <ggml-backend.h>
#include <ggml.h>

#include "nmt.hpp"
#include "nmt_graph_decoder.hpp"
#include "nmt_graph_encoder.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

void nmt_batch_prep_legacy(
    nmt_batch& batch, const nmt_token* tokens, int n_tokens, int n_past,
    int seq_id) {
  batch.n_tokens = n_tokens;
  for (int i = 0; i < n_tokens; ++i) {
    if (tokens) {
      batch.token[i] = tokens[i];
    }
    batch.pos[i] = n_past + i;
    batch.n_seq_id[i] = 1;
    batch.seq_id[i][0] = seq_id;
    batch.logits[i] = 0;
  }
  batch.logits[n_tokens - 1] = 1;
}

struct nmt_batch nmt_batch_init(int32_t n_tokens, int32_t n_seq_max) {
  nmt_batch batch = {
      0,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
  };

  batch.token = (nmt_token*)malloc(sizeof(nmt_token) * (n_tokens));
  batch.pos = (nmt_pos*)malloc(sizeof(nmt_pos) * (n_tokens));
  batch.n_seq_id = (int32_t*)malloc(sizeof(int32_t) * (n_tokens));
  batch.seq_id = (nmt_seq_id**)malloc(sizeof(nmt_seq_id*) * (n_tokens + 1));
  for (int i = 0; i < n_tokens; ++i) {
    batch.seq_id[i] = (nmt_seq_id*)malloc(sizeof(nmt_seq_id) * n_seq_max);
  }
  batch.seq_id[n_tokens] = nullptr;
  batch.logits = (int8_t*)malloc(sizeof(int8_t) * n_tokens);

  return batch;
}

static bool nmt_sched_graph_init(
    struct nmt_sched& allocr, std::vector<ggml_backend_t> backends,
    std::function<struct ggml_cgraph*()>&& get_graph) {
  auto& sched = allocr.sched;
  auto& meta = allocr.meta;

  sched = ggml_backend_sched_new(
      backends.data(), nullptr, backends.size(), NMT_MAX_NODES, false, true);

  meta.resize(ggml_tensor_overhead() * NMT_MAX_NODES + ggml_graph_overhead());

  // since there are dependencies between the different graphs,
  // we need to allocate them instead of only reserving to get the correct
  // compute buffer size
  if (!ggml_backend_sched_alloc_graph(sched, get_graph())) {
    // failed to allocate the compute buffer
    return false;
  }

  ggml_backend_sched_reset(sched);

  return true;
}

void nmt_kv_cache_free(struct nmt_kv_cache& cache) {
  ggml_backend_buffer_free(cache.buffer);
}

uint32_t nmt_kv_cache_get_padding(const struct nmt_context& ctx) {
  if (!ctx.params.flash_attn || !ctx.params.use_gpu) {
    return 1u;
  }

#ifdef GGML_USE_METAL
  if (ctx.params.use_gpu) {
    return 32U;
  }
#endif

#ifdef GGML_USE_CUDA
  if (ctx.params.use_gpu) {
    return 256U;
  }
#endif

  return 1u;
}

int32_t nmt_kv_cache_cell_max(const struct nmt_kv_cache& cache) {
  for (uint32_t i = cache.size - 1; i > 0; --i) {
    if (cache.cells[i].pos >= 0 && !cache.cells[i].seq_id.empty()) {
      return i + 1;
    }
  }

  return 1;
}

bool nmt_kv_cache_find_slot(
    struct nmt_kv_cache& cache, const struct nmt_batch& batch) {
  const uint32_t n_ctx = cache.size;
  const uint32_t n_tokens = batch.n_tokens;

  if (n_tokens > n_ctx) {
    // NMT_LOG_ERROR("%s: n_tokens=%d > n_ctx=%d\n", __func__, n_tokens, n_ctx);
    return false;
  }

  uint32_t n_tested = 0;

  while (true) {
    if (cache.head + n_tokens > n_ctx) {
      n_tested += n_ctx - cache.head;
      cache.head = 0;
      continue;
    }

    bool found = true;
    for (uint32_t i = 0; i < n_tokens; i++) {
      if (cache.cells[cache.head + i].pos >= 0) {
        found = false;
        cache.head += i + 1;
        n_tested += i + 1;
        break;
      }
    }

    if (found) {
      break;
    }

    if (n_tested >= n_ctx) {
      return false;
    }
  }

  for (uint32_t i = 0; i < n_tokens; i++) {
    cache.cells[cache.head + i].pos = batch.pos[i];

    for (int32_t j = 0; j < batch.n_seq_id[i]; j++) {
      cache.cells[cache.head + i].seq_id.insert(batch.seq_id[i][j]);
    }
  }

  return true;
}

bool nmt_kv_cache_init(
    struct nmt_kv_cache& cache, ggml_backend_t backend, ggml_type wtype,
    int64_t d_model, int64_t n_decoder_layers, int n_ctx) {
  const int64_t n_mem = n_decoder_layers * n_ctx;
  const int64_t n_elements = d_model * n_mem;

  cache.ctx_buf.resize(2 * ggml_tensor_overhead());

  struct ggml_init_params params = {
      /*.mem_size   =*/cache.ctx_buf.size(),
      /*.mem_buffer =*/cache.ctx_buf.data(),
      /*.no_alloc   =*/true,
  };

  cache.head = 0;
  cache.size = n_ctx;

  cache.cells.clear();
  cache.cells.resize(n_ctx);

  struct ggml_context* ctx = ggml_init(params);

  if (ctx == nullptr) {
    // NMT_LOG_ERROR("%s: failed to allocate memory for the kv cache context\n",
    // __func__);
    return false;
  }

  cache.k = ggml_new_tensor_1d(ctx, wtype, n_elements);
  cache.v = ggml_new_tensor_1d(ctx, wtype, n_elements);

  cache.buffer = ggml_backend_alloc_ctx_tensors(ctx, backend);
  if (!cache.buffer) {
    // NMT_LOG_ERROR("%s: failed to allocate memory for the kv cache\n",
    // __func__);
    return false;
  }

  ggml_backend_buffer_clear(cache.buffer, 0);

  ggml_free(ctx);

  return true;
}

void nmt_batch_free(struct nmt_batch batch) {
  if (batch.token) {
    free(batch.token);
  }
  if (batch.pos) {
    free(batch.pos);
  }
  if (batch.n_seq_id) {
    free(batch.n_seq_id);
  }
  if (batch.seq_id) {
    for (int i = 0; batch.seq_id[i]; ++i) {
      free(batch.seq_id[i]);
    }
    free(batch.seq_id);
  }
  if (batch.logits) {
    free(batch.logits);
  }
}

void nmt_free_state(struct nmt_state* state) {
  if (state) {
    nmt_kv_cache_free(state->kv_self);
    nmt_kv_cache_free(state->kv_cross);

    nmt_batch_free(state->batch);

    ggml_backend_sched_free(state->sched_conv.sched);
    ggml_backend_sched_free(state->sched_encode.sched);
    ggml_backend_sched_free(state->sched_cross.sched);
    ggml_backend_sched_free(state->sched_decode.sched);

    for (auto& backend : state->backends) {
      ggml_backend_free(backend);
    }

    delete state;
  }
}

void nmt_reset_runtime_stats(struct nmt_context* ctx) {
  if (!ctx || !ctx->state) {
    return;
  }

  nmt_state* state = ctx->state;
  state->t_sample_us = 0;
  state->t_encode_us = 0;
  state->t_decode_us = 0;
  state->t_batchd_us = 0;
  state->t_prompt_us = 0;
  state->t_mel_us = 0;
  state->n_sample = 0;
  state->n_encode = 0;
  state->n_decode = 0;
  state->n_batchd = 0;
  state->n_prompt = 0;
  state->n_fail_p = 0;
  state->n_fail_h = 0;
}

int nmt_get_runtime_stats(
    struct nmt_context* ctx, double* encode_time, double* decode_time,
    int* total_tokens) {
  if (!ctx || !ctx->state) {
    return -1;
  }

  nmt_state* state = ctx->state;

  if (encode_time) {
    *encode_time = (double)state->t_encode_us / 1e6;
  }
  if (decode_time) {
    *decode_time = (double)state->t_decode_us / 1e6;
  }
  if (total_tokens) {
    *total_tokens = state->n_decode;
  }

  return 0;
}

void nmt_kv_cache_clear(struct nmt_kv_cache& cache) {
  if (cache.buffer) {
    ggml_backend_buffer_clear(cache.buffer, 0);
  }

  cache.head = 0;
  cache.n = 0;

  for (auto& cell : cache.cells) {
    cell.pos = -1;
    cell.seq_id.clear();
  }
}

struct nmt_global {
  // We save the log callback globally
  // ggml_log_callback log_callback = nmt_log_callback_default;
  ggml_log_callback log_callback = nullptr;
  void* log_callback_user_data = nullptr;
};

static nmt_global g_state;

static ggml_backend_t nmt_backend_init_gpu(const nmt_context_params& params) {
  ggml_log_set(g_state.log_callback, g_state.log_callback_user_data);

  ggml_backend_dev_t dev = nullptr;

  std::ostringstream oss_gpu_init;
  oss_gpu_init << "GPU Init: use_gpu=" << params.use_gpu
               << ", gpu_device=" << params.gpu_device
               << ", backends=" << ggml_backend_dev_count();
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      oss_gpu_init.str());

  int cnt = 0;
  if (params.use_gpu) {
    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
      ggml_backend_dev_t dev_cur = ggml_backend_dev_get(i);
      enum ggml_backend_dev_type dev_type = ggml_backend_dev_type(dev_cur);
      const char* name = ggml_backend_dev_name(dev_cur);
      std::ostringstream oss_backend;
      oss_backend << "  Backend[" << i << "]: type=" << dev_type
                  << ", name=" << name;
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          oss_backend.str());

      if (dev_type == GGML_BACKEND_DEVICE_TYPE_GPU) {
        std::ostringstream oss_found;
        oss_found << "  Found GPU backend: " << name;
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
            oss_found.str());
        if (cnt == 0 || cnt == params.gpu_device) {
          dev = dev_cur;
          std::ostringstream oss_selected;
          oss_selected << "  **SELECTED GPU**: " << name;
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
              oss_selected.str());
        }
        if (++cnt > params.gpu_device) {
          break;
        }
      }
    }
  }

  if (dev == nullptr) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "No GPU backend selected - will use CPU");
    return nullptr;
  }

  ggml_backend_t result = ggml_backend_dev_init(dev, nullptr);
  if (!result) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "FAILED to initialize GPU backend");
  } else {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "SUCCESS: GPU backend initialized!");
  }

  return result;
}

static std::vector<ggml_backend_t>
nmt_backend_init(const nmt_context_params& params) {
  std::ostringstream oss_backend_init;
  oss_backend_init << "=== nmt_backend_init called, use_gpu=" << params.use_gpu
                   << " ===";
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      oss_backend_init.str());

  std::vector<ggml_backend_t> result;

  ggml_backend_t backend_gpu = nmt_backend_init_gpu(params);

  if (backend_gpu) {
    result.push_back(backend_gpu);
  }

  // ACCEL backends
  for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    if (ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_ACCEL) {
      ggml_backend_t backend = ggml_backend_dev_init(dev, nullptr);
      if (!backend) {
        continue;
      }
      result.push_back(backend);
    }
  }

  ggml_backend_t backend_cpu =
      ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
  if (backend_cpu == nullptr) {
    throw std::runtime_error("failed to initialize CPU backend");
  }
  result.push_back(backend_cpu);

  return result;
}

void nmt_reset_state(struct nmt_context* ctx) {
  if (!ctx || !ctx->state) {
    return;
  }

  nmt_state* state = ctx->state;

  nmt_kv_cache_clear(state->kv_self);
  nmt_kv_cache_clear(state->kv_cross);

  state->encoder_result.clear();
  state->logits.clear();
  state->text_tokens.clear();
  state->decoder_inputs.clear();
  state->result_all.clear();
  state->prompt_past.clear();

  state->inp_mel.clear();
  state->inp_mask.clear();

  state->input_embeddings = nullptr;
  state->logits_tensor = nullptr;
  state->embd_enc = nullptr;
  state->aheads_cross_QKs = nullptr;
  state->aheads_cross_QKs_data.clear();

  state->energy.clear();
  state->no_speech_prob = 0.0F;
  state->tid_last = 0;
  state->t_beg = 0;
  state->t_last = 0;
  state->lang_id = 0;
  state->exp_n_encoder_ctx = 0;

  if (state->sched_conv.sched) {
    ggml_backend_sched_reset(state->sched_conv.sched);
  }
  if (state->sched_encode.sched) {
    ggml_backend_sched_reset(state->sched_encode.sched);
  }
  if (state->sched_cross.sched) {
    ggml_backend_sched_reset(state->sched_cross.sched);
  }
  if (state->sched_decode.sched) {
    ggml_backend_sched_reset(state->sched_decode.sched);
  }
  state->decoders[0].rng.seed(0);
}
struct nmt_state* nmt_init_state(nmt_context* ctx) {
  nmt_state* state = new nmt_state;

  state->backends = nmt_backend_init(ctx->params);
  if (state->backends.empty()) {
    // NMT_LOG_ERROR("%s: nmt_backend_init() failed\n", __func__);
    nmt_free_state(state);
    return nullptr;
  }

  // at this point, we don't know yet how many decoders will be used
  // later during decoding, if more decoders are used, we will recreate the KV
  // cache respectively
  state->kv_self_n_dec = 1;
  if (!nmt_kv_cache_init(
          state->kv_self,
          state->backends[0],
          ctx->itype,
          ctx->model.hparams.n_text_state,
          ctx->model.hparams.n_decoder_layers,
          GGML_PAD(ctx->model.hparams.n_decoder_ctx, 256))) {
    // NMT_LOG_ERROR("%s: nmt_kv_cache_init() failed for self-attention
    // cache\n", __func__);
    nmt_free_state(state);
    return nullptr;
  }

  {
    const size_t memory_size =
        ggml_nbytes(state->kv_self.k) + ggml_nbytes(state->kv_self.v);
    // NMT_LOG_INFO("%s: kv self size  = %7.2f MB\n", __func__, memory_size /
    // 1e6);
  }

  if (!nmt_kv_cache_init(
          state->kv_cross,
          state->backends[0],
          ctx->itype,
          ctx->model.hparams.n_text_state,
          ctx->model.hparams.n_decoder_layers,
          GGML_PAD(ctx->model.hparams.n_encoder_ctx, 256))) {
    // NMT_LOG_ERROR("%s: nmt_kv_cache_init() failed for cross-attention
    // cache\n", __func__);
    nmt_free_state(state);
    return nullptr;
  }

  {
    const size_t memory_size =
        ggml_nbytes(state->kv_cross.k) + ggml_nbytes(state->kv_cross.v);
    // NMT_LOG_INFO("%s: kv cross size = %7.2f MB\n", __func__, memory_size /
    // 1e6);
  }

#ifdef NMT_USE_COREML
  const auto path_coreml = nmt_get_coreml_path_encoder(ctx->path_model);

  // NMT_LOG_INFO("%s: loading Core ML model from '%s'\n", __func__,
  // path_coreml.c_str()); NMT_LOG_INFO("%s: first run on a device may take a
  // while ...\n", __func__);

  state->ctx_coreml = nmt_coreml_init(path_coreml.c_str());
  if (!state->ctx_coreml) {
    // NMT_LOG_ERROR("%s: failed to load Core ML model from '%s'\n", __func__,
    // path_coreml.c_str());
#ifndef NMT_COREML_ALLOW_FALLBACK
    nmt_free_state(state);
    return nullptr;
#endif
  } else {
    // NMT_LOG_INFO("%s: Core ML model loaded\n", __func__);
  }
#endif

  state->logits.reserve(
      ctx->model.hparams.n_vocab * ctx->model.hparams.n_decoder_ctx);

  state->batch =
      nmt_batch_init(ctx->model.hparams.n_decoder_ctx, NMT_MAX_DECODERS);

  // TAGS: NMT_DECODER_INIT
  // state->decoders[0].sequence.tokens.reserve(ctx->model.hparams.n_decoder_ctx);

  state->decoders[0].probs.reserve(ctx->model.hparams.n_vocab);
  state->decoders[0].logits.reserve(ctx->model.hparams.n_vocab);
  state->decoders[0].logprobs.reserve(ctx->model.hparams.n_vocab);
  state->decoders[0].sorted_probs.reserve(ctx->model.hparams.n_vocab);
  state->decoders[0].logits_id.resize(ctx->model.hparams.n_vocab);

  state->decoders[0].rng = std::mt19937(0);
  state->tokens_to_process = ctx->model.hparams.n_decoder_ctx;

  // encoder allocator
  {
    bool ok = nmt_sched_graph_init(state->sched_encode, state->backends, [&]() {
      return nmt_build_graph_encoder(*ctx, *state);
    });

    if (!ok) {
      // NMT_LOG_ERROR("%s: failed to init encoder allocator\n", __func__);
      nmt_free_state(state);
      return nullptr;
    }
  }
  // NMT_LOG_INFO("%s: compute buffer (encode) = %7.2f MB\n", __func__,
  // nmt_sched_size(state->sched_encode) / 1e6);
  {
    bool ok = nmt_sched_graph_init(state->sched_cross, state->backends, [&]() {
      return nmt_build_graph_cross(*ctx, *state);
    });

    if (!ok) {
      // NMT_LOG_ERROR("%s: failed to init cross allocator\n", __func__);
      nmt_free_state(state);
      return nullptr;
    }

    // NMT_LOG_INFO("%s: compute buffer (cross)  = %7.2f MB\n", __func__,
    // nmt_sched_size(state->sched_cross) / 1e6);
  }

  bool ok = nmt_sched_graph_init(state->sched_decode, state->backends, [&]() {
    const auto& hparams = ctx->model.hparams;

    const int n_tokens = hparams.n_decoder_ctx;
    const int n_past = 0;
    state->decoder_inputs.resize(512);
    nmt_batch_prep_legacy(state->batch, nullptr, n_tokens, n_past, 0);

    return nmt_build_graph_decoder(*ctx, *state, state->batch, true);
  });

  if (!ok) {
    // NMT_LOG_ERROR("%s: failed to init decoder allocator\n", __func__);
    nmt_free_state(state);
    return nullptr;
  }

  // NMT_LOG_INFO("%s: compute buffer (decode) = %7.2f MB\n", __func__,
  // nmt_sched_size(state->sched_decode) / 1e6);

  return state;
}

// NOLINTEND
