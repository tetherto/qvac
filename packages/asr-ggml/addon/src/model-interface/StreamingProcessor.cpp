#include "StreamingProcessor.hpp"

#include <algorithm>
#include <memory>
#include <stdexcept>

#include "inference-addon-cpp/Logger.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "whisper.cpp/WhisperModel.hpp"

namespace {
struct VadSegmentsDeleter {
  void operator()(whisper_vad_segments* s) const {
    if (s != nullptr) whisper_vad_free_segments(s);
  }
};
using VadSegmentsPtr = std::unique_ptr<whisper_vad_segments, VadSegmentsDeleter>;

// whisper.cpp VAD segment timestamps are reported in centiseconds.
constexpr float K_CENTISECONDS_TO_SECONDS = 0.01F;
} // namespace

namespace qvac_lib_inference_addon_whisper {

StreamingProcessor::StreamingProcessor(
    WhisperModel& model,
    std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue> outputQueue,
    Config config)
    : model_(model), outputQueue_(std::move(outputQueue)),
      config_(std::move(config)) {

  whisper_vad_context_params vadCParams = whisper_vad_default_context_params();
  vadCtx_ = whisper_vad_init_from_file_with_params(
      config_.vadModelPath.c_str(), vadCParams);
  if (vadCtx_ == nullptr) {
    throw std::runtime_error(
        "StreamingProcessor: failed to initialize VAD context from " +
        config_.vadModelPath);
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: VAD context initialized from " +
          config_.vadModelPath);

  thread_ = std::thread([this]() { processLoop(); });
}

StreamingProcessor::~StreamingProcessor() {
  {
    std::lock_guard lock(mtx_);
    ended_ = true;
  }
  cv_.notify_one();
  if (thread_.joinable()) {
    thread_.join();
  }
  if (vadCtx_ != nullptr) {
    whisper_vad_free(vadCtx_);
    vadCtx_ = nullptr;
  }
}

void StreamingProcessor::appendAudio(std::vector<float>&& samples) {
  {
    std::lock_guard lock(mtx_);
    if (ended_) {
      return;
    }
    if (pendingAudio_.empty()) {
      pendingAudio_ = std::move(samples);
    } else {
      pendingAudio_.insert(pendingAudio_.end(), samples.begin(), samples.end());
    }
    // Drop oldest audio when backlog exceeds safety cap
    if (static_cast<int>(pendingAudio_.size()) > config_.maxBufferSamples) {
      int excess = static_cast<int>(pendingAudio_.size()) -
                   config_.maxBufferSamples;
      pendingAudio_.erase(
          pendingAudio_.begin(), pendingAudio_.begin() + excess);
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "StreamingProcessor: dropped " + std::to_string(excess) +
              " samples from pendingAudio_ (backpressure)");
    }
  }
  cv_.notify_one();
}

void StreamingProcessor::end() {
  {
    std::lock_guard lock(mtx_);
    ended_ = true;
  }
  cv_.notify_one();
  if (thread_.joinable()) {
    thread_.join();
  }
}

void StreamingProcessor::cancel() {
  model_.cancel();
  {
    std::lock_guard lock(mtx_);
    cancelled_ = true;
    ended_ = true;
  }
  cv_.notify_one();
  if (thread_.joinable()) {
    thread_.join();
  }
}

void StreamingProcessor::processAudioRange(int startSample, int endSample) {
  int len = endSample - startSample;
  if (len <= 0) {
    return;
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: processing " + std::to_string(len) + " samples (" +
          std::to_string(
              static_cast<double>(len) /
              static_cast<double>(config_.sampleRate)) +
          "s)");

  std::vector<float> segment(
      processBuffer_.begin() + startSample,
      processBuffer_.begin() + endSample);

  try {
    model_.process(segment);
    auto transcripts = model_.takeOutput();
    if (!transcripts.empty()) {
      outputQueue_->queueResult(std::any(std::move(transcripts)));
    }
  } catch (const std::exception& e) {
    hasError_ = true;
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        std::string("StreamingProcessor: processing error: ") + e.what());
  }
}

