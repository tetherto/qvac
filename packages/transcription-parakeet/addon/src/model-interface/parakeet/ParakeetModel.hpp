#pragma once

// Pure-ggml backend for the Parakeet binding (sourced from qvac-parakeet.cpp).
//
// This class used to host four ggml sessions (preprocessor + encoder
// + decoder + ctc/sortformer) plus a hand-rolled mel-spectrogram, CMVN,
// chunked-limited streaming state machine for EOU, and a Sortformer
// post-processing pipeline. All of that has been replaced by a single
// `parakeet::Engine` from `parakeet-cpp` (vcpkg overlay port). The
// engine internally handles mel + encoder + decoder + diarization for any
// of the four model types (CTC, TDT, EOU, Sortformer) given a single GGUF
// file, so the binding's job is reduced to:
//
//   1. accumulate GGUF bytes from `setWeightsForFile()` into a temp file,
//   2. open `parakeet::Engine` against that path,
//   3. dispatch `process()` to either `transcribe_samples()` (CTC / TDT /
//      EOU) or `diarize_samples()` (Sortformer),
//   4. wrap the engine result in `Transcript` and fire the on-segment
//      callback.

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <span>
#include <streambuf>
#include <string>
#include <type_traits>
#include <vector>

#include "ParakeetConfig.hpp"
#include "model-interface/ParakeetTypes.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"

#include <parakeet/streaming.h>
#include <parakeet/diarization.h>

namespace parakeet {
class Engine;
} // namespace parakeet

namespace qvac_lib_infer_parakeet {

class ParakeetModel : public qvac_lib_inference_addon_cpp::model::IModel,
                      public qvac_lib_inference_addon_cpp::model::IModelCancel,
                      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using OutputCallback = std::function<void(const Transcript&)>;
  using ValueType = float;
  using Input = std::vector<ValueType>;
  using InputView = std::span<const ValueType>;
  using Output = std::vector<Transcript>;
  struct AnyInput {
    Input input;
  };

  explicit ParakeetModel(const ParakeetConfig& config);
  ~ParakeetModel();

  ParakeetModel(const ParakeetModel&) = delete;
  ParakeetModel& operator=(const ParakeetModel&) = delete;
  ParakeetModel(ParakeetModel&&) = delete;
  ParakeetModel& operator=(ParakeetModel&&) = delete;

  // ── Lifecycle ──────────────────────────────────────────────────────────
  void initializeBackend();
  void load();
  void unload();
  void unloadWeights() { unload(); }
  void reload();
  void reset();
  // Finalises the streaming session (if open) so the trailing partial
  // chunk's segments are flushed via the on-segment callback before the
  // session is torn down on unload(). For offline mode this is just a
  // flag flip.
  //
  // SCOPE: framework path only. The duplex `runStreaming()` path
  // (ParakeetStreamingProcessor) owns its own parakeet streaming session
  // and never calls endOfStream() / sets stream_ended_. Consumers must
  // not gate their cleanup on `isStreamEnded()` after `runStreaming()`.
  void endOfStream();
  bool isStreamEnded() const { return stream_ended_; }
  bool isLoaded() const { return is_loaded_; }
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;
  std::any process(const std::any& input) override;
  std::string getName() const override;
  void cancel() const override;
  void warmup();

  // ── Processing ─────────────────────────────────────────────────────────
  void process(const Input& input);
  Output
  process(const Input& input, std::function<void(const Output&)> callback);

  // ── Duplex streaming helpers ───────────────────────────────────────────
  // Open a long-lived parakeet StreamSession owned by the caller (e.g.
  // ParakeetStreamingProcessor). Bypasses the framework's per-call
  // process() lifecycle: the caller drives feed_pcm_f32 / finalize /
  // cancel directly on its own thread, and the on_segment callback fires
  // synchronously inside feed_pcm_f32 / finalize whenever the engine
  // emits a segment. Throws if the engine isn't loaded.
  std::unique_ptr<parakeet::StreamSession> createDuplexAsrSession(
      const parakeet::StreamingOptions& opts,
      parakeet::StreamingCallback onSegment);

