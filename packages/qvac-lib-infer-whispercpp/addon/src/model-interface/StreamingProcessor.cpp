#include "StreamingProcessor.hpp"

#include <algorithm>
#include <memory>
#include <stdexcept>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "whisper.cpp/WhisperModel.hpp"

namespace {
struct VadSegmentsDeleter {
  void operator()(whisper_vad_segments* s) const {
    if (s != nullptr) whisper_vad_free_segments(s);
  }
};
using VadSegmentsPtr = std::unique_ptr<whisper_vad_segments, VadSegmentsDeleter>;
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
      outputQueue_->queueResult(
          config_.jobId, std::any(std::move(transcripts)));
    }
  } catch (const std::exception& e) {
    hasError_ = true;
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        std::string("StreamingProcessor: processing error: ") + e.what());
  }
}

void StreamingProcessor::processLoop() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: thread started (VAD-based segmentation)");

  model_.prepareForStreaming();

  whisper_vad_params vadParams = whisper_vad_default_params();
  vadParams.threshold = config_.vadThreshold;
  vadParams.min_speech_duration_ms = config_.minSpeechDurationMs;
  vadParams.min_silence_duration_ms = config_.minSilenceDurationMs;
  vadParams.max_speech_duration_s = config_.maxSpeechDurationS;
  vadParams.speech_pad_ms = config_.speechPadMs;
  vadParams.samples_overlap = config_.samplesOverlap;

  while (true) {
    bool done = false;
    bool wasCancelled = false;

    {
      std::unique_lock lock(mtx_);
      cv_.wait(lock, [this]() {
        return ended_ || !pendingAudio_.empty();
      });

      processBuffer_.insert(
          processBuffer_.end(), pendingAudio_.begin(), pendingAudio_.end());
      pendingAudio_.clear();

      done = ended_;
      wasCancelled = cancelled_;
    }

    if (wasCancelled) {
      break;
    }

    int bufferSize = static_cast<int>(processBuffer_.size());

    // Only run VAD when enough new audio has arrived since the last run
    bool shouldRunVad =
        (bufferSize - bufferSizeAtLastVadRun_) >=
            config_.vadRunIntervalSamples ||
        done;

    if (shouldRunVad && bufferSize > 0) {
      bufferSizeAtLastVadRun_ = bufferSize;

      VadSegmentsPtr segments(whisper_vad_segments_from_samples(
          vadCtx_, vadParams, processBuffer_.data(), bufferSize));

      if (segments) {
        int nSeg = whisper_vad_segments_n_segments(segments.get());
        float totalDurationS =
            static_cast<float>(bufferSize) /
            static_cast<float>(config_.sampleRate);

        constexpr float CS_TO_SEC = 0.01F;

        int lastComplete = -1;
        for (int i = 0; i < nSeg; i++) {
          float t1S =
              whisper_vad_segments_get_segment_t1(segments.get(), i) *
              CS_TO_SEC;
          float marginS = static_cast<float>(config_.speechPadMs) / 1000.0F;
          if (t1S + marginS < totalDurationS) {
            lastComplete = i;
          }
        }

        if (done && nSeg > 0) {
          lastComplete = nSeg - 1;
        }

        if (lastComplete >= 0) {
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
              "StreamingProcessor: VAD found " + std::to_string(nSeg) +
                  " segment(s), " + std::to_string(lastComplete + 1) +
                  " complete, totalDuration=" +
                  std::to_string(totalDurationS) + "s");

          for (int i = 0; i <= lastComplete; i++) {
            float t0S =
                whisper_vad_segments_get_segment_t0(segments.get(), i) *
                CS_TO_SEC;
            float t1S =
                whisper_vad_segments_get_segment_t1(segments.get(), i) *
                CS_TO_SEC;
            int startSample = std::max(
                0,
                static_cast<int>(
                    t0S * static_cast<float>(config_.sampleRate)));
            int endSample = std::min(
                static_cast<int>(
                    t1S * static_cast<float>(config_.sampleRate)),
                bufferSize);
            QLOG(
                qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
                "StreamingProcessor: segment " + std::to_string(i) +
                    " [" + std::to_string(t0S) + "s - " +
                    std::to_string(t1S) + "s] samples=[" +
                    std::to_string(startSample) + ", " +
                    std::to_string(endSample) + "]");
            if (endSample > startSample) {
              processAudioRange(startSample, endSample);
            }
          }

          float lastT1S =
              whisper_vad_segments_get_segment_t1(
                  segments.get(), lastComplete) *
              CS_TO_SEC;
          int trimPoint = std::min(
              static_cast<int>(
                  lastT1S * static_cast<float>(config_.sampleRate)),
              bufferSize);
          processBuffer_.erase(
              processBuffer_.begin(), processBuffer_.begin() + trimPoint);
          bufferSizeAtLastVadRun_ = 0;
        }
      }

      // Safety: force-process if buffer exceeds max even after VAD
      if (static_cast<int>(processBuffer_.size()) >=
          config_.maxBufferSamples) {
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
            "StreamingProcessor: buffer overflow, force-processing " +
                std::to_string(processBuffer_.size()) + " samples");
        processAudioRange(0, static_cast<int>(processBuffer_.size()));
        processBuffer_.clear();
        bufferSizeAtLastVadRun_ = 0;
      }
    }

    if (done) {
      break;
    }
  }

  {
    std::lock_guard lock(mtx_);
    if (cancelled_) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "StreamingProcessor: cancelled, queueing cancellation");
      outputQueue_->queueException(
          config_.jobId, std::runtime_error("Job cancelled"));
      return;
    }
  }

  // Process any remaining audio in the buffer
  if (!processBuffer_.empty()) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "StreamingProcessor: processing final buffer of " +
            std::to_string(processBuffer_.size()) + " samples");
    processAudioRange(0, static_cast<int>(processBuffer_.size()));
    processBuffer_.clear();
  }

  if (hasError_) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "StreamingProcessor: stream ended with errors");
    outputQueue_->queueException(
        config_.jobId,
        std::runtime_error(
            "StreamingProcessor: one or more segments failed during "
            "processing"));
  } else {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "StreamingProcessor: stream ended, queueing job completion");
    outputQueue_->queueJobEnded(config_.jobId);
  }
}

} // namespace qvac_lib_inference_addon_whisper
