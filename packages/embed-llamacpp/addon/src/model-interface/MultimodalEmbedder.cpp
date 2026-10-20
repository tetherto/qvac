#include "MultimodalEmbedder.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>
#include <llama/mtmd/mtmd-helper.h>

#include "addon/BertErrors.hpp"
#include "logging.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;

namespace {

void throwIfCancelled(const std::atomic<bool>& cancelled) {
  if (cancelled.load()) {
    throw std::runtime_error("Job cancelled");
  }
}

mtmd::bitmap decodeMedia(
    const mtmd_context* mctx, const MultimodalPart& part, std::size_t index) {
  mtmd_helper_bitmap_wrapper wrapper = mtmd_helper_bitmap_init_from_buf(
      mctx,
      part.media.data(),
      part.media.size(),
      /* placeholder = */ false,
      mtmd_helper_init_opt_default());
  if (wrapper.video_ctx != nullptr) {
    mtmd_helper_video_free(wrapper.video_ctx);
    mtmd_bitmap_free(wrapper.bitmap);
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedMedia),
        string_format("media part %zu: video input is not supported", index));
  }
  if (wrapper.bitmap == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedMedia),
        string_format(
            "media part %zu: cannot decode it, expected an image (jpg, png, "
            "bmp, gif, ...) or wav/mp3/flac audio",
            index));
  }
  mtmd::bitmap bitmap(wrapper.bitmap);

  const bool isAudio = mtmd_bitmap_is_audio(bitmap.ptr.get());
  if (isAudio && !mtmd_support_audio(mctx)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedMedia),
        string_format(
            "media part %zu: the projection model has no audio encoder",
            index));
  }
  if (!isAudio && !mtmd_support_vision(mctx)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedMedia),
        string_format(
            "media part %zu: the projection model has no vision encoder",
            index));
  }
  return bitmap;
}

/// Splits @p input into mtmd chunks in @p output: text chunks carry tokens,
/// media chunks are encoded later. BOS and EOS are added as for a text-only
/// input.
void tokenize(
    const mtmd_context* mctx, const MultimodalInput& input,
    mtmd_input_chunks* output) {
  std::vector<mtmd::bitmap> bitmaps;
  std::vector<mtmd_input_text> texts;
  bitmaps.reserve(input.size());
  texts.reserve(input.size());

  std::vector<mtmd_input_part> parts;
  parts.reserve(input.size());
  std::size_t mediaIndex = 0;
  for (const MultimodalPart& part : input) {
    if (part.isMedia) {
      bitmaps.push_back(decodeMedia(mctx, part, mediaIndex++));
      parts.push_back({.text = nullptr, .bitmap = bitmaps.back().ptr.get()});
    } else if (!part.text.empty()) {
      texts.push_back(
          {.text = part.text.c_str(),
           .text_len = part.text.size(),
           .add_special = false,
           .parse_special = true});
      parts.push_back({.text = &texts.back(), .bitmap = nullptr});
    }
  }

  std::vector<const mtmd_input_part*> partPtrs;
  partPtrs.reserve(parts.size());
  for (const mtmd_input_part& part : parts) {
    partPtrs.push_back(&part);
  }

  const int32_t res = mtmd_tokenize_from_parts(
      mctx,
      output,
      partPtrs.data(),
      partPtrs.size(),
      /* add_special = */ true);
  if (res != 0) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(MediaEncodeFailed),
        string_format("mtmd_tokenize_from_parts failed (%d)", res));
  }
}

} // namespace

MultimodalEmbedder::MultimodalEmbedder(
    const std::string& projectionPath, llama_model* model, llama_context* ctx,
    const common_params& params, bool useGpu)
    : model_(model), ctx_(ctx) {
  mtmd_helper_log_set(
      qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback, nullptr);

  mtmd_context_params mparams = mtmd_context_params_default();
  mparams.use_gpu = useGpu;
  // Co-locate the projector with the text model, on its first device.
  if (useGpu && !params.devices.empty()) {
    mparams.device = params.devices.front();
  }
  mparams.print_timings = false;
  mparams.n_threads = params.cpuparams.n_threads;
  mparams.flash_attn_type = params.flash_attn_type;
  mparams.warmup = params.warmup;

  mctx_.reset(mtmd_init_from_file(projectionPath.c_str(), model_, mparams));
  if (!mctx_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadProjectionModel),
        string_format(
            "failed to load the projection model '%s'",
            projectionPath.c_str()));
  }
  batch_.reset(llama_batch_ext_init(ctx_));
}