void StreamingProcessor::emitConversationEvents(
    bool speaking, float probability) {
  if (config_.emitVadEvents) {
    VadStateUpdate update;
    update.speaking = speaking;
    update.probability = probability;
    outputQueue_->queueResult(std::any(update));
  }

  if (speaking) {
    wasSpeaking_ = true;
    silenceStartSample_ = 0;
    endOfTurnEmitted_ = false;
    return;
  }

  if (wasSpeaking_) {
    silenceStartSample_ = lastSpeechEndSample_;
    wasSpeaking_ = false;
  }

  if (!hasSeenSpeech_ || config_.endOfTurnSilenceMs <= 0 || endOfTurnEmitted_) {
    return;
  }

  if (silenceStartSample_ == 0) {
    silenceStartSample_ = lastSpeechEndSample_;
  }

  const std::int64_t currentSample =
      processBufferStartSample_ +
      static_cast<std::int64_t>(processBuffer_.size());
  const int silenceDurationMs = static_cast<int>(
      (currentSample - silenceStartSample_) * 1000 /
      static_cast<std::int64_t>(config_.sampleRate));

  if (silenceDurationMs >= config_.endOfTurnSilenceMs) {
    EndOfTurnEvent event;
    event.silenceDurationMs = silenceDurationMs;
    outputQueue_->queueResult(std::any(event));
    endOfTurnEmitted_ = true;
  }
}

whisper_vad_params StreamingProcessor::buildVadParams() const {
  whisper_vad_params vadParams = whisper_vad_default_params();
  vadParams.threshold = config_.vadThreshold;
  vadParams.min_speech_duration_ms = config_.minSpeechDurationMs;
  vadParams.min_silence_duration_ms = config_.minSilenceDurationMs;
  vadParams.max_speech_duration_s = config_.maxSpeechDurationS;
  vadParams.speech_pad_ms = config_.speechPadMs;
  vadParams.samples_overlap = config_.samplesOverlap;
  return vadParams;
}

float StreamingProcessor::speechPadSeconds() const {
  return static_cast<float>(config_.speechPadMs) / 1000.0F;
}

float StreamingProcessor::segmentEndSeconds(
    whisper_vad_segments* segments, int index) const {
  return whisper_vad_segments_get_segment_t1(segments, index) *
         K_CENTISECONDS_TO_SECONDS;
}

int StreamingProcessor::secondsToSample(float seconds) const {
  return static_cast<int>(seconds * static_cast<float>(config_.sampleRate));
}

bool StreamingProcessor::hasEnoughNewAudioForVad(
    int bufferSize, bool done) const {
  const int newSamplesSinceLastRun = bufferSize - bufferSizeAtLastVadRun_;
  return newSamplesSinceLastRun >= config_.vadRunIntervalSamples || done;
}

void StreamingProcessor::drainPendingAudio(bool& done, bool& wasCancelled) {
  std::unique_lock lock(mtx_);
  cv_.wait(lock, [this]() { return ended_ || !pendingAudio_.empty(); });

  if (processBuffer_.empty()) {
    processBufferStartSample_ = totalSamplesReceived_;
  }
  const std::int64_t pendingSampleCount =
      static_cast<std::int64_t>(pendingAudio_.size());
  processBuffer_.insert(
      processBuffer_.end(), pendingAudio_.begin(), pendingAudio_.end());
  pendingAudio_.clear();
  totalSamplesReceived_ += pendingSampleCount;

  done = ended_;
  wasCancelled = cancelled_;
}

void StreamingProcessor::updateSpeakingState(
    whisper_vad_segments* segments, int nSeg, float totalDurationS,
    int bufferSize) {
  bool speaking = false;
  if (nSeg > 0) {
    const float lastSegmentT1S = segmentEndSeconds(segments, nSeg - 1);
    speaking = lastSegmentT1S + speechPadSeconds() >= totalDurationS;
    lastSpeechEndSample_ =
        processBufferStartSample_ +
        std::min(secondsToSample(lastSegmentT1S), bufferSize);
    hasSeenSpeech_ = true;
  }
  // whisper.cpp's public VAD API gives us the speech decision here; it does
  // not expose per-run probabilities in the installed header.
  emitConversationEvents(speaking, speaking ? 1.0F : 0.0F);
}

int StreamingProcessor::findLastCompleteSegment(
    whisper_vad_segments* segments, int nSeg, float totalDurationS,
    bool done) const {
  int lastComplete = -1;
  for (int i = 0; i < nSeg; i++) {
    if (segmentEndSeconds(segments, i) + speechPadSeconds() < totalDurationS) {
      lastComplete = i;
    }
  }
  // When the stream has ended, the trailing segment is final even without the
  // usual speech-pad margin.
  if (done && nSeg > 0) {
    lastComplete = nSeg - 1;
  }
  return lastComplete;
}

