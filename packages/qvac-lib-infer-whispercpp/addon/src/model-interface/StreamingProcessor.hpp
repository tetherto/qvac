#pragma once

#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <whisper.h>

#include "qvac-lib-inference-addon-cpp/queue/OutputQueue.hpp"

namespace qvac_lib_inference_addon_whisper {

class WhisperModel;

class StreamingProcessor {
public:
  struct Config {
    std::uint64_t jobId = 0;
    static constexpr int kDefaultSampleRate = 16000;
    static constexpr float kDefaultMaxSpeechDurationS = 30.0F;
    static constexpr float kVadRunIntervalS = 0.3F;

    int sampleRate = kDefaultSampleRate;
    std::string vadModelPath;
    float vadThreshold = 0.5F;
    int minSilenceDurationMs = 500;
    int minSpeechDurationMs = 250;
    float maxSpeechDurationS = kDefaultMaxSpeechDurationS;
    int speechPadMs = 30;
    float samplesOverlap = 0.1F;
    int maxBufferSamples =
        static_cast<int>(kDefaultMaxSpeechDurationS) * kDefaultSampleRate;
    int vadRunIntervalSamples =
        static_cast<int>(kVadRunIntervalS * kDefaultSampleRate);
  };

  StreamingProcessor(
      WhisperModel& model,
      std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue> outputQueue,
      Config config);

  ~StreamingProcessor();

  StreamingProcessor(const StreamingProcessor&) = delete;
  StreamingProcessor& operator=(const StreamingProcessor&) = delete;
  StreamingProcessor(StreamingProcessor&&) = delete;
  StreamingProcessor& operator=(StreamingProcessor&&) = delete;

  void appendAudio(std::vector<float>&& samples);
  void end();
  void cancel();

private:
  void processLoop();
  void processAudioRange(int startSample, int endSample);

  WhisperModel& model_;
  std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue> outputQueue_;
  Config config_;

  mutable std::mutex mtx_;
  std::condition_variable cv_;
  std::vector<float> pendingAudio_;
  std::vector<float> processBuffer_;
  bool ended_ = false;
  bool cancelled_ = false;
  bool hasError_ = false;

  whisper_vad_context* vadCtx_ = nullptr;
  int bufferSizeAtLastVadRun_ = 0;

  std::thread thread_;
};

} // namespace qvac_lib_inference_addon_whisper
