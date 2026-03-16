#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

#include "qvac-lib-inference-addon-cpp/queue/OutputQueue.hpp"

namespace qvac_lib_inference_addon_whisper {

namespace model = qvac_lib_inference_addon_cpp::model;

class WhisperModel;

class StreamingProcessor {
public:
  struct Config {
    int sampleRate = 16000;
    float energyThreshold = 0.02F;
    int minSilenceSamples = 8000;    // 500ms at 16kHz
    int minSpeechSamples = 4000;     // 250ms at 16kHz
    int maxBufferSamples = 480000;   // 30s at 16kHz
    int energyWindowSamples = 1600;  // 100ms RMS window
    int calibrationSamples = 32000;  // 2s noise-floor calibration
    float speechMultiplier = 3.0F;   // threshold = noiseFloor * this
    float maxThreshold = 0.10F;      // safety cap
  };

  StreamingProcessor(
      model::IModel& model,
      std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue> outputQueue,
      Config config);

  ~StreamingProcessor();

  StreamingProcessor(const StreamingProcessor&) = delete;
  StreamingProcessor& operator=(const StreamingProcessor&) = delete;
  StreamingProcessor(StreamingProcessor&&) = delete;
  StreamingProcessor& operator=(StreamingProcessor&&) = delete;

  void appendAudio(std::vector<float>&& samples);
  void end();

private:
  void processLoop();
  bool shouldProcessLocked() const;
  void processCurrentBuffer();
  void finalizeCalibration();
  static float computeEnergy(const float* data, int n);

  model::IModel& model_;
  std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue> outputQueue_;
  Config config_;

  mutable std::mutex mtx_;
  std::condition_variable cv_;
  std::vector<float> pendingAudio_;
  std::vector<float> processBuffer_;
  bool ended_ = false;

  bool inSpeech_ = false;
  int silenceSamples_ = 0;

  int calibrationRemaining_;
  bool calibrated_ = false;
  float activeThreshold_;
  std::vector<float> calibrationEnergies_;

  std::thread thread_;
};

} // namespace qvac_lib_inference_addon_whisper
