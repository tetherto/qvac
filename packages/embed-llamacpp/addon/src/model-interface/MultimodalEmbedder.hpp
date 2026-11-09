#pragma once

#include <atomic>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <vector>

#include <llama-cpp.h>
#include <llama/common/common.h>
#include <llama/mtmd/mtmd.h>

#include "AudioLengthLimit.hpp"
#include "ImagePixelLimit.hpp"

/// @brief Projector options of a load config, with @qvac/llm-llamacpp's keys.
struct MultimodalOptions {
  /// image-min-tokens / image-max-tokens: per-image token budget of
  /// dynamic-resolution vision encoders; -1 keeps the projector's default.
  int imageMinTokens = -1;
  int imageMaxTokens = -1;
  /// mmproj-no-audio: skip loading the audio encoder.
  bool noAudio = false;
  /// mmproj-use-gpu: run the projector on the GPU; unset picks per device.
  std::optional<bool> useGpu;
  /// image-max-megapixels: largest image accepted, checked before decoding.
  uint64_t maxImagePixels = image_pixel_limit::DEFAULT_MAX_PIXELS;
  /// audio-max-seconds: longest audio accepted, checked before decoding.
  uint64_t maxAudioSeconds = audio_length_limit::DEFAULT_MAX_SECONDS;
};

/// @brief Reads and erases the projector options from @p config: fabric's
/// argument parser does not accept them for embedding loads. Load and
/// assessFit both take the options through this, so they agree.
/// @throws qvac_errors::StatusError(InvalidConfiguration) on an invalid value,
/// or when an option is set and @p hasProjectionModel is false.
MultimodalOptions takeMultimodalOptions(
    std::unordered_map<std::string, std::string>& config,
    bool hasProjectionModel);

/// @brief One part of a multimodal input, in prompt order: text, or the bytes
/// of a media file that mtmd decodes (an image, or wav/mp3/flac audio).
struct MultimodalPart {
  bool isMedia = false;
  std::string text;
  std::vector<uint8_t> media;
};

/// @brief One input to embed: its parts in order. It yields one embedding.
using MultimodalInput = std::vector<MultimodalPart>;

/// @brief Embeds inputs that mix text with images and audio, through the
/// projector (mmproj) that pairs with the text model.
///
/// @details An embedding model keeps no memory between batches, so a mixed
/// input only embeds correctly when its text tokens and its encoded media go
/// through one decode together. Each input is tokenized into chunks by mtmd,
/// its media chunks are encoded by the projector, and the text tokens and the
/// media embeddings are added to one llama_batch_ext in prompt order, as
/// llama-server's add_prompt_mixed() does for memory-less models.
class MultimodalEmbedder {
public:
  /// @param modelOnGpu Whether the text model runs on the GPU; the projector
  /// can only run there when it does.
  /// @throws qvac_errors::StatusError when the projector cannot be loaded.
  MultimodalEmbedder(
      const std::string& projectionPath, llama_model* model, llama_context* ctx,
      const common_params& params, bool modelOnGpu,
      const MultimodalOptions& options);

  MultimodalEmbedder(const MultimodalEmbedder&) = delete;
  MultimodalEmbedder& operator=(const MultimodalEmbedder&) = delete;
  MultimodalEmbedder(MultimodalEmbedder&&) = delete;
  MultimodalEmbedder& operator=(MultimodalEmbedder&&) = delete;
  ~MultimodalEmbedder() = default;

  /// @brief Writes the pooled embedding of @p input, normalized with
  /// @p embdNormalize, into @p out (llama_model_n_embd_out floats).
  /// @throws std::runtime_error("Job cancelled") once @p cancelled is set.
  void embed(
      const MultimodalInput& input, std::span<float> out, int embdNormalize,
      const std::atomic<bool>& cancelled);

private:
  llama_model* model_;
  llama_context* ctx_;
  uint64_t maxImagePixels_;
  uint64_t maxAudioSeconds_;
  mtmd::context_ptr mctx_;
  llama_batch_ext_ptr batch_;
};
