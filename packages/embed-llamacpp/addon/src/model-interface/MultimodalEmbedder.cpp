#include "MultimodalEmbedder.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <initializer_list>
#include <limits>
#include <regex>
#include <stdexcept>
#include <system_error>
#include <utility>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>
#include <llama/mtmd/mtmd-helper.h>

#include "addon/BertErrors.hpp"
#include "logging.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;
using qvac_lib_infer_llamacpp_embed::logging::llamaLogCallback;

namespace {

using ConfigMap = std::unordered_map<std::string, std::string>;

[[noreturn]] void throwInvalidOption(const std::string& message) {
  throw qvac_errors::StatusError(
      ADDON_ID, toString(InvalidConfiguration), message);
}

/// Erases and returns the value of the one of @p keys that is set (a key and
/// its underscore alias); nullopt when neither is.
std::optional<std::string>
takeOption(ConfigMap& config, std::initializer_list<const char*> keys) {
  std::optional<std::string> value;
  const char* found = nullptr;
  for (const char* key : keys) {
    auto it = config.find(key);
    if (it == config.end()) {
      continue;
    }
    if (found != nullptr) {
      throwInvalidOption(
          string_format("Set only one of %s and %s", found, key));
    }
    found = key;
    value = it->second;
    config.erase(it);
  }
  return value;
}

bool parseBool(const std::string& name, const std::string& raw) {
  std::string val = raw;
  std::transform(val.begin(), val.end(), val.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  if (val == "1" || val == "on" || val == "true") {
    return true;
  }
  if (val == "0" || val == "off" || val == "false") {
    return false;
  }
  throwInvalidOption(string_format(
      "%s must be 0/off/false or 1/on/true, got: %s",
      name.c_str(),
      raw.c_str()));
}

/// A positive integer no larger than @p max.
uint64_t
parsePositive(const std::string& name, const std::string& raw, uint64_t max) {
  uint64_t value = 0;
  const auto* end = raw.data() + raw.size();
  const auto result = std::from_chars(raw.data(), end, value);
  if (result.ec != std::errc{} || result.ptr != end || value == 0 ||
      value > max) {
    throwInvalidOption(string_format(
        "%s must be a positive integer, got: %s", name.c_str(), raw.c_str()));
  }
  return value;
}

int parseTokenCount(const std::string& name, const std::string& raw) {
  return static_cast<int>(
      parsePositive(name, raw, std::numeric_limits<int>::max()));
}

#ifdef __ANDROID__
/// The Adreno tier in a GPU description such as "Adreno (TM) 830", as
/// @qvac/llm-llamacpp's backend selection parses it.
std::optional<int> parseAdrenoVersion(const std::string& gpuDescription) {
  static const std::regex adrenoRegex(R"(dreno.*?(\d+))");
  std::smatch matches;
  if (std::regex_search(gpuDescription, matches, adrenoRegex) &&
      matches.size() > 1) {
    try {
      return std::stoi(matches[1].str());
    } catch (const std::exception&) {
      return std::nullopt;
    }
  }
  return std::nullopt;
}
#endif

/// Whether the projector runs on the GPU. It follows the text model, as
/// @qvac/llm-llamacpp's projector default does (QVAC-21867): on Android only
/// Adreno 800+ encodes faster on the GPU, so every other Android GPU keeps the
/// projector on the CPU. mmproj-use-gpu overrides it.
bool resolveProjectorGpu(
    bool modelOnGpu, std::optional<bool> useGpu,
    [[maybe_unused]] ggml_backend_dev_t device) {
  if (!modelOnGpu) {
    if (useGpu.value_or(false)) {
      llamaLogCallback(
          GGML_LOG_LEVEL_WARN,
          "[BertModel] mmproj-use-gpu ignored: the model runs on the CPU, "
          "running the multimodal projector on CPU\n",
          nullptr);
    }
    return false;
  }
  bool onGpu = true;
  const char* reason = "auto-default";
#ifdef __ANDROID__
  constexpr int kAdrenoMmprojGpuThreshold = 800;
  std::string description =
      device != nullptr ? ggml_backend_dev_description(device) : "";
  std::transform(
      description.begin(),
      description.end(),
      description.begin(),
      [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  const std::optional<int> adreno = parseAdrenoVersion(description);
  onGpu = adreno.has_value() && *adreno >= kAdrenoMmprojGpuThreshold;
  reason =
      onGpu
          ? "auto-default, Adreno 800+"
          : (description.find("mali") != std::string::npos
                 ? "auto-default, Mali GPU"
                 : (adreno.has_value() ? "auto-default, Adreno <800"
                                       : "auto-default, non-Adreno-800+ GPU"));
#endif
  if (useGpu.has_value()) {
    onGpu = *useGpu;
    reason = "mmproj-use-gpu override";
  }
  llamaLogCallback(
      GGML_LOG_LEVEL_INFO,
      string_format(
          "[BertModel] multimodal projector backend: %s (%s)\n",
          onGpu ? "GPU" : "CPU",
          reason)
          .c_str(),
      nullptr);
  return onGpu;
}

void throwIfCancelled(const std::atomic<bool>& cancelled) {
  if (cancelled.load()) {
    throw std::runtime_error("Job cancelled");
  }
}

/// The size limits a media part is checked against before it is decoded.
struct MediaLimits {
  uint64_t maxImagePixels;
  uint64_t maxAudioSeconds;
};

mtmd::bitmap decodeMedia(
    const mtmd_context* mctx, const MultimodalPart& part, std::size_t index,
    const MediaLimits& limits) {
  // Say which encoder is missing before mtmd-helper, which would only report
  // that it could not read the media.
  const bool isAudio =
      image_pixel_limit::isMtmdAudio(part.media.data(), part.media.size());
  if (isAudio && !mtmd_support_audio(mctx)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedMedia),
        string_format(
            "media part %zu: audio, but the projection model has no audio "
            "encoder loaded (mmproj-no-audio, or a vision-only projector)",
            index));
  }
  if (!isAudio && !mtmd_support_vision(mctx)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnsupportedMedia),
        string_format(
            "media part %zu: an image, but the projection model has no vision "
            "encoder",
            index));
  }
  // mtmd-helper decodes the whole input at once, sized by its headers, so
  // both are bounded first.
  if (isAudio) {
    audio_length_limit::checkBuffer(
        part.media.data(), part.media.size(), limits.maxAudioSeconds);
  } else {
    image_pixel_limit::checkBuffer(
        part.media.data(), part.media.size(), limits.maxImagePixels);
  }
  mtmd_helper_bitmap_wrapper wrapper = mtmd_helper_bitmap_init_from_buf(
      mctx,
      part.media.data(),
      part.media.size(),
      /* placeholder = */ false,
      mtmd_helper_init_opt_default());
  // A video container never gets here (the pixel check above rejects what
  // stb_image cannot read); free one anyway rather than leak it.
  if (wrapper.video_ctx != nullptr) {
    mtmd_helper_video_free(wrapper.video_ctx);
    mtmd_bitmap_free(wrapper.bitmap);
    wrapper.bitmap = nullptr;
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
  return mtmd::bitmap(wrapper.bitmap);
}

/// Splits @p input into mtmd chunks in @p output: text chunks carry tokens,
/// media chunks are encoded later. BOS and EOS are added as for a text-only
/// input.
void tokenize(
    const mtmd_context* mctx, const MultimodalInput& input,
    const MediaLimits& limits, const std::atomic<bool>& cancelled,
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
      // Decoding one part can take seconds (up to audio-max-seconds of
      // audio), so a cancel is checked before each.
      throwIfCancelled(cancelled);
      bitmaps.push_back(decodeMedia(mctx, part, mediaIndex++, limits));
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

MultimodalOptions
takeMultimodalOptions(ConfigMap& config, bool hasProjectionModel) {
  constexpr uint64_t kPixelsPerMegapixel = 1'000'000;
  const size_t keysBefore = config.size();
  MultimodalOptions options;
  if (auto raw = takeOption(config, {"image-min-tokens", "image_min_tokens"})) {
    options.imageMinTokens = parseTokenCount("image-min-tokens", *raw);
  }
  if (auto raw = takeOption(config, {"image-max-tokens", "image_max_tokens"})) {
    options.imageMaxTokens = parseTokenCount("image-max-tokens", *raw);
  }
  if (options.imageMinTokens > 0 && options.imageMaxTokens > 0 &&
      options.imageMinTokens > options.imageMaxTokens) {
    throwInvalidOption(string_format(
        "image-min-tokens (%d) must not exceed image-max-tokens (%d)",
        options.imageMinTokens,
        options.imageMaxTokens));
  }
  if (auto raw = takeOption(config, {"mmproj-no-audio", "mmproj_no_audio"})) {
    options.noAudio = parseBool("mmproj-no-audio", *raw);
  }
  if (auto raw = takeOption(config, {"mmproj-use-gpu", "mmproj_use_gpu"})) {
    options.useGpu = parseBool("mmproj-use-gpu", *raw);
  }
  if (auto raw = takeOption(
          config, {"image-max-megapixels", "image_max_megapixels"})) {
    options.maxImagePixels =
        parsePositive(
            "image-max-megapixels",
            *raw,
            std::numeric_limits<uint64_t>::max() / kPixelsPerMegapixel) *
        kPixelsPerMegapixel;
  }
  if (auto raw =
          takeOption(config, {"audio-max-seconds", "audio_max_seconds"})) {
    options.maxAudioSeconds = parsePositive(
        "audio-max-seconds", *raw, std::numeric_limits<uint64_t>::max());
  }
  // Before the addon took these keys, llama.cpp's argument parser rejected
  // them; without a projection model they still do nothing, so they fail the
  // load instead of being dropped.
  if (!hasProjectionModel && config.size() != keysBefore) {
    throwInvalidOption(
        "projector options (image-*, mmproj-*, audio-max-seconds) need "
        "files.projectionModel");
  }
  return options;
}

MultimodalEmbedder::MultimodalEmbedder(
    const std::string& projectionPath, llama_model* model, llama_context* ctx,
    const common_params& params, bool modelOnGpu,
    const MultimodalOptions& options)
    : model_(model), ctx_(ctx), maxImagePixels_(options.maxImagePixels),
      maxAudioSeconds_(options.maxAudioSeconds) {
  mtmd_helper_log_set(llamaLogCallback, nullptr);

  ggml_backend_dev_t modelDevice =
      params.devices.empty() ? nullptr : params.devices.front();
  mtmd_context_params mparams = mtmd_context_params_default();
  mparams.use_gpu =
      resolveProjectorGpu(modelOnGpu, options.useGpu, modelDevice);
  // Co-locate the projector with the text model, on its first device.
  if (mparams.use_gpu) {
    mparams.device = modelDevice;
  }
  mparams.print_timings = false;
  mparams.n_threads = params.cpuparams.n_threads;
  mparams.flash_attn_type = params.flash_attn_type;
  mparams.warmup = params.warmup;
  mparams.image_min_tokens = options.imageMinTokens;
  mparams.image_max_tokens = options.imageMaxTokens;
  mparams.skip_audio = options.noAudio;

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
  tokenize(
      mctx_.get(),
      input,
      MediaLimits{
          .maxImagePixels = maxImagePixels_,
          .maxAudioSeconds = maxAudioSeconds_},
      cancelled,
      chunks.ptr.get());

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

  // One batch, in prompt order. Each media chunk is encoded and its rows are
  // added as soon as they are out: llama_batch_ext copies them, and the next
  // encode overwrites mtmd_get_output_embd(). The positions match
  // llama-server's add_mtmd_chunk(), including the M-RoPE layout of image
  // tokens.
  const auto nEmbdInp =
      static_cast<std::size_t>(llama_model_n_embd_inp(model_));
  constexpr llama_seq_id seqId = 0;
  llama_batch_ext* batch = batch_.get();
  llama_batch_ext_clear(batch);
  const bool isMrope = mtmd_decode_use_mrope(mctx_.get());
  llama_pos pos = 0;

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
    throwIfCancelled(cancelled);
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

    if (mtmd_encode_chunk(mctx_.get(), chunk) != 0) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(MediaEncodeFailed),
          string_format("failed to encode media chunk %zu", i));
    }
    const float* embd = mtmd_get_output_embd(mctx_.get());
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
          .data = embd + t * nEmbdInp, .n_rows = 1, .n_embd = nEmbdInp};
      const int32_t idx =
          addOrThrow(llama_batch_ext_add_embd(batch, seqId, row));
      llama_batch_ext_set_pos(batch, idx, entryPos);
      llama_batch_ext_set_output_embd(batch, idx, true);
    }
    pos = pos0 + mtmd_input_chunk_get_n_pos(chunk);
  }
  throwIfCancelled(cancelled);

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
