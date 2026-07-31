#pragma once

#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <whisper.h>

#include "addon/StreamingSessionRegistry.hpp"
#include "inference-addon-cpp/queue/OutputQueue.hpp"

namespace qvac::asrggml::whisper {

class WhisperModel;

struct VadStateUpdate {
  bool speaking = false;
  float probability = 0.0F;
};

struct EndOfTurnEvent {
  int silenceDurationMs = 0;
};

class StreamingProcessor : public qvac::asrggml::IStreamingSession {
public:
  struct Config {
    std::uint64_t jobId = 0;
    static constexpr int K_DEFAULT_SAMPLE_RATE = 16000;
    static constexpr float K_DEFAULT_MAX_SPEECH_DURATION_S = 30.0F;
    static constexpr float K_VAD_RUN_INTERVAL_S = 0.3F;

    int sampleRate = K_DEFAULT_SAMPLE_RATE;
    std::string vadModelPath;
    float vadThreshold = 0.5F;
    int minSilenceDurationMs = 500;
    int minSpeechDurationMs = 250;
    float maxSpeechDurationS = K_DEFAULT_MAX_SPEECH_DURATION_S;
    int speechPadMs = 30;
    float samplesOverlap = 0.1F;
    int maxBufferSamples = static_cast<int>(K_DEFAULT_MAX_SPEECH_DURATION_S) *
                           K_DEFAULT_SAMPLE_RATE;
    int vadRunIntervalSamples =
        static_cast<int>(K_VAD_RUN_INTERVAL_S * K_DEFAULT_SAMPLE_RATE);
    bool emitVadEvents = false;
    int endOfTurnSilenceMs = 0;
  };

  StreamingProcessor(
      WhisperModel& model,
      std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue> outputQueue,
      Config config);

  ~StreamingProcessor() override;

  StreamingProcessor(const StreamingProcessor&) = delete;
  StreamingProcessor& operator=(const StreamingProcessor&) = delete;
  StreamingProcessor(StreamingProcessor&&) = delete;
  StreamingProcessor& operator=(StreamingProcessor&&) = delete;

  void appendAudio(std::vector<float>&& samples) override;
  void end() override;
  void cancel() override;

  // Cumulative seconds of audio received so far. Used by endStreaming() to
  // populate the synthetic `JobEnded` stats object (audioDurationMs /
  // totalSamples). Only valid after end()/cancel() returned: both join
  // `thread_` first, so reading totalSamplesReceived_ is race-free.
  double audioSeconds() const override {
    return static_cast<double>(totalSamplesReceived_) /
           static_cast<double>(config_.sampleRate);
  }
  int sampleRate() const override { return config_.sampleRate; }

private:
  void processLoop();
  whisper_vad_params buildVadParams() const;
  float speechPadSeconds() const;
  float segmentEndSeconds(whisper_vad_segments* segments, int index) const;
  int secondsToSample(float seconds) const;
  bool hasEnoughNewAudioForVad(int bufferSize, bool done) const;
  void drainPendingAudio(bool& done, bool& wasCancelled);
  void runVadSegmentation(const whisper_vad_params& vadParams, bool done);
  void updateSpeakingState(
      whisper_vad_segments* segments, int nSeg, float totalDurationS,
      int bufferSize);
  int findLastCompleteSegment(
      whisper_vad_segments* segments, int nSeg, float totalDurationS,
      bool done) const;
  void dispatchCompleteSegments(
      whisper_vad_segments* segments, int lastComplete, int bufferSize);
  void trimProcessedAudio(
      whisper_vad_segments* segments, int lastComplete, int bufferSize);
  void forceProcessOnOverflow();
  void finalizeStream();
  void processAudioRange(int startSample, int endSample);
  void emitConversationEvents(bool speaking, float probability);

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
  std::int64_t totalSamplesReceived_ = 0;
  std::int64_t processBufferStartSample_ = 0;
  std::int64_t lastSpeechEndSample_ = 0;
  bool hasSeenSpeech_ = false;
  bool wasSpeaking_ = false;
  std::int64_t silenceStartSample_ = 0;
  bool endOfTurnEmitted_ = false;

  std::thread thread_;
};

} // namespace qvac::asrggml::whisper
