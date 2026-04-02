// NOLINTBEGIN
#include <cstdint>
#include <cstring>
#include <fstream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <stdarg.h>

#include "nmt.hpp"

#ifdef _MSC_VER
#include <codecvt>
#endif

#include "ggml-backend.h"
#include "ggml-cpp.h"
#include "ggml.h"
#include "nmt.hpp"
#include "nmt_graph_decoder.hpp"
#include "nmt_loader.hpp"
#include "nmt_state_backend.hpp"
#include "nmt_tokenization.hpp"
#include "nmt_utils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

static std::string format(const char* fmt, ...) {
  va_list ap;
  va_list ap2;
  va_start(ap, fmt);
  va_copy(ap2, ap);
  int size = vsnprintf(NULL, 0, fmt, ap);
  GGML_ASSERT(size >= 0 && size < INT_MAX); // NOLINT
  std::vector<char> buf(size + 1);
  int size2 = vsnprintf(buf.data(), size + 1, fmt, ap2);
  GGML_ASSERT(size2 == size);
  va_end(ap2);
  va_end(ap);
  return std::string(buf.data(), size);
}

#if defined(NMT_BIG_ENDIAN)
template <typename T> static T byteswap(T value) {
  T value_swapped;
  char* source = reinterpret_cast<char*>(&value);
  char* target = reinterpret_cast<char*>(&value_swapped);
  int size = sizeof(T);
  for (int i = 0; i < size; i++) {
    target[size - 1 - i] = source[i];
  }
  return value_swapped;
}

template <typename T> static void byteswap_tensor_data(ggml_tensor* tensor) {
  T* datum = reinterpret_cast<T*>(tensor->data);
  for (int i = 0; i < ggml_nelements(tensor); i++) {
    datum[i] = byteswap(datum[i]);
  }
}

static void byteswap_tensor(ggml_tensor* tensor) {
  switch (tensor->type) {
  case GGML_TYPE_I16: {
    byteswap_tensor_data<int16_t>(tensor);
    break;
  }
  case GGML_TYPE_F16: {
    byteswap_tensor_data<ggml_fp16_t>(tensor);
    break;
  }
  case GGML_TYPE_I32: {
    byteswap_tensor_data<int32_t>(tensor);
    break;
  }
  case GGML_TYPE_F32: {
    byteswap_tensor_data<float>(tensor);
    break;
  }
  default: { // GML_TYPE_I8
    break;
  }
  }
}

#define BYTESWAP_VALUE(d) d = byteswap(d)
#define BYTESWAP_FILTERS(f)                                                    \
  do {                                                                         \
    for (auto& datum : f.data) {                                               \
      datum = byteswap(datum);                                                 \
    }                                                                          \
  } while (0)
#define BYTESWAP_TENSOR(t)                                                     \
  do {                                                                         \
    byteswap_tensor(t);                                                        \
  } while (0)
#else
#define BYTESWAP_VALUE(d)                                                      \
  do {                                                                         \
  } while (0)
#define BYTESWAP_FILTERS(f)                                                    \
  do {                                                                         \
  } while (0)
#define BYTESWAP_TENSOR(t)                                                     \
  do {                                                                         \
  } while (0)
#endif

template <typename T> static void read_safe(nmt_model_loader* loader, T& dest) {
  loader->read(loader->context, &dest, sizeof(T));
  BYTESWAP_VALUE(dest);
}

using buft_list_t =
    std::vector<std::pair<ggml_backend_dev_t, ggml_backend_buffer_type_t>>;

