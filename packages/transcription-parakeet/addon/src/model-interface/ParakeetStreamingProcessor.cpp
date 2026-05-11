#include "ParakeetStreamingProcessor.hpp"

#include <algorithm>
#include <chrono>
#include <exception>
#include <iomanip>
#include <sstream>
#include <utility>

#include "inference-addon-cpp/Logger.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"

namespace qvac_lib_infer_parakeet {

namespace logger = qvac_lib_inference_addon_cpp::logger;

namespace {
// HH:MM:SS.fff -- mirrors ParakeetModel::formatSeconds so the JS-side
// `dominantSpeaker` regex (and any consumer that parses speaker
// segments) keeps working unchanged whether we reach it through the
// offline `runSortformerProcess_` path or this duplex processor.
std::string formatSeconds(float seconds) {
  if (seconds < 0.0F) seconds = 0.0F;
  const int   hours = static_cast<int>(seconds) / 3600;
  const int   mins  = (static_cast<int>(seconds) / 60) % 60;
  const float secs  = seconds - (hours * 3600 + mins * 60);
  std::ostringstream os;
  os << std::setfill('0') << std::setw(2) << hours << ":"
     << std::setfill('0') << std::setw(2) << mins  << ":"
     << std::fixed << std::setprecision(3)
     << std::setfill('0') << std::setw(6) << secs;
  return os.str();
}
} // namespace

ParakeetStreamingProcessor::ParakeetStreamingProcessor(
    ParakeetModel& model,
    std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue> output_queue,
    Config config)
    : model_(model), output_queue_(std::move(output_queue)), config_(config) {
  if (model_.isSortformer()) {
    parakeet::SortformerStreamingOptions opts;
    opts.sample_rate    = config_.sampleRate;
    opts.chunk_ms       = config_.chunkMs;
    opts.history_ms     = config_.historyMs;
    opts.threshold      = config_.diarOnsetThreshold;
    opts.min_segment_ms = config_.diarMinSegmentMs;
    opts.emit_partials  = config_.emitPartials;

    diar_session_ = model_.createDuplexDiarizationSession(
        opts,
        [this](const parakeet::StreamingDiarizationSegment& seg) {
          onDiarSegment_(seg);
        });
  } else {
    parakeet::StreamingOptions opts;
    opts.sample_rate       = config_.sampleRate;
    opts.chunk_ms          = config_.chunkMs;
    if (config_.leftContextMs > 0) {
      opts.left_context_ms = config_.leftContextMs;
    }
    if (config_.rightLookaheadMs >= 0) {
      opts.right_lookahead_ms = config_.rightLookaheadMs;
    }
    opts.emit_partials     = config_.emitPartials;
    opts.enable_energy_vad = config_.emitEnergyVad;

    asr_session_ = model_.createDuplexAsrSession(
        opts, [this](const parakeet::StreamingSegment& seg) {
          onAsrSegment_(seg);
        });
  }

  thread_ = std::thread([this]() { processLoop_(); });
}

ParakeetStreamingProcessor::~ParakeetStreamingProcessor() {
  cancel();
}

void ParakeetStreamingProcessor::appendAudio(std::vector<float>&& samples) {
  if (samples.empty()) return;
  {
    std::lock_guard<std::mutex> lk(mtx_);
    if (ended_ || cancelled_) return;
    if (pending_.empty()) {
      pending_ = std::move(samples);
    } else {
      pending_.insert(pending_.end(), samples.begin(), samples.end());
    }
  }
  cv_.notify_one();
}

void ParakeetStreamingProcessor::end() {
  bool should_signal = false;
  {
    std::lock_guard<std::mutex> lk(mtx_);
    if (!ended_ && !cancelled_) {
      ended_        = true;
      should_signal = true;
    }
  }
  if (should_signal) cv_.notify_all();
  // join() runs at most once across end() / cancel() / dtor's cancel(),
  // even when they race on different threads. Without this guard the
  // loser observed thread_.joinable() == true and called join() on an
  // already-joined thread, raising std::system_error.
  std::call_once(teardown_once_, [this] {
    if (thread_.joinable()) thread_.join();
  });
}

void ParakeetStreamingProcessor::cancel() {
  bool should_signal = false;
  {
    std::lock_guard<std::mutex> lk(mtx_);
    if (!cancelled_) {
      cancelled_    = true;
      should_signal = true;
    }
  }
  if (should_signal) {
    try {
      if (asr_session_)  asr_session_->cancel();
      if (diar_session_) diar_session_->cancel();
    } catch (...) {
    }
    cv_.notify_all();
  }
  std::call_once(teardown_once_, [this] {
    if (thread_.joinable()) thread_.join();
  });
}

void ParakeetStreamingProcessor::onAsrSegment_(
    const parakeet::StreamingSegment& seg) {
  if (seg.text.empty() && !seg.is_eou_boundary) return;
  Transcript t;
  t.text        = seg.text;
  t.start       = static_cast<float>(seg.start_s);
  t.end         = static_cast<float>(seg.end_s);
  t.toAppend    = true;
  t.isEndOfTurn = seg.is_eou_boundary;
  t.startsWord  = seg.starts_word;
  seg_buffer_.push_back(std::move(t));
}

void ParakeetStreamingProcessor::onDiarSegment_(
    const parakeet::StreamingDiarizationSegment& seg) {
  if (seg.speaker_id < 0) return;
  Transcript t;
  std::ostringstream os;
  os << "Speaker " << seg.speaker_id << ": "
     << formatSeconds(static_cast<float>(seg.start_s)) << " - "
     << formatSeconds(static_cast<float>(seg.end_s));
  t.text     = os.str();
  t.start    = static_cast<float>(seg.start_s);
  t.end      = static_cast<float>(seg.end_s);
  t.toAppend = true;
  seg_buffer_.push_back(std::move(t));
}

void ParakeetStreamingProcessor::emitPending_() {
  if (seg_buffer_.empty()) return;
  std::vector<Transcript> batch;
  batch.swap(seg_buffer_);
  try {
    output_queue_->queueResult(std::any(std::move(batch)));
  } catch (const std::exception& e) {
    QLOG(logger::Priority::WARNING,
         std::string("ParakeetStreamingProcessor: queueResult failed: ") +
             e.what());
  }
}

void ParakeetStreamingProcessor::processLoop_() {
  while (true) {
    std::vector<float> work;
    bool finalising = false;
    bool aborted    = false;
    {
      std::unique_lock<std::mutex> lk(mtx_);
      cv_.wait(lk, [this] {
        return cancelled_ || ended_ || !pending_.empty();
      });
      if (cancelled_) {
        aborted = true;
      } else {
        if (!pending_.empty()) work.swap(pending_);
        if (ended_ && pending_.empty()) finalising = true;
      }
    }

    if (aborted) break;

    if (!work.empty()) {
      try {
        if (asr_session_) {
          asr_session_->feed_pcm_f32(work.data(),
                                     static_cast<int>(work.size()));
        } else if (diar_session_) {
          diar_session_->feed_pcm_f32(work.data(),
                                      static_cast<int>(work.size()));
        }
        audio_seconds_ +=
            static_cast<double>(work.size()) /
            static_cast<double>(config_.sampleRate);
      } catch (const std::exception& e) {
        QLOG(logger::Priority::ERROR,
             std::string("ParakeetStreamingProcessor: feed failed: ") +
                 e.what());
        try {
          output_queue_->queueException(e);
        } catch (...) {
        }
        break;
      }
      emitPending_();
    }

    if (finalising) {
      try {
        if (asr_session_)  asr_session_->finalize();
        if (diar_session_) diar_session_->finalize();
      } catch (const std::exception& e) {
        QLOG(logger::Priority::WARNING,
             std::string(
                 "ParakeetStreamingProcessor: finalize failed: ") +
                 e.what());
      }
      emitPending_();
      break;
    }
  }

  worker_done_.store(true);
}

} // namespace qvac_lib_infer_parakeet