  // Same idea for Sortformer-flavoured GGUFs.
  std::unique_ptr<parakeet::SortformerStreamSession>
  createDuplexDiarizationSession(
      const parakeet::SortformerStreamingOptions& opts,
      parakeet::SortformerSegmentCallback onSegment);

  // Cheap accessors used by the duplex processor (and unit tests) to
  // build session opts from cfg_ when the JS caller doesn't override
  // them. Reads only; safe without holding engine_mutex_.
  int                 getSampleRate() const { return sample_rate_; }

  // Active backend identity captured at load(); surfaced to JS via the addon's
  // getBackendInfo(). getBackendId() codes: 0=CPU 1=Metal 2=CUDA 3=Vulkan
  // 4=OpenCL 99=other. getBackendDeviceClass(): 0=CPU 1=GPU.
  int getBackendId() const { return backend_id_; }
  int getBackendDeviceClass() const { return backend_device_; }
  const std::string& getBackendName() const { return backend_name_; }
  const std::string& getBackendDescription() const {
    return backend_description_;
  }
  int                 getStreamingChunkMs() const {
    return cfg_.streamingChunkMs > 0 ? cfg_.streamingChunkMs : 1000;
  }
  int                 getStreamingHistoryMs() const {
    return cfg_.streamingHistoryMs > 0
               ? cfg_.streamingHistoryMs
               : ParakeetConfig::DEFAULT_STREAMING_HISTORY_MS;
  }
  // <0 = "not set; keep parakeet's own defaults". Returned verbatim so
  // callers treat the negative value as "skip the override".
  int                 getStreamingLeftContextMs() const {
    return cfg_.streamingLeftContextMs;
  }
  int                 getStreamingRightLookaheadMs() const {
    return cfg_.streamingRightLookaheadMs;
  }
  bool                getStreamingEmitPartials() const {
    return cfg_.streamingEmitPartials;
  }
  bool                getStreamingEnergyVad() const {
    return cfg_.streamingEnergyVad;
  }
  // AOSC accessors (v2.1+ Sortformer only). Forwarded verbatim from
  // ParakeetConfig; parakeet-cpp ignores them for non-Sortformer engines
  // and for v1/v2 Sortformer GGUFs.
  bool getStreamingSpkCacheEnable() const {
    return cfg_.streamingSpkCacheEnable;
  }
  int getStreamingSpkCacheLen() const { return cfg_.streamingSpkCacheLen; }
  int getStreamingFifoLen() const { return cfg_.streamingFifoLen; }
  int getStreamingChunkLeftContextMs() const {
    return cfg_.streamingChunkLeftContextMs;
  }
  int getStreamingChunkRightContextMs() const {
    return cfg_.streamingChunkRightContextMs;
  }
  int getStreamingSpkCacheUpdatePeriod() const {
    return cfg_.streamingSpkCacheUpdatePeriod;
  }
  bool                isSortformer() const {
    return cfg_.modelType == ModelType::SORTFORMER;
  }
  float               getDiarOnsetThreshold() const { return diarConfig_.onset; }
  float               getDiarMinDurationOn() const {
    return diarConfig_.minDurationOn;
  }

  // ── Configuration ──────────────────────────────────────────────────────
  void setConfig(const ParakeetConfig& config) { cfg_ = config; }
  void setOnSegmentCallback(const OutputCallback& callback) {
    on_segment_ = callback;
  }
  // TEST-ONLY hook: directly append a Transcript to output_ so unit
  // tests can exercise the framework's drainage path without driving a
  // real engine. Production callers should never invoke this -- any
  // segment pushed here will be flushed verbatim with the next
  // process() call.
  void addTranscription(const Transcript& transcript) {
    output_.push_back(transcript);
  }

  void saveLoadParams(const ParakeetConfig& config) { cfg_ = config; }

