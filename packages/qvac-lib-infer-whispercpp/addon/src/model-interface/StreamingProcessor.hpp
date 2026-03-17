#pragma once

#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <whisper.h>

#include "qvac-lib-inference-addon-cpp/queue/OutputQueue.hpp"

namespace qvac_lib_inference_addon_whisper {

namespace model = qvac_lib_inference_addon_cpp::model;

class WhisperModel;

class StreamingProcessor {
public:
  struct Config {
    int sampleRate = 16000;
    std::string vadModelPath;
    float vadThreshold = 0.5F;
    int minSilenceDurationMs = 500;
    int minSpeechDurationMs = 250;
    float maxSpeechDurationS = 30.0F;
    int speechPadMs = 30;
    float samplesOverlap = 0.1F;
    int maxBufferSamples = 480000; // 30s safety cap
    int vadRunIntervalSamples = 4800; // run VAD every ~300ms of new audio
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
  void processAudioRange(int startSample, int endSample);

  model::IModel& model_;
  std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue> outputQueue_;
  Config config_;

  mutable std::mutex mtx_;
  std::condition_variable cv_;
  std::vector<float> pendingAudio_;
  std::vector<float> processBuffer_;
  bool ended_ = false;

  whisper_vad_context* vadCtx_ = nullptr;
  int bufferSizeAtLastVadRun_ = 0;

  std::thread thread_;
};

} // namespace qvac_lib_inference_addon_whisper
