#include "StreamingProcessor.hpp"

#include <algorithm>
#include <cmath>

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
}

void StreamingProcessor::appendAudio(std::vector<float>&& samples) {
  {
    std::lock_guard lock(mtx_);
    if (ended_) {
      return;
    }

    int windowStart = std::max(
        0,
        static_cast<int>(pendingAudio_.size()) +
            static_cast<int>(samples.size()) - config_.energyWindowSamples);

    pendingAudio_.insert(
        pendingAudio_.end(), samples.begin(), samples.end());

    int totalSize = static_cast<int>(pendingAudio_.size());
    windowStart = std::max(0, totalSize - config_.energyWindowSamples);
    int windowLen = totalSize - windowStart;
    float energy =
        computeEnergy(pendingAudio_.data() + windowStart, windowLen);

    if (energy > config_.energyThreshold) {
      inSpeech_ = true;
      silenceSamples_ = 0;
    } else {
      silenceSamples_ += static_cast<int>(samples.size());
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

bool StreamingProcessor::shouldProcess() const {
  int totalSamples =
      static_cast<int>(processBuffer_.size() + pendingAudio_.size());
  if (totalSamples < config_.minSpeechSamples) {
    return false;
  }

  bool silenceAfterSpeech =
      inSpeech_ && silenceSamples_ >= config_.minSilenceSamples;
  bool bufferOverflow = totalSamples >= config_.maxBufferSamples;

  return silenceAfterSpeech || bufferOverflow;
}

float StreamingProcessor::computeEnergy(const float* data, int n) {
  if (n <= 0) {
    return 0.0F;
  }
  float sum = 0.0F;
  for (int i = 0; i < n; i++) {
    sum += data[i] * data[i];
  }
  return std::sqrt(sum / static_cast<float>(n));
}

void StreamingProcessor::processCurrentBuffer() {
  if (processBuffer_.empty()) {
    return;
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: processing " +
          std::to_string(processBuffer_.size()) + " samples (" +
          std::to_string(
              static_cast<double>(processBuffer_.size()) /
              static_cast<double>(config_.sampleRate)) +
          "s)");

  try {
    std::any result =
        model_.process(std::any(WhisperModel::Input(processBuffer_)));
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

  processBuffer_.clear();
}

void StreamingProcessor::processLoop() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: thread started");

  while (true) {
    {
      std::unique_lock lock(mtx_);
      cv_.wait(lock, [this]() {
        return ended_ || !pendingAudio_.empty();
      });

      processBuffer_.insert(
          processBuffer_.end(), pendingAudio_.begin(), pendingAudio_.end());
      pendingAudio_.clear();
    }

    if (shouldProcess()) {
      processCurrentBuffer();
      {
        std::lock_guard lock(mtx_);
        inSpeech_ = false;
        silenceSamples_ = 0;
      }
    }

    {
      std::lock_guard lock(mtx_);
      if (ended_ && pendingAudio_.empty()) {
        processBuffer_.insert(
            processBuffer_.end(), pendingAudio_.begin(), pendingAudio_.end());
        pendingAudio_.clear();
        break;
      }
    }
  }

  processCurrentBuffer();

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: stream ended, queueing job completion");
  outputQueue_->queueJobEnded();
}

} // namespace qvac_lib_inference_addon_whisper