static buft_list_t make_buft_list(nmt_context_params& params) {
  // Prio order: GPU -> CPU Extra -> CPU
  buft_list_t buft_list;

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "=== make_buft_list called ===");
  std::ostringstream oss1;
  oss1 << "use_gpu=" << params.use_gpu << ", gpu_device=" << params.gpu_device;
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss1.str());
  std::ostringstream oss2;
  oss2 << "Total backends available: " << ggml_backend_dev_count();
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss2.str());

  // GPU
  if (params.use_gpu) {
    int cnt = 0;
    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
      ggml_backend_dev_t dev = ggml_backend_dev_get(i);
      enum ggml_backend_dev_type dev_type = ggml_backend_dev_type(dev);
      const char* name = ggml_backend_dev_name(dev);
      std::ostringstream oss3;
      oss3 << "  Backend[" << i << "]: type=" << dev_type << ", name=" << name;
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, oss3.str());

      if (dev_type == GGML_BACKEND_DEVICE_TYPE_GPU) {
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
            "  -> This is a GPU backend!");

        if (cnt == 0 || cnt == params.gpu_device) {
          auto* buft = ggml_backend_dev_buffer_type(dev);
          if (buft) {
            buft_list.emplace_back(dev, buft);
            QLOG(
                qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
                "  -> Added to buft_list");
          }
        }

        if (++cnt > params.gpu_device) {
          break;
        }
      }
    }
  }

  std::ostringstream oss_selected;
  oss_selected << "make_buft_list: Selected " << buft_list.size()
               << " GPU buffer types";
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      oss_selected.str());

  // CPU Extra
  auto* cpu_dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  auto* cpu_reg = ggml_backend_dev_backend_reg(cpu_dev);
  auto get_extra_bufts_fn =
      (ggml_backend_dev_get_extra_bufts_t)ggml_backend_reg_get_proc_address(
          cpu_reg, "ggml_backend_dev_get_extra_bufts");
  if (get_extra_bufts_fn) {
    ggml_backend_buffer_type_t* extra_bufts = get_extra_bufts_fn(cpu_dev);
    while (extra_bufts && *extra_bufts) {
      buft_list.emplace_back(cpu_dev, *extra_bufts);
      ++extra_bufts;
    }
  }

  // CPU
  buft_list.emplace_back(cpu_dev, ggml_backend_cpu_buffer_type());

  return buft_list;
}
static bool weight_buft_supported(
    const nmt_hparams& hparams, ggml_tensor* w, ggml_op op,
    ggml_backend_buffer_type_t buft, ggml_backend_dev_t dev) {
  bool op_supported = true;

  if (ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_GPU ||
      (ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_CPU &&
       buft == ggml_backend_cpu_buffer_type())) {
    // GPU and default CPU backend support all operators
    op_supported = true;
  } else {
    switch (op) {
    // The current extra_buffer_type implementations only support
    // GGML_OP_MUL_MAT
    case GGML_OP_MUL_MAT: {
      ggml_init_params params = {
          /*.mem_size   =*/2 * ggml_tensor_overhead(),
          /*.mem_buffer =*/nullptr,
          /*.no_alloc   =*/true,
      };

      ggml_context_ptr ctx_ptr{ggml_init(params)};
      if (!ctx_ptr) {
        throw std::runtime_error("failed to create ggml context");
      }
      ggml_context* ctx = ctx_ptr.get();

      ggml_tensor* op_tensor = nullptr;

      int64_t n_ctx = hparams.n_encoder_ctx;
      ggml_tensor* b = ggml_new_tensor_4d(
          ctx, GGML_TYPE_F32, w->ne[0], n_ctx, w->ne[2], w->ne[3]);
      op_tensor = ggml_mul_mat(ctx, w, b);

      // create a temporary dummy buffer for the weight so that supports_op can
      // check the buffer type
      GGML_ASSERT(w->buffer == nullptr);
      w->buffer = ggml_backend_buft_alloc_buffer(buft, 0);
      op_supported = ggml_backend_dev_supports_op(dev, op_tensor);
      ggml_backend_buffer_free(w->buffer);
      w->buffer = nullptr;
      break;
    }
    default: {
      op_supported = false;
      break;
    }
    };
  }

  return op_supported;
}

static ggml_backend_buffer_type_t select_weight_buft(
    const nmt_hparams& hparams, ggml_tensor* w, ggml_op op,
    buft_list_t buft_list) {
  GGML_ASSERT(!buft_list.empty());
  for (const auto& p : buft_list) {
    ggml_backend_dev_t dev = p.first;
    ggml_backend_buffer_type_t buft = p.second;
    if (weight_buft_supported(hparams, w, op, buft, dev)) {
      return buft;
    }
  }

  return nullptr;
}

static bool load_sentencepiece_model(
    nmt_model_loader* loader,
    std::unique_ptr<sentencepiece::SentencePieceProcessor>& processor) {

  int32_t sp_model_size = 0;
  read_safe(loader, sp_model_size);

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "SentencePiece model size: " + std::to_string(sp_model_size));

  if (sp_model_size > 0) {
    std::vector<char> sp_model_data(sp_model_size);
    loader->read(loader->context, sp_model_data.data(), sp_model_size);
    std::string serialized_model(sp_model_data.data(), sp_model_size);

    auto status = processor->LoadFromSerializedProto(serialized_model);
    if (status.ok()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "SentencePiece model loaded successfully");
      return true;
    } else {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "SentencePiece model load failed: " + status.ToString());
      return false;
    }
  }
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "SentencePiece model size is 0 or negative, skipping");
  return false;
}

