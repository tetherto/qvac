#pragma once

#include <string>

#include "model-interface/ParakeetTypes.hpp"

namespace qvac_lib_infer_parakeet {

struct ParakeetConfig {
  std::string modelPath;

  // ModelType is auto-detected by ParakeetModel::load() from the
  // engine's `parakeet.model.type` GGUF metadata; the default below
  // is just a placeholder until that override fires.
  ModelType modelType = ModelType::TDT;

  int  maxThreads        = 4;
  bool useGPU            = false;
  int  sampleRate        = 16000;
  int  channels          = 1;
  bool captionEnabled    = false;
  bool timestampsEnabled = true;
  int  seed              = -1;

  // ── Streaming mode ──────────────────────────────────────────────────────
  // When true, the model opens a long-lived qvac_parakeet streaming session
  // (StreamSession for ASR, SortformerStreamSession for diarization) at
  // load() time and routes each process() call through feed_pcm_f32(). The
  // session retains state (KV cache for ASR Mode 3, rolling speaker history
  // for Sortformer) across appends, so within a single run() call:
  //   - Sortformer speaker IDs stay stable from chunk to chunk.
  //   - EOU `<EOU>` boundaries surface as segment markers (and StreamEvents).
  //   - Optional energy-VAD events fire for CTC/TDT.
  // Cross-call scope: a single run() invocation batches all of its append()
  // chunks into one process() call (see runStreamingProcess_), so cross-chunk
  // state is preserved within that run. Each NEW run() on the same model
  // instance starts a fresh streaming session: speaker history, EOU window,
  // and partial decode state do NOT carry over. For continuous live capture,
  // either feed a single long-running run() from a pushable stream, or use
  // the duplex `runStreaming()` API (ParakeetStreamingProcessor) which owns
  // a single long-lived session for the lifetime of one runStreaming() call
  // regardless of how many append-style chunks it ingests.
  // Off by default for batch-style transcription.
  bool streaming             = false;
  int  streamingChunkMs      = 2000;
  int  streamingHistoryMs    = 30000;   // Sortformer rolling window only
  bool streamingEmitPartials = true;
  bool streamingEnergyVad    = false;   // CTC/TDT only; ignored elsewhere
  // Forwarded to parakeet::StreamingOptions.left_context_ms /
  // right_lookahead_ms. ASR sessions only (Sortformer ignores both --
  // it has its own SortformerStreamingOptions::history_ms knob).
  // right_lookahead_ms adds directly to the per-segment latency floor
  // (effective latency >= chunk_ms + right_lookahead_ms); left_context_ms
  // bounds the rolling encoder context retained upstream of each chunk.
  // -1 keeps parakeet's own defaults (10000 / 2000) so callers that don't
  // set the field behave like before.
  int  streamingLeftContextMs    = -1;
  int  streamingRightLookaheadMs = -1;

  ParakeetConfig() = default;
  explicit ParakeetConfig(const std::string& path) : modelPath(path) {}

  bool operator==(const ParakeetConfig& other) const {
    return modelPath == other.modelPath &&
           modelType == other.modelType && maxThreads == other.maxThreads &&
           useGPU == other.useGPU && sampleRate == other.sampleRate &&
           channels == other.channels &&
           captionEnabled == other.captionEnabled &&
           timestampsEnabled == other.timestampsEnabled && seed == other.seed &&
           streaming == other.streaming &&
           streamingChunkMs == other.streamingChunkMs &&
           streamingHistoryMs == other.streamingHistoryMs &&
           streamingEmitPartials == other.streamingEmitPartials &&
           streamingEnergyVad == other.streamingEnergyVad &&
           streamingLeftContextMs == other.streamingLeftContextMs &&
           streamingRightLookaheadMs == other.streamingRightLookaheadMs;
  }

  bool operator!=(const ParakeetConfig& other) const { return !(*this == other); }
};

} // namespace qvac_lib_infer_parakeet
