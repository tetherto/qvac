#pragma once

#include <atomic>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

#include <llama-cpp.h>
#include <llama/common/common.h>
#include <llama/mtmd/mtmd.h>

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
  /// @param useGpu Whether the projector runs on the GPU, as the text model.
  /// @throws qvac_errors::StatusError when the projector cannot be loaded.
  MultimodalEmbedder(
      const std::string& projectionPath, llama_model* model, llama_context* ctx,
      const common_params& params, bool useGpu);

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
  mtmd::context_ptr mctx_;
  llama_batch_ext_ptr batch_;
};