static bool nmt_model_load(struct nmt_model_loader* loader, nmt_context& ctx) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "=== nmt_model_load() starting ===");

  const int64_t t_start_us = get_time_us();

  ctx.t_start_us = t_start_us;

  auto& model = ctx.model;
  auto& vocab = ctx.vocab;

  // verify magic
  {
    uint32_t magic;
    read_safe(loader, magic);
    if (magic != GGML_FILE_MAGIC) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "ERROR: Invalid file magic number");
      return false;
    }
  }

  // load hparams
  {
    auto& hparams = model.hparams;

    read_safe(loader, hparams.n_vocab);
    read_safe(loader, hparams.n_encoder_ctx);
    read_safe(loader, hparams.d_model);
    read_safe(loader, hparams.n_encoder_heads);
    read_safe(loader, hparams.n_encoder_layers);
    read_safe(loader, hparams.n_decoder_ctx);
    read_safe(loader, hparams.n_text_state);
    read_safe(loader, hparams.n_decoder_heads);
    read_safe(loader, hparams.n_decoder_layers);

    int32_t model_type;
    read_safe(loader, model_type);
    if (model_type == 1) {
      model.type = e_model::MODEL_INDICTRANS;
    } else if (model_type == 0 || model_type == 2) {
      throw std::runtime_error(
          "Opus/Marian models (model_type=" + std::to_string(model_type) +
          ") are no longer supported. Only IndicTrans (model_type=1) is "
          "supported.");
    } else {
      throw std::runtime_error(
          "Unsupported model type: " + std::to_string(model_type));
    }
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        std::string("Detected model type: ") + nmt_model_type_readable(&ctx));

    read_safe(loader, hparams.ftype);
    const int32_t qntvr = hparams.ftype / GGML_QNT_VERSION_FACTOR;
    hparams.ftype %= GGML_QNT_VERSION_FACTOR;

    if (model.type == e_model::MODEL_INDICTRANS) {
      read_safe(loader, hparams.n_tgt_vocab);
      read_safe(loader, hparams.encoder_normalize_before);
      read_safe(loader, hparams.decoder_normalize_before);
      read_safe(loader, hparams.layernorm_embedding);
      read_safe(loader, hparams.scale_embedding);
      read_safe(loader, hparams.has_lm_head);
      read_safe(loader, hparams.encoder_ffn_dim);
      read_safe(loader, hparams.decoder_ffn_dim);
    }

    // for the big tensors, we have the option to store the data in 16-bit
    // floats or quantized in order to save memory and also to speed up the
    // computation
    ctx.wtype = ggml_ftype_to_ggml_type((ggml_ftype)(model.hparams.ftype));
    if (ctx.wtype == GGML_TYPE_COUNT) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "ERROR: Invalid weight type");
      return false;
    }
  }

  // load vocab
  {
    int32_t n_vocab = 0;
    read_safe(loader, n_vocab);

    std::string word;
    std::vector<char> tmp;

    tmp.reserve(128);

    for (int i = 0; i < n_vocab; i++) {
      uint32_t len;
      read_safe(loader, len);

      if (len > 0) {
        tmp.resize(len);
        loader->read(loader->context, &tmp[0], tmp.size()); // read to buffer
        word.assign(&tmp[0], tmp.size());
      } else {
        // seems like we have an empty-string token in multi-language models (i
        // = 50256)
        word = "";
      }

      vocab.src_token_to_id[word] = i;
      vocab.src_id_to_token[i] = word;
    }

    vocab.bos_token_id = find_bos_token(vocab);

    vocab.bad_word_ids.clear();

    vocab.src_processor =
        std::make_unique<sentencepiece::SentencePieceProcessor>();
    bool src_loaded = load_sentencepiece_model(loader, vocab.src_processor);
    vocab.src_processor->SetEncodeExtraOptions("eos");

    vocab.tgt_processor =
        std::make_unique<sentencepiece::SentencePieceProcessor>();
    bool tgt_loaded = load_sentencepiece_model(loader, vocab.tgt_processor);

    vocab.has_sentencepiece_processors = src_loaded && tgt_loaded;

    if (model.type == e_model::MODEL_INDICTRANS) {
      int32_t tgt_encoder_size;
      read_safe(loader, tgt_encoder_size);

      vocab.tgt_id_to_token.clear();
      vocab.tgt_token_to_id.clear();

      for (int i = 0; i < tgt_encoder_size; i++) {
        int32_t token_id;
        read_safe(loader, token_id);

        uint32_t token_len;
        read_safe(loader, token_len);

        std::string token;
        if (token_len > 0) {
          std::vector<char> tmp(token_len);
          loader->read(loader->context, &tmp[0], tmp.size());
          token.assign(&tmp[0], tmp.size());
        }

        vocab.tgt_id_to_token[token_id] = token;
        vocab.tgt_token_to_id[token] = token_id;
      }
    }
  }

  const ggml_type wtype = ctx.wtype;
  const ggml_type vtype =
      ctx.wtype == GGML_TYPE_F32 ? GGML_TYPE_F32 : GGML_TYPE_F16; // conv type

  const auto& hparams = model.hparams;

  const size_t n_tensors_input = 24;
  const size_t n_tensors_encoder = hparams.n_encoder_layers * 18;
  const size_t n_tensors_decoder = hparams.n_decoder_layers * 28;
  const size_t n_tensors =
      n_tensors_input + n_tensors_encoder + n_tensors_decoder;

  std::map<ggml_backend_buffer_type_t, ggml_context*> ctx_map;
  auto get_ctx = [&](ggml_backend_buffer_type_t buft) -> ggml_context* {
    auto it = ctx_map.find(buft);
    if (it == ctx_map.end()) {
      ggml_init_params params = {
          /*.mem_size   =*/n_tensors * ggml_tensor_overhead(),
          /*.mem_buffer =*/nullptr,
          /*.no_alloc   =*/true,
      };

      ggml_context* ctx = ggml_init(params);
      if (ctx == nullptr) {
        throw std::runtime_error("failed to create ggml context");
      }

      ctx_map[buft] = ctx;
      model.ctxs.emplace_back(ctx);

      return ctx;
    }

    return it->second;
  };

  // Create a list of available bufts, in priority order
  buft_list_t buft_list = make_buft_list(ctx.params);

  // prepare tensors for the weights
  {
    ggml_init_params params = {
        /*.mem_size   =*/n_tensors * ggml_tensor_overhead(),
        /*.mem_buffer =*/nullptr,
        /*.no_alloc   =*/true,
    };

    ggml_context* ctx = ggml_init(params);

    const auto& hparams = model.hparams;

    const int n_vocab = hparams.n_vocab;

    const int n_encoder_ctx = hparams.n_encoder_ctx;
    const int d_model = hparams.d_model;
    const int n_encoder_layers = hparams.n_encoder_layers;

    const int n_decoder_ctx = hparams.n_decoder_ctx;
    const int n_text_state = hparams.n_text_state;
    const int n_decoder_layers = hparams.n_decoder_layers;

    const int n_mels = hparams.n_mels;

    model.layers_encoder.resize(n_encoder_layers);
    model.layers_decoder.resize(n_decoder_layers);

    // Create encoder layers - use standard ASR tensor system for compatibility
    for (int i = 0; i < n_encoder_layers; ++i) {
      auto& layer = model.layers_encoder[i];

      ggml_context* nmt_ctx = get_ctx(select_weight_buft(
          hparams,
          ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d_model),
          GGML_OP_NONE,
          buft_list));

      layer.attn_ln_0_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d_model));
      layer.attn_ln_0_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d_model));
      layer.attn_q_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, d_model, d_model));
      layer.attn_q_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d_model));
      layer.attn_k_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, d_model, d_model));
      layer.attn_k_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d_model));
      layer.attn_v_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, d_model, d_model));
      layer.attn_v_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d_model));
      layer.attn_ln_1_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, d_model, d_model));
      layer.attn_ln_1_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d_model));
      layer.mlp_ln_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d_model));
      layer.mlp_ln_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d_model));
      layer.mlp_0_w = ggml_dup_tensor(
          nmt_ctx,
          ggml_new_tensor_2d(
              ctx, wtype, n_text_state, hparams.decoder_ffn_dim));
      layer.mlp_0_b = ggml_dup_tensor(
          nmt_ctx,
          ggml_new_tensor_1d(ctx, GGML_TYPE_F32, hparams.decoder_ffn_dim));
      layer.mlp_1_w = ggml_dup_tensor(
          nmt_ctx,
          ggml_new_tensor_2d(
              ctx, wtype, hparams.decoder_ffn_dim, n_text_state));
      layer.mlp_1_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, d_model));

      // Map encoder tensors to match conversion script output
      model
          .tensors[format("encoder.layers.%d.self_attn_layer_norm.weight", i)] =
          layer.attn_ln_0_w;
      model.tensors[format("encoder.layers.%d.self_attn_layer_norm.bias", i)] =
          layer.attn_ln_0_b;
      model.tensors[format("encoder.layers.%d.self_attn.q_proj.weight", i)] =
          layer.attn_q_w;
      model.tensors[format("encoder.layers.%d.self_attn.q_proj.bias", i)] =
          layer.attn_q_b;
      model.tensors[format("encoder.layers.%d.self_attn.k_proj.weight", i)] =
          layer.attn_k_w;
      model.tensors[format("encoder.layers.%d.self_attn.k_proj.bias", i)] =
          layer.attn_k_b;
      model.tensors[format("encoder.layers.%d.self_attn.v_proj.weight", i)] =
          layer.attn_v_w;
      model.tensors[format("encoder.layers.%d.self_attn.v_proj.bias", i)] =
          layer.attn_v_b;
      model.tensors[format("encoder.layers.%d.self_attn.out_proj.weight", i)] =
          layer.attn_ln_1_w;
      model.tensors[format("encoder.layers.%d.self_attn.out_proj.bias", i)] =
          layer.attn_ln_1_b;
      model.tensors[format("encoder.layers.%d.final_layer_norm.weight", i)] =
          layer.mlp_ln_w;
      model.tensors[format("encoder.layers.%d.final_layer_norm.bias", i)] =
          layer.mlp_ln_b;
      model.tensors[format("encoder.layers.%d.fc1.weight", i)] = layer.mlp_0_w;
      model.tensors[format("encoder.layers.%d.fc1.bias", i)] = layer.mlp_0_b;
      model.tensors[format("encoder.layers.%d.fc2.weight", i)] = layer.mlp_1_w;
      model.tensors[format("encoder.layers.%d.fc2.bias", i)] = layer.mlp_1_b;
    }

    for (int i = 0; i < n_decoder_layers; ++i) {
      auto& layer = model.layers_decoder[i];

      ggml_context* nmt_ctx = get_ctx(select_weight_buft(
          hparams,
          ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state),
          GGML_OP_NONE,
          buft_list));

      // Self-attention tensors
      layer.attn_ln_0_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.attn_ln_0_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.attn_q_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, n_text_state, n_text_state));
      layer.attn_q_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.attn_k_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, n_text_state, n_text_state));
      layer.attn_k_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.attn_v_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, n_text_state, n_text_state));
      layer.attn_v_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.attn_ln_1_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, n_text_state, n_text_state));
      layer.attn_ln_1_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));

      // Cross-attention tensors
      layer.cross_attn_ln_0_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.cross_attn_ln_0_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.cross_attn_q_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, n_text_state, n_text_state));
      layer.cross_attn_q_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.cross_attn_k_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, n_text_state, n_text_state));
      layer.cross_attn_k_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.cross_attn_v_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, n_text_state, n_text_state));
      layer.cross_attn_v_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.cross_attn_ln_1_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_2d(ctx, wtype, n_text_state, n_text_state));
      layer.cross_attn_ln_1_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));

      // MLP tensors
      layer.mlp_ln_w = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.mlp_ln_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));
      layer.mlp_0_w = ggml_dup_tensor(
          nmt_ctx,
          ggml_new_tensor_2d(
              ctx, wtype, n_text_state, hparams.decoder_ffn_dim));
      layer.mlp_0_b = ggml_dup_tensor(
          nmt_ctx,
          ggml_new_tensor_1d(ctx, GGML_TYPE_F32, hparams.decoder_ffn_dim));
      layer.mlp_1_w = ggml_dup_tensor(
          nmt_ctx,
          ggml_new_tensor_2d(
              ctx, wtype, hparams.decoder_ffn_dim, n_text_state));
      layer.mlp_1_b = ggml_dup_tensor(
          nmt_ctx, ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state));

      // Map decoder tensors to match conversion script output
      // Self-attention
      model.tensors[format("decoder.blocks.%d.attn_ln.weight", i)] =
          layer.attn_ln_0_w;
      model.tensors[format("decoder.blocks.%d.attn_ln.bias", i)] =
          layer.attn_ln_0_b;
      model.tensors[format("decoder.blocks.%d.attn.query.weight", i)] =
          layer.attn_q_w;
      model.tensors[format("decoder.blocks.%d.attn.query.bias", i)] =
          layer.attn_q_b;
      model.tensors[format("decoder.blocks.%d.attn.key.weight", i)] =
          layer.attn_k_w;
      model.tensors[format("decoder.blocks.%d.attn.key.bias", i)] =
          layer.attn_k_b;
      model.tensors[format("decoder.blocks.%d.attn.value.weight", i)] =
          layer.attn_v_w;
      model.tensors[format("decoder.blocks.%d.attn.value.bias", i)] =
          layer.attn_v_b;
      model.tensors[format("decoder.blocks.%d.attn.out.weight", i)] =
          layer.attn_ln_1_w;
      model.tensors[format("decoder.blocks.%d.attn.out.bias", i)] =
          layer.attn_ln_1_b;

      // Cross-attention
      model.tensors[format("decoder.blocks.%d.cross_attn_ln.weight", i)] =
          layer.cross_attn_ln_0_w;
      model.tensors[format("decoder.blocks.%d.cross_attn_ln.bias", i)] =
          layer.cross_attn_ln_0_b;
      model.tensors[format("decoder.blocks.%d.cross_attn.query.weight", i)] =
          layer.cross_attn_q_w;
      model.tensors[format("decoder.blocks.%d.cross_attn.query.bias", i)] =
          layer.cross_attn_q_b;
      model.tensors[format("decoder.blocks.%d.cross_attn.key.weight", i)] =
          layer.cross_attn_k_w;
      model.tensors[format("decoder.blocks.%d.cross_attn.key.bias", i)] =
          layer.cross_attn_k_b;
      model.tensors[format("decoder.blocks.%d.cross_attn.value.weight", i)] =
          layer.cross_attn_v_w;
      model.tensors[format("decoder.blocks.%d.cross_attn.value.bias", i)] =
          layer.cross_attn_v_b;
      model.tensors[format("decoder.blocks.%d.cross_attn.out.weight", i)] =
          layer.cross_attn_ln_1_w;
      model.tensors[format("decoder.blocks.%d.cross_attn.out.bias", i)] =
          layer.cross_attn_ln_1_b;

      // MLP
      model.tensors[format("decoder.blocks.%d.mlp_ln.weight", i)] =
          layer.mlp_ln_w;
      model.tensors[format("decoder.blocks.%d.mlp_ln.bias", i)] =
          layer.mlp_ln_b;
      model.tensors[format("decoder.blocks.%d.mlp.0.weight", i)] =
          layer.mlp_0_w;
      model.tensors[format("decoder.blocks.%d.mlp.0.bias", i)] = layer.mlp_0_b;
      model.tensors[format("decoder.blocks.%d.mlp.2.weight", i)] =
          layer.mlp_1_w;
      model.tensors[format("decoder.blocks.%d.mlp.2.bias", i)] = layer.mlp_1_b;
    }

    int32_t encoder_vocab_size = n_vocab;
    int32_t decoder_vocab_size =
        hparams.n_tgt_vocab > 0 ? hparams.n_tgt_vocab : n_vocab;

    ggml_tensor* meta_encoder_emb =
        ggml_new_tensor_2d(ctx, wtype, n_text_state, encoder_vocab_size);
    ggml_tensor* meta_decoder_emb =
        ggml_new_tensor_2d(ctx, wtype, n_text_state, decoder_vocab_size);

    ggml_tensor* meta_enc_pos_emb = nullptr;
    ggml_tensor* meta_dec_pos_emb = nullptr;
    {
      const int max_pos = 1024; // IndicTrans2 typical max length
      meta_enc_pos_emb = ggml_new_tensor_2d(
          ctx, GGML_TYPE_F32, n_text_state, max_pos); // Shape: (512, 1024)
      meta_dec_pos_emb = ggml_new_tensor_2d(
          ctx, GGML_TYPE_F32, n_text_state, max_pos); // Shape: (512, 1024)
    }

    ggml_tensor* meta_enc_norm_w =
        ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state);
    ggml_tensor* meta_enc_norm_b =
        ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state);
    ggml_tensor* meta_dec_norm_w =
        ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state);
    ggml_tensor* meta_dec_norm_b =
        ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state);
    ggml_tensor* meta_lm_head =
        ggml_new_tensor_2d(ctx, wtype, n_text_state, decoder_vocab_size);
    ggml_tensor* meta_enc_layer_norm_w = nullptr;
    ggml_tensor* meta_enc_layer_norm_b = nullptr;
    ggml_tensor* meta_dec_layer_norm_w = nullptr;
    ggml_tensor* meta_dec_layer_norm_b = nullptr;
    if (model.type == MODEL_INDICTRANS) {
      meta_enc_layer_norm_w =
          ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state);
      meta_enc_layer_norm_b =
          ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state);
      meta_dec_layer_norm_w =
          ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state);
      meta_dec_layer_norm_b =
          ggml_new_tensor_1d(ctx, GGML_TYPE_F32, n_text_state);
    }

    // Allocate tensors using backend system
    ggml_backend_buffer_type_t buft =
        select_weight_buft(hparams, meta_encoder_emb, GGML_OP_NONE, buft_list);
    ggml_context* nmt_ctx = get_ctx(buft);

    model.m_encoder_embeddings = ggml_dup_tensor(nmt_ctx, meta_encoder_emb);
    model.m_decoder_embeddings = ggml_dup_tensor(nmt_ctx, meta_decoder_emb);

    model.m_encoder_pos_emb = ggml_dup_tensor(nmt_ctx, meta_enc_pos_emb);
    model.m_decoder_pos_emb = ggml_dup_tensor(nmt_ctx, meta_dec_pos_emb);

    model.m_encoder_norm_w = ggml_dup_tensor(nmt_ctx, meta_enc_norm_w);
    model.m_encoder_norm_b = ggml_dup_tensor(nmt_ctx, meta_enc_norm_b);
    model.m_decoder_norm_w = ggml_dup_tensor(nmt_ctx, meta_dec_norm_w);
    model.m_decoder_norm_b = ggml_dup_tensor(nmt_ctx, meta_dec_norm_b);

    model.m_lm_head_w = ggml_dup_tensor(nmt_ctx, meta_lm_head);
    model.m_final_logits_bias = nullptr;

    if (model.type == MODEL_INDICTRANS && hparams.layernorm_embedding) {
      model.m_enc_layer_norm_w =
          ggml_dup_tensor(nmt_ctx, meta_enc_layer_norm_w);
      model.m_enc_layer_norm_b =
          ggml_dup_tensor(nmt_ctx, meta_enc_layer_norm_b);
      model.m_dec_layer_norm_w =
          ggml_dup_tensor(nmt_ctx, meta_dec_layer_norm_w);
      model.m_dec_layer_norm_b =
          ggml_dup_tensor(nmt_ctx, meta_dec_layer_norm_b);
    } else if (model.type == MODEL_INDICTRANS) {
      model.m_enc_layer_norm_w = nullptr;
      model.m_enc_layer_norm_b = nullptr;
      model.m_dec_layer_norm_w = nullptr;
      model.m_dec_layer_norm_b = nullptr;
    }

    model.tensors["encoder.embeddings.weight"] = model.m_encoder_embeddings;
    model.tensors["decoder.embeddings.weight"] = model.m_decoder_embeddings;

    if (model.type == e_model::MODEL_INDICTRANS) {
      if (hparams.layernorm_embedding) {
        model.tensors["encoder.layer_norm.weight"] = model.m_enc_layer_norm_w;
        model.tensors["encoder.layer_norm.bias"] = model.m_enc_layer_norm_b;
        model.tensors["decoder.layer_norm.weight"] = model.m_dec_layer_norm_w;
        model.tensors["decoder.layer_norm.bias"] = model.m_dec_layer_norm_b;
      }

      model.tensors["encoder.final_layer_norm.weight"] = model.m_encoder_norm_w;
      model.tensors["encoder.final_layer_norm.bias"] = model.m_encoder_norm_b;
      model.tensors["decoder.final_layer_norm.weight"] = model.m_decoder_norm_w;
      model.tensors["decoder.final_layer_norm.bias"] = model.m_decoder_norm_b;
    }

    model.tensors["lm_head.weight"] = model.m_lm_head_w;

    ggml_free(ctx);
  }

  // allocate tensors in the backend buffers
  for (auto& p : ctx_map) {
    ggml_backend_buffer_type_t buft = p.first;
    ggml_context* ctx = p.second;
    ggml_backend_buffer_t buf =
        ggml_backend_alloc_ctx_tensors_from_buft(ctx, buft);
    if (buf) {
      model.buffers.emplace_back(buf);

      size_t size_main = ggml_backend_buffer_get_size(buf);
    }
  }

  // load weights
  {
    size_t total_size = 0;
    model.n_loaded = 0;

    std::vector<char> read_buf;

    while (true) {
      int32_t n_dims;
      int32_t length;
      int32_t ttype;

      read_safe(loader, n_dims);
      read_safe(loader, length);
      read_safe(loader, ttype);

      if (loader->eof(loader->context)) {
        break;
      }

      int32_t nelements = 1;
      int32_t ne[4] = {1, 1, 1, 1};
      for (int i = 0; i < n_dims; ++i) {
        read_safe(loader, ne[i]);
        nelements *= ne[i];
      }

      std::string name;
      std::vector<char> tmp(length);                      // create a buffer
      loader->read(loader->context, &tmp[0], tmp.size()); // read to buffer
      name.assign(&tmp[0], tmp.size());

      if (model.tensors.find(name) == model.tensors.end()) {
        return false;
      }

      auto tensor = model.tensors[name.data()];

      if (ggml_nelements(tensor) != nelements) {
        // __func__, ne[0], ne[1], ne[2], (int) tensor->ne[0], (int)
        // tensor->ne[1], (int) tensor->ne[2]);
        return false;
      }

      if (tensor->ne[0] != ne[0] || tensor->ne[1] != ne[1] ||
          tensor->ne[2] != ne[2]) {
        // __func__, name.data(), (int) tensor->ne[0], (int) tensor->ne[1],
        // (int) tensor->ne[2], ne[0], ne[1], ne[2]);
        return false;
      }

      const size_t bpe = ggml_type_size(ggml_type(ttype));

      if ((nelements * bpe) / ggml_blck_size(tensor->type) !=
          ggml_nbytes(tensor)) {
        //__func__, name.data(), ggml_nbytes(tensor), nelements*bpe);
        return false;
      }

      if (ggml_backend_buffer_is_host(tensor->buffer)) {
        // for the CPU and Metal backend, we can read directly into the tensor
        loader->read(loader->context, tensor->data, ggml_nbytes(tensor));
        BYTESWAP_TENSOR(tensor);
      } else {
        // read into a temporary buffer first, then copy to device memory
        read_buf.resize(ggml_nbytes(tensor));

        loader->read(loader->context, read_buf.data(), read_buf.size());

        ggml_backend_tensor_set(
            tensor, read_buf.data(), 0, ggml_nbytes(tensor));
      }

      total_size += ggml_nbytes(tensor);
      model.n_loaded++;
    }

    if (model.n_loaded == 0) {
    } else {
      size_t expected = model.tensors.size();
      if (model.type == MODEL_INDICTRANS && !hparams.has_lm_head) {
        expected -= 1;
      }
      if ((size_t)model.n_loaded != expected) {
        return false;
      }
    }
  }

  if (model.type == MODEL_INDICTRANS) {
    if (model.m_encoder_pos_emb && model.m_decoder_pos_emb) {
      const int d_model = hparams.n_text_state;           // 512
      const int max_pos = model.m_encoder_pos_emb->ne[1]; // 1024

      std::vector<float> pos_emb_data(d_model * max_pos);
      indictrans_compute_sinusoidal_positional_embeddings_to_buffer(
          pos_emb_data.data(), d_model, max_pos);
      size_t bytes_to_copy = pos_emb_data.size() * sizeof(float);

      ggml_backend_tensor_set(
          model.m_encoder_pos_emb, pos_emb_data.data(), 0, bytes_to_copy);
      ggml_backend_tensor_set(
          model.m_decoder_pos_emb, pos_emb_data.data(), 0, bytes_to_copy);
    }
  }

  for (auto& buf : model.buffers) {
    ggml_backend_buffer_set_usage(buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
  }

  ctx.t_load_us = ggml_time_us() - t_start_us;

  return true;
}

