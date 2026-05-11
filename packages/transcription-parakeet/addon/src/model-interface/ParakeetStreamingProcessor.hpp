#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include <parakeet/diarization.h>
#include <parakeet/streaming.h>

#include "inference-addon-cpp/queue/OutputQueue.hpp"

#include "model-interface/ParakeetTypes.hpp"

namespace qvac_lib_infer_parakeet {

class ParakeetModel;

// Long-lived worker that bridges JS-side audio chunks and the
// parakeet::StreamSession (or SortformerStreamSession) without going
// through the addon framework's append() -> runJob() -> process()
// lifecycle. One processor per addon instance; lifetime is bound to
// the JS startStreaming() / endStreaming() control verbs.
//
// Threading model:
//   - JS thread (binding) calls appendAudio() per chunk; samples are
//     pushed to pending_ under mtx_, then cv_ is notified.
//   - Worker thread (started in the constructor) waits on cv_, swaps
//     pending_ into a local buffer, drops mtx_, then calls
//     session_->feed_pcm_f32() with the buffered samples. The session's
//     own callback (provided at construction) fires synchronously
//     inside feed_pcm_f32 / finalize and pushes per-segment Transcripts
//     into output_queue_->queueResult().
//   - end() flips ended_, notifies cv_; the worker drains the last
//     batch, calls session_->finalize() to flush the trailing
//     right-lookahead window (and emit any terminal EOU boundary), then
//     joins.
//   - cancel() flips cancelled_, calls session_->cancel(), notifies
//     cv_; the worker exits without finalizing.
class ParakeetStreamingProcessor {
public:
  struct Config {
    int sampleRate          = 16000;
    int chunkMs             = 1000;
    int historyMs           = 30000;
    bool emitPartials       = true;
    bool emitEnergyVad      = false;
    float diarOnsetThreshold = 0.5F;
    int  diarMinSegmentMs   = 200;
    // ASR-only knobs (Sortformer ignores them). <0 means "leave the
    // parakeet engine default in place" (10000 / 2000 ms respectively).
    int  leftContextMs      = -1;
    int  rightLookaheadMs   = -1;
  };

  ParakeetStreamingProcessor(
      ParakeetModel& model,
      std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue> output_queue,
      Config config);

  ~ParakeetStreamingProcessor();

  ParakeetStreamingProcessor(const ParakeetStreamingProcessor&) = delete;
  ParakeetStreamingProcessor& operator=(const ParakeetStreamingProcessor&) =
      delete;
  ParakeetStreamingProcessor(ParakeetStreamingProcessor&&) = delete;
  ParakeetStreamingProcessor& operator=(ParakeetStreamingProcessor&&) = delete;

  // Push s16le or float32 samples already converted to float32 in [-1,1].
  // Thread-safe; safe to call from the JS-binding thread.
  void appendAudio(std::vector<float>&& samples);

  // Graceful shutdown: flush trailing audio via finalize(), drain
  // remaining segments, then join the worker thread.
  void end();

  // Forceful shutdown: cancel the underlying session, drop pending
  // audio, then join the worker thread.
  void cancel();

  // Cumulative seconds of audio fed to the underlying parakeet streaming
  // session so far. Used by the JS layer to populate the synthetic
  // `JobEnded` stats object on `endStreaming()` so consumers reading
  // `response.stats.audioDurationMs` / `totalSamples` after a duplex run
  // get a non-zero value (the framework's RuntimeStats path is bypassed
  // by this processor entirely).
  double audioSeconds() const { return audio_seconds_; }
  int    sampleRate()   const { return config_.sampleRate; }

private:
  void processLoop_();
  void onAsrSegment_(const parakeet::StreamingSegment& seg);
  void onDiarSegment_(const parakeet::StreamingDiarizationSegment& seg);
  void emitPending_();

  ParakeetModel& model_;
  std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue> output_queue_;
  Config config_;

  std::unique_ptr<parakeet::StreamSession> asr_session_;
  std::unique_ptr<parakeet::SortformerStreamSession> diar_session_;

  mutable std::mutex mtx_;
  std::condition_variable cv_;
  std::vector<float> pending_;
  bool ended_     = false;
  bool cancelled_ = false;

  // Segments queued by the streaming callback during a single
  // feed_pcm_f32 call; flushed to output_queue_ as one Array<Transcript>
  // update so the JS onUpdate handler keeps getting one notification per
  // chunk (rather than N micro-notifications).
  std::vector<Transcript> seg_buffer_;

  std::atomic_bool worker_done_{false};
  std::thread thread_;

  // Serialises end() / cancel() / dtor so the worker thread is joined
  // exactly once even when end() races with cancel(), or two cancel()
  // calls race, or the dtor's fallback cancel() races with an explicit
  // end()/cancel() from the binding. Without this, the loser of the race
  // observed thread_.joinable() == true and called join() on an already
  // joined thread, which raises std::system_error.
  std::once_flag teardown_once_;

  // Wall-clock seconds of audio fed so far; mirrors what the legacy
  // process() path tracked, used to translate per-session relative
  // timestamps into a monotonic timeline matching the offline path.
  double audio_seconds_ = 0.0;
};

} // namespace qvac_lib_infer_parakeet