void StreamingProcessor::dispatchCompleteSegments(
    whisper_vad_segments* segments, int lastComplete, int bufferSize) {
  for (int i = 0; i <= lastComplete; i++) {
    const float t0S =
        whisper_vad_segments_get_segment_t0(segments, i) *
        K_CENTISECONDS_TO_SECONDS;
    const float t1S = segmentEndSeconds(segments, i);
    const int startSample = std::max(0, secondsToSample(t0S));
    const int endSample = std::min(secondsToSample(t1S), bufferSize);
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "StreamingProcessor: segment " + std::to_string(i) + " [" +
            std::to_string(t0S) + "s - " + std::to_string(t1S) +
            "s] samples=[" + std::to_string(startSample) + ", " +
            std::to_string(endSample) + "]");
    if (endSample > startSample) {
      processAudioRange(startSample, endSample);
    }
  }
}

void StreamingProcessor::trimProcessedAudio(
    whisper_vad_segments* segments, int lastComplete, int bufferSize) {
  const float lastT1S = segmentEndSeconds(segments, lastComplete);
  const int trimPoint = std::min(secondsToSample(lastT1S), bufferSize);
  processBuffer_.erase(
      processBuffer_.begin(), processBuffer_.begin() + trimPoint);
  processBufferStartSample_ += trimPoint;
  bufferSizeAtLastVadRun_ = 0;
}

void StreamingProcessor::forceProcessOnOverflow() {
  if (static_cast<int>(processBuffer_.size()) < config_.maxBufferSamples) {
    return;
  }
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: buffer overflow, force-processing " +
          std::to_string(processBuffer_.size()) + " samples");
  processAudioRange(0, static_cast<int>(processBuffer_.size()));
  processBuffer_.clear();
  processBufferStartSample_ = totalSamplesReceived_;
  bufferSizeAtLastVadRun_ = 0;
}

void StreamingProcessor::runVadSegmentation(
    const whisper_vad_params& vadParams, bool done) {
  const int bufferSize = static_cast<int>(processBuffer_.size());

  if (!hasEnoughNewAudioForVad(bufferSize, done) || bufferSize <= 0) {
    return;
  }

  bufferSizeAtLastVadRun_ = bufferSize;
  VadSegmentsPtr segments(whisper_vad_segments_from_samples(
      vadCtx_, vadParams, processBuffer_.data(), bufferSize));

  if (segments) {
    const int nSeg = whisper_vad_segments_n_segments(segments.get());
    const float totalDurationS =
        static_cast<float>(bufferSize) /
        static_cast<float>(config_.sampleRate);

    updateSpeakingState(segments.get(), nSeg, totalDurationS, bufferSize);

    const int lastComplete =
        findLastCompleteSegment(segments.get(), nSeg, totalDurationS, done);
    if (lastComplete >= 0) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "StreamingProcessor: VAD found " + std::to_string(nSeg) +
              " segment(s), " + std::to_string(lastComplete + 1) +
              " complete, totalDuration=" + std::to_string(totalDurationS) +
              "s");
      dispatchCompleteSegments(segments.get(), lastComplete, bufferSize);
      trimProcessedAudio(segments.get(), lastComplete, bufferSize);
    }
  }

  forceProcessOnOverflow();
}

void StreamingProcessor::finalizeStream() {
  {
    std::lock_guard lock(mtx_);
    if (cancelled_) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "StreamingProcessor: cancelled, queueing cancellation");
      outputQueue_->queueException(std::runtime_error("Job cancelled"));
      return;
    }
  }

  if (!processBuffer_.empty()) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "StreamingProcessor: processing final buffer of " +
            std::to_string(processBuffer_.size()) + " samples");
    processAudioRange(0, static_cast<int>(processBuffer_.size()));
    processBuffer_.clear();
    processBufferStartSample_ = totalSamplesReceived_;
  }

  if (hasError_) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "StreamingProcessor: stream ended with errors");
    outputQueue_->queueException(std::runtime_error(
        "StreamingProcessor: one or more segments failed during processing"));
  } else {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "StreamingProcessor: stream ended, queueing job completion");
    outputQueue_->queueJobEnded();
  }
}

void StreamingProcessor::processLoop() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: thread started (VAD-based segmentation)");

  model_.prepareForStreaming();

  const whisper_vad_params vadParams = buildVadParams();

  while (true) {
    bool done = false;
    bool wasCancelled = false;
    drainPendingAudio(done, wasCancelled);

    if (wasCancelled) {
      break;
    }

    runVadSegmentation(vadParams, done);

    if (done) {
      break;
    }
  }

  finalizeStream();
}

} // namespace qvac_lib_inference_addon_whisper