void MultimodalEmbedder::embed(
    const MultimodalInput& input, std::span<float> out, int embdNormalize,
    const std::atomic<bool>& cancelled) {
  mtmd::input_chunks chunks(mtmd_input_chunks_init());
  tokenize(mctx_.get(), input, chunks.ptr.get());

  // A memory-less model sees the whole input in one ubatch: the text tokens
  // and the media embeddings must fit together.
  const std::size_t nTokens = mtmd_helper_get_n_tokens(chunks.ptr.get());
  const auto nUbatch = static_cast<std::size_t>(llama_n_ubatch(ctx_));
  if (nTokens > nUbatch) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InputTokensExceedBatchSize),
        string_format(
            "multimodal input has %zu tokens, more than the batch size (%zu); "
            "increase batch_size",
            nTokens,
            nUbatch));
  }
  const auto effectiveContextSize = static_cast<std::size_t>(std::min(
      llama_model_n_ctx_train(model_), static_cast<int>(llama_n_ctx(ctx_))));
  if (nTokens > effectiveContextSize) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(ContextOverflow),
        string_format(
            "multimodal input has %zu tokens, more than the effective context "
            "size (%zu)",
            nTokens,
            effectiveContextSize));
  }

  // Encode every media chunk first: the decode below needs them all at once.
  // mtmd_get_output_embd() is overwritten by the next encode and
  // llama_batch_ext keeps pointers into the rows, so each chunk keeps its own
  // copy until the decode is done.
  const auto nEmbdInp =
      static_cast<std::size_t>(llama_model_n_embd_inp(model_));
  std::vector<std::vector<float>> encoded;
  for (std::size_t i = 0; i < chunks.size(); ++i) {
    throwIfCancelled(cancelled);
    const mtmd_input_chunk* chunk = chunks[i];
    if (mtmd_input_chunk_get_type(chunk) == MTMD_INPUT_CHUNK_TYPE_TEXT) {
      continue;
    }
    if (mtmd_encode_chunk(mctx_.get(), chunk) != 0) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(MediaEncodeFailed),
          string_format("failed to encode media chunk %zu", i));
    }
    const float* embd = mtmd_get_output_embd(mctx_.get());
    const std::size_t n = mtmd_input_chunk_get_n_tokens(chunk) * nEmbdInp;
    encoded.emplace_back(embd, embd + n);
  }
  throwIfCancelled(cancelled);

  // One batch, in prompt order. The positions match llama-server's
  // add_mtmd_chunk(), including the M-RoPE layout of image tokens.
  constexpr llama_seq_id seqId = 0;
  llama_batch_ext* batch = batch_.get();
  llama_batch_ext_clear(batch);
  const bool isMrope = mtmd_decode_use_mrope(mctx_.get());
  llama_pos pos = 0;
  auto encodedIt = encoded.begin();

  auto addOrThrow = [](int32_t idx) {
    if (idx < 0) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(DecodeFailed),
          string_format("failed to add an entry to the batch (%d)", idx));
    }
    return idx;
  };

  for (std::size_t i = 0; i < chunks.size(); ++i) {
    const mtmd_input_chunk* chunk = chunks[i];
    if (mtmd_input_chunk_get_type(chunk) == MTMD_INPUT_CHUNK_TYPE_TEXT) {
      std::size_t nText = 0;
      const llama_token* tokens =
          mtmd_input_chunk_get_tokens_text(chunk, &nText);
      for (const llama_token token : std::span(tokens, nText)) {
        const int32_t idx =
            addOrThrow(llama_batch_ext_add_token(batch, seqId, token));
        llama_batch_ext_set_pos(batch, idx, &pos);
        llama_batch_ext_set_output_embd(batch, idx, true);
        ++pos;
      }
      continue;
    }

    const mtmd_image_tokens* image = mtmd_input_chunk_get_tokens_image(chunk);
    const std::size_t nChunkTokens = mtmd_input_chunk_get_n_tokens(chunk);
    const llama_pos pos0 = pos;
    for (std::size_t t = 0; t < nChunkTokens; ++t) {
      const llama_pos p = pos0 + static_cast<llama_pos>(t);
      llama_pos entryPos[GGML_MROPE_SECTIONS] = {p, p, p, p};
      if (isMrope && image != nullptr) {
        const mtmd_decoder_pos rel =
            mtmd_image_tokens_get_decoder_pos(image, pos0, t);
        entryPos[0] = rel.t;
        entryPos[1] = rel.y;
        entryPos[2] = rel.x;
        entryPos[3] = rel.z;
      }
      const llama_embd row{
          .data = encodedIt->data() + t * nEmbdInp,
          .n_rows = 1,
          .n_embd = nEmbdInp};
      const int32_t idx =
          addOrThrow(llama_batch_ext_add_embd(batch, seqId, row));
      llama_batch_ext_set_pos(batch, idx, entryPos);
      llama_batch_ext_set_output_embd(batch, idx, true);
    }
    pos = pos0 + mtmd_input_chunk_get_n_pos(chunk);
    ++encodedIt;
  }

  llama_memory_clear(llama_get_memory(ctx_), true);
  const int32_t ret = llama_process(ctx_, LLAMA_PROCESS_TYPE_DECODE, batch);
  throwIfCancelled(cancelled);
  if (ret != 0) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(DecodeFailed),
        string_format("llama_process failed (%d)", ret));
  }

  const float* embd = llama_get_embeddings_seq(ctx_, seqId);
  if (embd == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(FailedToGetSequenceEmbeddings),
        "Failed to get sequence embeddings");
  }
  common_embd_normalize(
      embd, out.data(), static_cast<int>(out.size()), embdNormalize);
}
