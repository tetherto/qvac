// NOLINTBEGIN
#include "nmt_state_backend.hpp"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include <ggml-backend.h>
#include <ggml.h>

#include "nmt.hpp"
#include "nmt_graph_decoder.hpp"
#include "nmt_graph_encoder.hpp"
#include "nmt_utils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

void nmtBatchPrepLegacy(
    nmt_batch& batch, const nmt_token* tokens, int nTokens, int nPast,
    int seqId) {
  batch.n_tokens = nTokens;
  for (int i = 0; i < nTokens; ++i) {
    if (tokens) {
      batch.token[i] = tokens[i];
    }
    batch.pos[i] = nPast + i;
    batch.n_seq_id[i] = 1;
    batch.seq_id[i][0] = seqId;
    batch.logits[i] = 0;
  }
  batch.logits[nTokens - 1] = 1;
}

struct nmt_batch nmtBatchInit(int32_t nTokens, int32_t nSeqMax) {
  nmt_batch batch = {
      0,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
      nullptr,
  };

  batch.token = (nmt_token*)malloc(sizeof(nmt_token) * (nTokens));
  batch.pos = (nmt_pos*)malloc(sizeof(nmt_pos) * (nTokens));
  batch.n_seq_id = (int32_t*)malloc(sizeof(int32_t) * (nTokens));
  batch.seq_id = (nmt_seq_id**)malloc(sizeof(nmt_seq_id*) * (nTokens + 1));
  for (int i = 0; i < nTokens; ++i) {
    batch.seq_id[i] = (nmt_seq_id*)malloc(sizeof(nmt_seq_id) * nSeqMax);
  }
  batch.seq_id[nTokens] = nullptr;
  batch.logits = (int8_t*)malloc(sizeof(int8_t) * nTokens);

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

void nmtKvCacheFree(struct nmt_kv_cache& cache) {
  ggml_backend_buffer_free(cache.buffer);
}

uint32_t nmtKvCacheGetPadding(const struct nmt_context& ctx) {
  if (!ctx.params.flash_attn || !ctx.params.use_gpu) {
    return 1u;
  }

#ifdef GGML_USE_METAL
  return 32U;
#endif

#ifdef GGML_USE_CUDA
  return 256U;
#endif

  // Vulkan (including Adreno): align to 32 for flash attention.
  // Adreno 830 uses warp size 64 but 32 is the safe minimum that
  // satisfies both desktop and mobile Vulkan implementations.
  return 32U;
}

int32_t nmtKvCacheCellMax(const struct nmt_kv_cache& cache) {
  for (uint32_t i = cache.size - 1; i > 0; --i) {
    if (cache.cells[i].pos >= 0 && !cache.cells[i].seq_id.empty()) {
      return i + 1;
    }
  }

  return 1;
}

bool nmtKvCacheFindSlot(
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

bool nmtKvCacheInit(
    struct nmt_kv_cache& cache, ggml_backend_t backend, ggml_type wtype,
    int64_t dModel, int64_t nDecoderLayers, int nCtx) {
  const int64_t n_mem = nDecoderLayers * nCtx;
  const int64_t n_elements = dModel * n_mem;

  cache.ctx_buf.resize(2 * ggml_tensor_overhead());

  struct ggml_init_params params = {
      /*.mem_size   =*/cache.ctx_buf.size(),
      /*.mem_buffer =*/cache.ctx_buf.data(),
      /*.no_alloc   =*/true,
  };

  cache.head = 0;
  cache.size = nCtx;

  cache.cells.clear();
  cache.cells.resize(nCtx);

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

void nmtBatchFree(struct nmt_batch batch) {
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

void nmtFreeState(struct nmt_state* state) {
  if (state) {
    nmtKvCacheFree(state->kv_self);
    nmtKvCacheFree(state->kv_cross);

    nmtBatchFree(state->batch);

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

void nmtResetRuntimeStats(struct nmt_context* ctx) {
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

int nmtGetRuntimeStats(
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

void nmtKvCacheClear(struct nmt_kv_cache& cache) {
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

// Extract trailing numeric ordinal from an ggml device name.
// E.g. "Vulkan0" → 0, "OpenCL1" → 1, "Metal" → -1.
// GGML assigns the same ordinal to different API surfaces that wrap the
// same physical GPU (e.g. Vulkan0 and OpenCL0 both map to GPU #0).
static int nmtExtractDeviceOrdinal(const char* name) {
  if (name == nullptr) {
    return -1;
  }
  static constexpr size_t kMaxNameLen = 256;
  size_t len = strnlen(name, kMaxNameLen);
  if (len == 0) {
    return -1;
  }
  size_t digit_start = len;
  while (digit_start > 0 &&
         std::isdigit(static_cast<unsigned char>(name[digit_start - 1]))) {
    --digit_start;
  }
  if (digit_start == len) {
    return -1;
  }
  int ordinal = 0;
  for (size_t j = digit_start; j < len; ++j) {
    ordinal = ordinal * 10 + (name[j] - '0');
  }
  return ordinal;
}

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

  // Compute-device selection when use_gpu=true.
  //
  // Matching compute devices by `!= CPU` (rather than a named GPU/ACCEL
  // allow-list) is resilient to ggml inserting new enum values between
  // builds; Android's qvac-fabric ggml reports some devices with an enum
  // value between GPU and ACCEL.
  //
  // Two selection modes:
  //   1. params.gpu_backend non-empty → explicit single-pass filter:
  //      pick the first non-CPU device whose name contains gpu_backend
  //      (case-insensitive substring). `gpu_device` is the ordinal
  //      within matches, so {gpu_backend="vulkan", gpu_device=1} picks
  //      the second Vulkan adapter. Bypasses the OpenCL guard — an
  //      explicit "opencl" request is an informed opt-in.
  //   2. params.gpu_backend empty → gated default: when
  //      QVAC_NMTCPP_USE_OPENCL is defined, prefer an OpenCL-named
  //      device first; otherwise (and always as a fallback) pick any
  //      non-CPU device. When the guard is off, the fallback also
  //      skips OpenCL-named devices so Bergamot/IndicTrans on Adreno
  //      830 don't hit the q4_0 transpose crash (QVAC-17790).
  // Delegate to the shared selector so make_buft_list (in nmt_loader.cpp)
  // and this function agree on the same physical device — historical
  // drift between the two has caused scheduler crashes (R2-C1, R4-C2).
  // See nmt_utils.hpp for the contract.
  dev = nmtSelectGpuDevice(
      params.use_gpu,
      params.gpu_backend,
      params.gpu_device,
      "nmt_backend_init_gpu");

  if (dev == nullptr) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "No GPU backend selected - will use CPU");
    return nullptr;
  }

  const char* devName = ggml_backend_dev_name(dev);
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      std::string("[nmt_backend_init_gpu] About to init device: ") +
          (devName ? devName : "(null)"));

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

  if (params.op_offload_min_batch >= 0) {
    static std::mutex s_offloadMtx;
    static int s_offloadFirstVal = -1;

    std::lock_guard<std::mutex> lk(s_offloadMtx);
    if (s_offloadFirstVal < 0) {
      s_offloadFirstVal = params.op_offload_min_batch;
      std::string val = std::to_string(params.op_offload_min_batch);
#ifdef _WIN32
      _putenv_s("GGML_VK_OFFLOAD_MIN_BATCH", val.c_str());
#else
      setenv("GGML_VK_OFFLOAD_MIN_BATCH", val.c_str(), 1);
#endif
      std::ostringstream oss_offload;
      oss_offload << "Set GGML_VK_OFFLOAD_MIN_BATCH="
                  << params.op_offload_min_batch;
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          oss_offload.str());
    } else if (s_offloadFirstVal != params.op_offload_min_batch) {
      std::ostringstream oss_offload;
      oss_offload << "op_offload_min_batch=" << params.op_offload_min_batch
                  << " requested but process-wide value already set to "
                  << s_offloadFirstVal << " by first instance — ignoring";
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
          oss_offload.str());
    }
  }

  std::vector<ggml_backend_t> result;

  ggml_backend_t backend_gpu = nmt_backend_init_gpu(params);

  // Primary backend may also be an ACCEL device (see nmt_backend_init_gpu —
  // Android Vulkan registers as ACCEL). Track the device pointer we already
  // picked so the secondary ACCEL loop below doesn't re-init the same device.
  ggml_backend_dev_t primary_dev =
      backend_gpu ? ggml_backend_get_device(backend_gpu) : nullptr;

  if (backend_gpu) {
    result.push_back(backend_gpu);
  }

  // ACCEL backends (in addition to the primary if it was an ACCEL device).
  //
  // On Android (and other mobile SoCs with a single physical GPU), multiple
  // GGML backends (Vulkan, OpenCL) may register as separate ACCEL devices
  // for the same hardware.  Initialising all of them adds synchronisation
  // overhead in ggml_backend_sched without any parallel-compute benefit
  // because the scheduler executes splits sequentially.
  //
  // Filter strategy:
  //   1. Skip the device pointer already selected as primary (same as before).
  //   2. Skip OpenCL devices when the build-time USE_OPENCL guard is off
  //      (consistent with Mode 2b in nmtSelectGpuDevice).
  //   3. Skip any ACCEL device whose trailing ordinal matches the primary's.
  //      GGML names devices as "<API><ordinal>" (e.g. Vulkan0, OpenCL0).
  //      Same ordinal + different API prefix = same physical GPU exposed
  //      through a different backend.  This is immune to driver-level
  //      description string variation and consistent with the JS-side
  //      dedup in _extractPhysicalGpuKey.
  const char* primary_name =
      primary_dev ? ggml_backend_dev_name(primary_dev) : nullptr;
  int primary_ordinal = nmtExtractDeviceOrdinal(primary_name);

  for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    if (dev == nullptr) {
      continue;
    }
    if (primary_dev != nullptr && dev == primary_dev) {
      continue;
    }
    if (ggml_backend_dev_type(dev) != GGML_BACKEND_DEVICE_TYPE_ACCEL) {
      continue;
    }
    const char* dev_name = ggml_backend_dev_name(dev);

#ifndef QVAC_NMTCPP_USE_OPENCL
    if (nmtNameContainsCi(dev_name, "opencl")) {
      std::ostringstream oss;
      oss << "Skipping ACCEL device '" << (dev_name ? dev_name : "(null)")
          << "' — OpenCL guard is off (QVAC-17790)";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
      continue;
    }
#endif

    int dev_ordinal = nmtExtractDeviceOrdinal(dev_name);
    if (primary_ordinal >= 0 && dev_ordinal >= 0 &&
        primary_ordinal == dev_ordinal) {
      std::ostringstream oss;
      oss << "Skipping ACCEL device '" << (dev_name ? dev_name : "(null)")
          << "' — same GPU ordinal (" << dev_ordinal << ") as primary '"
          << (primary_name ? primary_name : "(null)") << "'";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss.str());
      continue;
    }

    ggml_backend_t backend = ggml_backend_dev_init(dev, nullptr);
    if (!backend) {
      continue;
    }
    result.push_back(backend);
  }

  ggml_backend_t backend_cpu =
      ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
  if (backend_cpu == nullptr) {
    throw std::runtime_error("failed to initialize CPU backend");
  }
  result.push_back(backend_cpu);

  return result;
}

void nmtResetState(struct nmt_context* ctx) {
  if (!ctx || !ctx->state) {
    return;
  }

  nmt_state* state = ctx->state;

  nmtKvCacheClear(state->kv_self);
  nmtKvCacheClear(state->kv_cross);

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
struct nmt_state* nmtInitState(nmt_context* ctx) {
  nmt_state* state = new nmt_state;

  state->backends = nmt_backend_init(ctx->params);
  if (state->backends.empty()) {
    // NMT_LOG_ERROR("%s: nmt_backend_init() failed\n", __func__);
    nmtFreeState(state);
    return nullptr;
  }

  // at this point, we don't know yet how many decoders will be used
  // later during decoding, if more decoders are used, we will recreate the KV
  // cache respectively
  state->kv_self_n_dec = 1;
  if (!nmtKvCacheInit(
          state->kv_self,
          state->backends[0],
          ctx->itype,
          ctx->model.hparams.n_text_state,
          ctx->model.hparams.n_decoder_layers,
          GGML_PAD(ctx->model.hparams.n_decoder_ctx, 256))) {
    // NMT_LOG_ERROR("%s: nmtKvCacheInit() failed for self-attention
    // cache\n", __func__);
    nmtFreeState(state);
    return nullptr;
  }

  {
    const size_t memory_size =
        ggml_nbytes(state->kv_self.k) + ggml_nbytes(state->kv_self.v);
    // NMT_LOG_INFO("%s: kv self size  = %7.2f MB\n", __func__, memory_size /
    // 1e6);
  }

  if (!nmtKvCacheInit(
          state->kv_cross,
          state->backends[0],
          ctx->itype,
          ctx->model.hparams.n_text_state,
          ctx->model.hparams.n_decoder_layers,
          GGML_PAD(ctx->model.hparams.n_encoder_ctx, 256))) {
    // NMT_LOG_ERROR("%s: nmtKvCacheInit() failed for cross-attention
    // cache\n", __func__);
    nmtFreeState(state);
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
    nmtFreeState(state);
    return nullptr;
#endif
  } else {
    // NMT_LOG_INFO("%s: Core ML model loaded\n", __func__);
  }
#endif

  state->logits.reserve(
      ctx->model.hparams.n_vocab * ctx->model.hparams.n_decoder_ctx);

  state->batch =
      nmtBatchInit(ctx->model.hparams.n_decoder_ctx, NMT_MAX_DECODERS);

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
      return nmtBuildGraphEncoder(*ctx, *state);
    });

    if (!ok) {
      // NMT_LOG_ERROR("%s: failed to init encoder allocator\n", __func__);
      nmtFreeState(state);
      return nullptr;
    }
  }
  // NMT_LOG_INFO("%s: compute buffer (encode) = %7.2f MB\n", __func__,
  // nmt_sched_size(state->sched_encode) / 1e6);
  {
    bool ok = nmt_sched_graph_init(state->sched_cross, state->backends, [&]() {
      return nmtBuildGraphCross(*ctx, *state);
    });

    if (!ok) {
      // NMT_LOG_ERROR("%s: failed to init cross allocator\n", __func__);
      nmtFreeState(state);
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
    nmtBatchPrepLegacy(state->batch, nullptr, n_tokens, n_past, 0);

    return nmtBuildGraphDecoder(*ctx, *state, state->batch, true);
  });

  if (!ok) {
    // NMT_LOG_ERROR("%s: failed to init decoder allocator\n", __func__);
    nmtFreeState(state);
    return nullptr;
  }

  // NMT_LOG_INFO("%s: compute buffer (decode) = %7.2f MB\n", __func__,
  // nmt_sched_size(state->sched_decode) / 1e6);

  return state;
}

// NOLINTEND