  template <typename T, typename... Args>
  typename std::enable_if<
      !std::is_same<typename std::decay<T>::type, ParakeetConfig>::value,
      void>::type
  saveLoadParams(T&&, Args&&...) {}

  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& streambuf) override;
  void waitForLoadInitialization() override { load(); }

  // Two streaming overloads. The ggml backend doesn't actually care about
  // chunking; it just buffers the bytes until `completed=true`, then
  // materialises them into a temp file on `load()`.
  //
  // These deliberately keep snake_case names: the natural camelBack
  // (setWeightsForFile) would collide with the framework override declared
  // above, so they are exempted from the identifier-naming check.
  // NOLINTNEXTLINE(readability-identifier-naming)
  void set_weights_for_file(
      const std::string& filename, std::span<const uint8_t> contents,
      bool completed);

  // NOLINTNEXTLINE(readability-identifier-naming)
  void set_weights_for_file(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>> streambuf);

  template <typename T>
  // NOLINTNEXTLINE(readability-identifier-naming)
  void set_weights_for_file(const std::string& filename, T&& contents) {}

  // ── Queries ────────────────────────────────────────────────────────────
  [[nodiscard]] std::string getDisplayName() const { return getName(); }

  // Convenience helper -- decode raw int16 PCM bytes into normalised
  // float samples. Kept for back-compat with callers that used to pipe
  // raw mic captures straight into `process()`.
  [[nodiscard]] static std::vector<float> preprocessAudioData(
      const std::vector<uint8_t>& audioData,
      const std::string& audioFormat = "s16le");

