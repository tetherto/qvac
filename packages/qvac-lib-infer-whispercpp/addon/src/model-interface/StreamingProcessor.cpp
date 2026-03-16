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
      config_(std::move(config)),
      calibrationRemaining_(config_.calibrationSamples),
      activeThreshold_(config_.energyThreshold) {
  calibrationEnergies_.reserve(
      config_.calibrationSamples / config_.energyWindowSamples + 1);
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

void StreamingProcessor::finalizeCalibration() {
  calibrated_ = true;

  if (calibrationEnergies_.empty()) {
    activeThreshold_ = config_.energyThreshold;
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "StreamingProcessor: calibration empty, using default threshold " +
            std::to_string(activeThreshold_));
    return;
  }

  std::sort(calibrationEnergies_.begin(), calibrationEnergies_.end());
  size_t idx = calibrationEnergies_.size() / 4; // 25th percentile
  float noiseFloor = calibrationEnergies_[idx];

  float adaptive = noiseFloor * config_.speechMultiplier;
  activeThreshold_ = std::max(config_.energyThreshold, adaptive);
  activeThreshold_ = std::min(activeThreshold_, config_.maxThreshold);

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: calibrated noiseFloor=" +
          std::to_string(noiseFloor) +
          " threshold=" + std::to_string(activeThreshold_) +
          " (from " + std::to_string(calibrationEnergies_.size()) +
          " samples, min=" +
          std::to_string(calibrationEnergies_.front()) +
          " max=" +
          std::to_string(calibrationEnergies_.back()) + ")");

  calibrationEnergies_.clear();
  calibrationEnergies_.shrink_to_fit();
}

void StreamingProcessor::appendAudio(std::vector<float>&& samples) {
  {
    std::lock_guard lock(mtx_);
    if (ended_) {
      return;
    }

    int numSamples = static_cast<int>(samples.size());

    pendingAudio_.insert(
        pendingAudio_.end(), samples.begin(), samples.end());

    int totalSize = static_cast<int>(pendingAudio_.size());
    int windowStart = std::max(0, totalSize - config_.energyWindowSamples);
    int windowLen = totalSize - windowStart;
    float energy =
        computeEnergy(pendingAudio_.data() + windowStart, windowLen);

    if (!calibrated_) {
      calibrationEnergies_.push_back(energy);
      calibrationRemaining_ -= numSamples;
      if (calibrationRemaining_ <= 0) {
        finalizeCalibration();
      }
    } else {
      if (energy > activeThreshold_) {
        inSpeech_ = true;
        silenceSamples_ = 0;
      } else {
        silenceSamples_ += numSamples;
      }
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

bool StreamingProcessor::shouldProcessLocked() const {
  int totalSamples = static_cast<int>(processBuffer_.size());
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
    bool doProcess = false;
    bool done = false;

    {
      std::unique_lock lock(mtx_);
      cv_.wait(lock, [this]() {
        return ended_ || !pendingAudio_.empty();
      });

      processBuffer_.insert(
          processBuffer_.end(), pendingAudio_.begin(), pendingAudio_.end());
      pendingAudio_.clear();

      doProcess = shouldProcessLocked();

      if (doProcess) {
        inSpeech_ = false;
        silenceSamples_ = 0;
      }

      done = ended_ && pendingAudio_.empty();
    }

    if (doProcess) {
      processCurrentBuffer();
    }

    if (done) {
      break;
    }
  }

  if (!processBuffer_.empty()) {
    float energy = computeEnergy(
        processBuffer_.data(), static_cast<int>(processBuffer_.size()));
    if (energy > activeThreshold_ &&
        static_cast<int>(processBuffer_.size()) >= config_.minSpeechSamples) {
      processCurrentBuffer();
    } else {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "StreamingProcessor: discarding final buffer (energy=" +
              std::to_string(energy) + " threshold=" +
              std::to_string(activeThreshold_) + ")");
      processBuffer_.clear();
    }
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "StreamingProcessor: stream ended, queueing job completion");
  outputQueue_->queueJobEnded();
}

} // namespace qvac_lib_inference_addon_whisper