struct nmt_context* nmt_init_with_params_no_state(
    struct nmt_model_loader* loader, struct nmt_context_params params) {
  nmt_context* ctx = new nmt_context;
  ctx->params = params;

  if (!nmt_model_load(loader, *ctx)) {
    loader->close(loader->context);
    delete ctx;
    return nullptr;
  }

  loader->close(loader->context);

  return ctx;
}

struct nmt_context* nmt_init_from_file_with_params_no_state(
    const char* path_model, struct nmt_context_params params) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      std::string("=== nmt_init_from_file_with_params_no_state: path=") +
          path_model);
#ifdef _MSC_VER
  // Convert UTF-8 path to wide string (UTF-16) for Windows, resolving character
  // encoding issues.
  std::wstring_convert<std::codecvt_utf8<wchar_t>> converter;
  std::wstring path_model_wide = converter.from_bytes(path_model);
  auto fin = std::ifstream(path_model_wide, std::ios::binary);
#else
  auto fin = std::ifstream(path_model, std::ios::binary);
#endif
  if (!fin) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        std::string("ERROR: Failed to open file: ") + path_model);
    return nullptr;
  }
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "File opened successfully");

  nmt_model_loader loader = {};

  loader.context = &fin;

  loader.read = [](void* ctx, void* output, size_t read_size) {
    std::ifstream* fin = (std::ifstream*)ctx;
    fin->read((char*)output, read_size);
    return read_size;
  };

  loader.eof = [](void* ctx) {
    std::ifstream* fin = (std::ifstream*)ctx;
    return fin->eof();
  };

  loader.close = [](void* ctx) {
    std::ifstream* fin = (std::ifstream*)ctx;
    fin->close();
  };

  auto ctx = nmt_init_with_params_no_state(&loader, params);

  if (ctx) {
    ctx->path_model = path_model;
  }

  return ctx;
}

struct nmt_context* nmt_init_from_file_with_params(
    const char* path_model, struct nmt_context_params params) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "=== nmt_init_from_file_with_params called ===\n");
  nmt_context* ctx =
      nmt_init_from_file_with_params_no_state(path_model, params);
  if (ctx == nullptr) {
    return nullptr;
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "About to call nmt_init_state");
  ctx->state = nmt_init_state(ctx);
  if (!ctx->state) {
    nmt_free(ctx);
    return nullptr;
  }
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "nmt_init_state returned successfully");

  return ctx;
}
// NOLINTEND