private:
  void throwIfCancelled() const;
  static bool isCancellationError(const std::exception& e);

  // load() decomposition.
  std::filesystem::path resolveGgufPath();
  void detectModelType();
  void captureBackend();
  void warnOnGpuFallback() const;
  void warnOnSampleRateMismatch() const;
  void openStreamingSessionOrThrow();

  // ── GGUF buffer staging ────────────────────────────────────────────────
  // The addon framework streams the GGUF bytes via setWeightsForFile().
  // We accumulate them into `gguf_buffer_` keyed by the (single) GGUF
  // filename; on load() we materialise the buffer into a temp file and
  // hand the path to parakeet::Engine.
  std::string                          gguf_filename_;
  std::vector<uint8_t>                 gguf_buffer_;
  std::filesystem::path                gguf_temp_path_;
  bool                                 gguf_completed_ = false;

  std::filesystem::path writeBufferToTempFile();
  void cleanupTempFile();

  // ── State ──────────────────────────────────────────────────────────────
  ParakeetConfig                       cfg_;
  OutputCallback                       on_segment_;
  Output                               output_;

  bool                                 stream_ended_ = false;
  bool                                 is_loaded_    = false;
  bool                                 is_warmed_up_ = false;

  // The Engine itself (pimpl-owned via unique_ptr to keep the
  // qvac-parakeet headers out of the binding's public include surface).
  std::unique_ptr<parakeet::Engine> engine_;
  mutable std::mutex                     engine_mutex_;

  // Only one session is open at a time (model_type decides which).
  // session_mutex_ guards the unique_ptrs against the race between cancel()
  // (callable from any thread) and the open/close/unload lifecycle.
  mutable std::mutex                                 session_mutex_;
  std::unique_ptr<parakeet::StreamSession>           asr_session_;
  std::unique_ptr<parakeet::SortformerStreamSession> diar_session_;

  // Wall-clock seconds of audio fed to the streaming sessions so far,
  // used to translate per-session relative segment timestamps into a
  // monotonically growing wall-clock-style timeline that mirrors what
  // the offline path emits in `process(input)`.
  double                              streaming_audio_seconds_ = 0.0;
  bool                                streaming_finalized_     = false;

  // Sample rate in Hz; copied from cfg_.sampleRate at load time. The
  // ggml engine does not currently support non-16 kHz models, so anything
  // other than 16 000 throws on load.
  int                                  sample_rate_ = 16000;

  // Active backend, captured once at load(). backend_device_ is the
  // post-fallback truth (0 = CPU, 1 = GPU): a GPU init failure leaves it at
  // CPU even when cfg_.useGPU was true. backend_id_ codes are mirrored on
  // the JS side: 0 = CPU, 1 = Metal, 2 = CUDA, 3 = Vulkan, 4 = OpenCL,
  // 99 = other.
  int                                  backend_device_ = 0;
  int                                  backend_id_     = 0;
  int backend_gpu_unsupported_ = 0;
  std::string                          backend_name_   = "CPU";
  // Human-readable GPU device name recovered from the ggml device registry
  // at load(); empty on CPU. Surfaced to JS via getBackendInfo().
  std::string backend_description_;

  // ── Token / sentinel constants ─────────────────────────────────────────
  // The engine itself uses different vocab IDs internally; we surface only 
  // the "[No speech detected]" / "[Audio too short]" / ... text sentinels 
  // through Transcript::text.
  static constexpr const char* ERR_NO_SPEECH        = "[No speech detected]";
  static constexpr const char* ERR_AUDIO_SHORT      = "[Audio too short]";
  static constexpr const char* ERR_MODEL_NOT_READY  = "[Model not ready]";
  static constexpr const char* ERR_MODEL_NOT_LOADED = "[Model not loaded]";
  static constexpr const char* ERR_INFERENCE       = "[Inference error]";
  static constexpr const char* ERR_NO_SPEAKERS     = "[No speakers detected]";
  static constexpr const char* ERR_JOB_CANCELLED   = "Job cancelled";

  static bool isSentinel(const std::string& text) {
    return text == ERR_NO_SPEECH || text == ERR_AUDIO_SHORT ||
           text == ERR_MODEL_NOT_READY || text == ERR_MODEL_NOT_LOADED ||
           text == ERR_INFERENCE || text == ERR_NO_SPEAKERS;
  }

  // ── Audio constants ────────────────────────────────────────────────────
  // The Engine handles its own mel-spectrogram internally; these are
  // here only so JS-facing logging / metric reporting keeps the same
  // numbers as the old binding.
  static constexpr int   HOP_LENGTH  = 160;
  static constexpr float SAMPLE_RATE = 16000.0f;

  DiarizationConfig                    diarConfig_;

  // ── Sortformer head dispatch ───────────────────────────────────────────
  std::string runSortformerProcess(const Input& input);

  // ── ASR head dispatch ──────────────────────────────────────────────────
  std::string runAsrProcess(const Input& input);

  // ── Streaming session helpers ──────────────────────────────────────────
  // LEGACY framework path (cfg_.streaming): opened in load(), driven by
  // runStreamingProcess() via process(). The duplex `runStreaming(...)`
  // path uses createDuplexAsrSession() / createDuplexDiarizationSession()
  // and ParakeetStreamingProcessor instead.
  void openStreamingSession();
  void openSortformerStreamingSession(parakeet::Engine& engine);
  void openAsrStreamingSession(parakeet::Engine& engine);
  void closeStreamingSession();
  void pushPendingSegment(Transcript segment);
  std::vector<Transcript> takePendingStreamingSegments();
  void emitStreamingSegments(const std::vector<Transcript>& segments);
  int64_t feedStreamingChunk(const Input& input);
  void reopenStreamingSession();

  // Streaming-session callbacks fire mid-feed (and from a different thread
  // on finalize()), so segments are stashed here under streaming_mutex_ and
  // flushed into output_ at the end of each process() call.
  std::mutex                          streaming_mutex_;
  std::vector<Transcript>             pending_streaming_segments_;

  // Feeds a cfg_.streaming chunk and returns the concatenated text of the
  // segments fired during the call. Sentinel strings are applied when the
  // session emitted nothing so the Transcript-shaped JS contract holds.
  std::string runStreamingProcess(const Input& input);

  // ── Runtime stats (subset of legacy fields; we now derive most numbers
  //     from the Engine's own per-call timings) ────────────────────────
  float                                processed_time_       = 0.0f;
  int64_t                              totalSamples_         = 0;
  int64_t                              totalTokens_          = 0;
  int64_t                              totalTranscriptions_  = 0;
  int64_t                              processCalls_         = 0;
  int64_t                              totalWallMs_          = 0;
  int64_t                              modelLoadMs_          = 0;
  int64_t                              melSpecMs_            = 0;
  int64_t                              encoderMs_            = 0;
  int64_t                              decoderMs_            = 0;
  int64_t                              totalEncodedFrames_   = 0;

  mutable std::atomic_uint64_t         nextGeneration_   = 1;
  mutable std::atomic_uint64_t         activeGeneration_ = 0;
  mutable std::atomic_uint64_t         cancelGeneration_ = 0;
};

} // namespace qvac_lib_infer_parakeet
