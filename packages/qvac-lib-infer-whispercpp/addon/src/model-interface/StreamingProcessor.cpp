#include "StreamingProcessor.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "whisper.cpp/WhisperModel.hpp"

namespace qvac_lib_inference_addon_whisper {

StreamingProcessor::StreamingProcessor(
    model::IModel& model,
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
    pendingAudio_.insert(pendingAudio_.end(), samples.begin(), samples.end());
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
    std::any result =
        model_.process(std::any(WhisperModel::Input(std::move(segment))));
    if (result.has_value()) {
      const auto* transcripts =
          std::any_cast<WhisperModel::Output>(&result);
      if (transcripts != nullptr && !transcripts->empty()) {
        outputQueue_->queueResult(std::move(result));
      }
    }
  } catch (const std::exception& e) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        std::string("StreamingProcessor: processing error: ") + e.what());
  }
}

void StreamingProcessor::processLoop() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: thread started (VAD-based segmentation)");

  whisper_vad_params vadParams = whisper_vad_default_params();
  vadParams.threshold = config_.vadThreshold;
  vadParams.min_speech_duration_ms = config_.minSpeechDurationMs;
  vadParams.min_silence_duration_ms = config_.minSilenceDurationMs;
  vadParams.max_speech_duration_s = config_.maxSpeechDurationS;
  vadParams.speech_pad_ms = config_.speechPadMs;
  vadParams.samples_overlap = config_.samplesOverlap;

  while (true) {
    bool done = false;

    {
      std::unique_lock lock(mtx_);
      cv_.wait(lock, [this]() {
        return ended_ || !pendingAudio_.empty();
      });

      processBuffer_.insert(
          processBuffer_.end(), pendingAudio_.begin(), pendingAudio_.end());
      pendingAudio_.clear();

      done = ended_ && pendingAudio_.empty();
    }

    int bufferSize = static_cast<int>(processBuffer_.size());

    // Only run VAD when enough new audio has arrived since the last run
    bool shouldRunVad =
        (bufferSize - bufferSizeAtLastVadRun_) >=
            config_.vadRunIntervalSamples ||
        done;

    if (shouldRunVad && bufferSize > 0) {
      bufferSizeAtLastVadRun_ = bufferSize;

      whisper_vad_segments* segments = whisper_vad_segments_from_samples(
          vadCtx_, vadParams, processBuffer_.data(), bufferSize);

      if (segments != nullptr) {
        int nSeg = whisper_vad_segments_n_segments(segments);
        float totalDurationS =
            static_cast<float>(bufferSize) /
            static_cast<float>(config_.sampleRate);

        // whisper_vad timestamps are in centiseconds (cs); convert to seconds
        constexpr float CS_TO_SEC = 0.01F;

        // Find the last "complete" segment: one where t1 is well before the
        // end of the buffer, meaning confirmed silence follows it.
        int lastComplete = -1;
        for (int i = 0; i < nSeg; i++) {
          float t1S =
              whisper_vad_segments_get_segment_t1(segments, i) * CS_TO_SEC;
          float marginS = static_cast<float>(config_.speechPadMs) / 1000.0F;
          if (t1S + marginS < totalDurationS) {
            lastComplete = i;
          }
        }

        // When stream ended, treat ALL segments as complete
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
                whisper_vad_segments_get_segment_t0(segments, i) * CS_TO_SEC;
            float t1S =
                whisper_vad_segments_get_segment_t1(segments, i) * CS_TO_SEC;
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
              whisper_vad_segments_get_segment_t1(segments, lastComplete) *
              CS_TO_SEC;
          int trimPoint = std::min(
              static_cast<int>(
                  lastT1S * static_cast<float>(config_.sampleRate)),
              bufferSize);
          processBuffer_.erase(
              processBuffer_.begin(), processBuffer_.begin() + trimPoint);
          bufferSizeAtLastVadRun_ = 0;
        }

        whisper_vad_free_segments(segments);
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

  // Process any remaining audio in the buffer
  if (!processBuffer_.empty()) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "StreamingProcessor: processing final buffer of " +
            std::to_string(processBuffer_.size()) + " samples");
    processAudioRange(0, static_cast<int>(processBuffer_.size()));
    processBuffer_.clear();
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: stream ended, queueing job completion");
  outputQueue_->queueJobEnded();
}

} // namespace qvac_lib_inference_addon_whisper
