// speech-cpp capabilities surfaced by the Parakeet binding: every
// ParakeetConfig key must reach its speech-cpp option struct, stream events
// must map onto VadEvent, and the structured diarization / backend fields
// must be populated. The model-backed cases run only when QVAC_TEST_GGUF
// points at a Parakeet ASR GGUF.

#include <any>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <future>
#include <limits>
#include <sstream>
#include <string>
#include <thread>
#include <variant>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/ParakeetStreamingProcessor.hpp"
#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/parakeet/AttributedTranscription.hpp"
#include "model-interface/parakeet/ParakeetConfig.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"

using namespace qvac::asrggml::parakeet;

namespace {

// What the addon sent before these keys existed: 0.641 and
// static_cast<int>(0.511F * 1000.0F), i.e. 510.
constexpr float ADDON_DIARIZATION_THRESHOLD = 0.641F;
constexpr int ADDON_DIARIZATION_MIN_SEGMENT_MS = 510;
constexpr int SAMPLE_RATE_HZ = 16000;

bool hasStat(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) {
  for (const auto& [name, value] : stats) {
    if (name == key)
      return true;
  }
  return false;
}

std::string ggufTestPath() {
  const char* env = std::getenv("QVAC_TEST_GGUF");
  return env != nullptr ? env : "";
}

class PendingOutputCallback
    : public qvac_lib_inference_addon_cpp::OutputCallBackInterface {
public:
  void initializeProcessingThread(
      std::shared_ptr<qvac_lib_inference_addon_cpp::OutputQueue>) override {}
  void notify() override {}
  void stop() override {}
};

using StreamUpdate = std::variant<Transcript, EndOfTurnEvent>;

void checkTurnSequence(const std::vector<StreamUpdate>& updates) {
  const Transcript* lastSegment = nullptr;
  int turns = 0;
  std::string text;
  for (const auto& update : updates) {
    if (const auto* segment = std::get_if<Transcript>(&update)) {
      lastSegment = segment;
      text += segment->text;
      EXPECT_FALSE(segment->text.starts_with("[")) << segment->text;
    } else {
      const auto& boundary = std::get<EndOfTurnEvent>(update);
      ASSERT_NE(lastSegment, nullptr);
      EXPECT_EQ(lastSegment->chunkIndex, boundary.chunkIndex);
      EXPECT_TRUE(lastSegment->isEndOfTurn);
      EXPECT_FALSE(text.empty());
      text.clear();
      ++turns;
    }
  }
  EXPECT_GT(turns, 0);
}

void appendStreamUpdates(
    const std::vector<std::pair<qvac_lib_inference_addon_cpp::JobId, std::any>>&
        output,
    std::vector<StreamUpdate>& updates) {
  for (const auto& entry : output) {
    if (const auto* segments =
            std::any_cast<std::vector<Transcript>>(&entry.second)) {
      updates.insert(updates.end(), segments->begin(), segments->end());
    } else if (
        const auto* boundary = std::any_cast<EndOfTurnEvent>(&entry.second)) {
      updates.emplace_back(*boundary);
    }
  }
}

// s16le mono 16 kHz PCM from the repo's example clips, as float samples.
std::vector<float> readRawPcm(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  std::vector<uint8_t> bytes(
      (std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  return ParakeetModel::preprocessAudioData(bytes);
}

std::filesystem::path longSpanishClip() {
  return "../../../examples/parakeet-samples/LastQuestion_long_ES.raw";
}

ParakeetConfig modelConfig() {
  ParakeetConfig cfg;
  cfg.modelPath = ggufTestPath();
  cfg.maxThreads = 4;
  cfg.useGPU = false;
  return cfg;
}

} // namespace

// ── EngineOptions ──────────────────────────────────────────────────────────

TEST(ParakeetEngineOptions, DefaultsMatchSpeechCpp) {
  const pkt::EngineOptions fabric;
  const pkt::EngineOptions built =
      ParakeetModel::buildEngineOptions(ParakeetConfig{}, "model.gguf");
  EXPECT_EQ(built.prewarm, fabric.prewarm);
  EXPECT_FLOAT_EQ(built.prewarm_audio_seconds, fabric.prewarm_audio_seconds);
  EXPECT_EQ(built.long_form_window_frames, fabric.long_form_window_frames);
  EXPECT_EQ(built.long_form_context_frames, fabric.long_form_context_frames);
  EXPECT_EQ(built.backend, fabric.backend);
}

TEST(
    ParakeetStreamingOrdering,
    FrameworkDeliversTranscriptBeforeBoundaryWithoutRepeatingOutput) {
  const char* modelPath = std::getenv("QVAC_TEST_EOU_GGUF");
  const char* audioPath = std::getenv("QVAC_TEST_AUDIO_PCM");
  if (modelPath == nullptr || audioPath == nullptr) {
    GTEST_SKIP() << "Set QVAC_TEST_EOU_GGUF and QVAC_TEST_AUDIO_PCM";
  }
  const auto audio = readRawPcm(audioPath);
  ASSERT_FALSE(audio.empty());
  for (const bool callbackDelivery : {false, true}) {
    ParakeetConfig config;
    config.modelPath = modelPath;
    config.backend = "cpu";
    config.streaming = true;
    ParakeetModel model(config);
    std::vector<StreamUpdate> updates;
    const auto recordSegment = [&](const Transcript& segment) {
      updates.emplace_back(segment);
    };
    if (callbackDelivery)
      model.setOnStreamingSegmentCallback(recordSegment);
    else
      model.setOnSegmentCallback(recordSegment);
    model.setOnEndOfTurnCallback(
        [&](const EndOfTurnEvent& event) { updates.emplace_back(event); });
    model.load();
    const auto result =
        std::any_cast<ParakeetModel::Output>(model.process(std::any(audio)));
    EXPECT_EQ(result.empty(), callbackDelivery);
    checkTurnSequence(updates);
  }
}

TEST(
    ParakeetStreamingOrdering,
    DuplexQueuesTranscriptBeforeBoundaryAndTerminalStats) {
  const char* modelPath = std::getenv("QVAC_TEST_EOU_GGUF");
  const char* audioPath = std::getenv("QVAC_TEST_AUDIO_PCM");
  if (modelPath == nullptr || audioPath == nullptr) {
    GTEST_SKIP() << "Set QVAC_TEST_EOU_GGUF and QVAC_TEST_AUDIO_PCM";
  }
  auto audio = readRawPcm(audioPath);
  ASSERT_FALSE(audio.empty());
  ParakeetConfig config;
  config.modelPath = modelPath;
  config.backend = "cpu";
  ParakeetModel model(config);
  model.load();
  PendingOutputCallback callback;
  auto queue = std::make_shared<qvac_lib_inference_addon_cpp::OutputQueue>(
      callback, model);
  ParakeetStreamingProcessor::Config streaming;
  ParakeetStreamingProcessor processor(model, queue, streaming);
  processor.appendAudio(std::move(audio));
  processor.end();
  const auto output = queue->clear();
  ASSERT_FALSE(output.empty());
  EXPECT_NE(
      std::any_cast<qvac_lib_inference_addon_cpp::RuntimeStats>(
          &output.back().second),
      nullptr);
  std::vector<StreamUpdate> updates;
  appendStreamUpdates(output, updates);
  checkTurnSequence(updates);
}

TEST(ParakeetEngineOptions, ExplicitSelectorsAreIndependentOfGpuPreference) {
  for (const std::string backend :
       {"cpu",
        "metal",
        "cuda",
        "vulkan",
        "opencl",
        "webgpu",
        "hexagon",
        "CUDA1",
        "MTL0",
        "HTP0",
        "unknown-device"}) {
    for (const bool useGpu : {false, true}) {
      ParakeetConfig config;
      config.backend = backend;
      config.useGPU = useGpu;
      const auto options =
          ParakeetModel::buildEngineOptions(config, "asr.gguf");
      EXPECT_EQ(options.backend, backend);
      EXPECT_EQ(options.n_gpu_layers > 0, useGpu);
    }
  }
}

TEST(ParakeetAttribution, OmittedOptionsKeepNativeDefaults) {
  const pkt::AttributedTranscriptionOptions native;
  const auto options = ParakeetModel::buildAttributionOptions(ParakeetConfig{});
  EXPECT_EQ(options.merge_same_speaker, native.merge_same_speaker);
  EXPECT_EQ(options.min_segment_ms, native.min_segment_ms);
  EXPECT_EQ(options.pad_segment_ms, native.pad_segment_ms);
  EXPECT_FLOAT_EQ(options.diarization.threshold, native.diarization.threshold);
  EXPECT_EQ(
      options.diarization.min_segment_ms, native.diarization.min_segment_ms);
}

TEST(ParakeetAttribution, CancellationAfterDiarizationPreventsAsrCalls) {
  std::vector<float> audio(100);
  bool cancelled = false;
  int asrCalls = 0;
  AttributedTranscription transcription(
      audio,
      100,
      {},
      [&] {
        cancelled = true;
        pkt::DiarizationResult result;
        result.segments = {{0, 0.0, 1.0}};
        return result;
      },
      [&](std::span<const float>) {
        ++asrCalls;
        return "text";
      },
      [&] {
        if (cancelled)
          throw std::runtime_error("cancelled");
      });
  EXPECT_THROW(transcription.run(), std::runtime_error);
  EXPECT_EQ(asrCalls, 0);
}

TEST(ParakeetAttribution, CancellationDuringFirstAsrTurnPreventsLaterTurns) {
  std::vector<float> audio(100);
  bool cancelled = false;
  int asrCalls = 0;
  AttributedTranscription transcription(
      audio,
      100,
      {},
      [] {
        pkt::DiarizationResult result;
        result.segments = {{0, 0.0, 0.3}, {1, 0.3, 0.6}, {0, 0.6, 1.0}};
        return result;
      },
      [&](std::span<const float>) {
        ++asrCalls;
        cancelled = true;
        return "text";
      },
      [&] {
        if (cancelled)
          throw std::runtime_error("cancelled");
      });
  EXPECT_THROW(transcription.run(), std::runtime_error);
  EXPECT_EQ(asrCalls, 1);
}

TEST(ParakeetAttribution, PaddingIsClampedAndShortTurnsRespectMinimumDuration) {
  std::vector<float> audio(100);
  pkt::AttributedTranscriptionOptions options;
  options.pad_segment_ms = 100;
  options.min_segment_ms = 150;
  int asrCalls = 0;
  AttributedTranscription transcription(
      audio,
      100,
      options,
      [] {
        pkt::DiarizationResult result;
        result.segments = {
            {0, 0.0, 0.01}, {1, 0.1, 0.3}, {1, 0.6, 0.9}, {2, 0.9, 1.0}};
        return result;
      },
      [&](std::span<const float> slice) {
        EXPECT_GE(slice.data(), audio.data());
        EXPECT_LE(slice.data() + slice.size(), audio.data() + audio.size());
        ++asrCalls;
        return "turn";
      },
      [] {});
  const auto result = transcription.run();
  EXPECT_EQ(asrCalls, 3);
  ASSERT_EQ(result.segments.size(), 2U);
  EXPECT_EQ(result.segments[0].speaker_id, 1);
  EXPECT_EQ(result.segments[0].text, "turn turn");
  EXPECT_DOUBLE_EQ(result.segments[0].start_s, 0.1);
  EXPECT_DOUBLE_EQ(result.segments[0].end_s, 0.9);
}

TEST(ParakeetAttribution, NegativeDurationsAreRejectedAtTheNativeBoundary) {
  ParakeetConfig config;
  config.speakerAttribution =
      SpeakerAttributionConfig{"diarizer.gguf", false, -1, 0};
  EXPECT_THROW(ParakeetModel model(config), std::exception);
  config.speakerAttribution->minSegmentMs = 0;
  config.speakerAttribution->padSegmentMs = -1;
  EXPECT_THROW(ParakeetModel model(config), std::exception);
}

TEST(ParakeetAttribution, ExplicitFalseAndZeroAreNotTreatedAsUnset) {
  ParakeetConfig config;
  config.speakerAttribution =
      SpeakerAttributionConfig{"diarizer.gguf", false, 0, 0};
  config.diarizationThreshold = 0.3F;
  config.diarizationMinSegmentMs = 0;
  const auto options = ParakeetModel::buildAttributionOptions(config);
  EXPECT_FALSE(options.merge_same_speaker);
  EXPECT_EQ(options.min_segment_ms, 0);
  EXPECT_EQ(options.pad_segment_ms, 0);
  EXPECT_FLOAT_EQ(options.diarization.threshold, 0.3F);
  EXPECT_EQ(options.diarization.min_segment_ms, 0);
}

TEST(ParakeetAttribution, NativeSegmentTextSpeakersAndTimesArePreserved) {
  pkt::AttributedTranscriptionResult result;
  result.segments = {
      {0, "First speaker.", 0.125, 1.5}, {1, "Second speaker.", 1.75, 3.0}};
  const auto mapped = ParakeetModel::toAttributedTranscripts(result, 4.0F);
  ASSERT_EQ(mapped.size(), 2U);
  EXPECT_EQ(mapped[0].text, "First speaker.");
  EXPECT_EQ(mapped[0].speakerId, 0);
  EXPECT_FLOAT_EQ(mapped[0].start, 4.125F);
  EXPECT_FLOAT_EQ(mapped[0].end, 5.5F);
  EXPECT_TRUE(mapped[0].toAppend);
  EXPECT_EQ(mapped[0].isFinal, true);
  EXPECT_EQ(mapped[1].text, "Second speaker.");
  EXPECT_EQ(mapped[1].speakerId, 1);
  EXPECT_FLOAT_EQ(mapped[1].start, 5.75F);
  EXPECT_FLOAT_EQ(mapped[1].end, 7.0F);
  EXPECT_TRUE(
      ParakeetModel::toAttributedTranscripts(
          pkt::AttributedTranscriptionResult{})
          .empty());
}

TEST(
    ParakeetAttribution,
    ConfigurationIdentityIncludesBackendAndEveryAttributionOption) {
  ParakeetConfig base;
  ParakeetConfig other = base;
  other.backend = "CUDA1";
  EXPECT_NE(base, other);
  base.speakerAttribution = SpeakerAttributionConfig{"diarizer.gguf"};
  EXPECT_NE(base, other);
  other = base;
  EXPECT_EQ(base, other);
  other.speakerAttribution->modelPath = "other.gguf";
  EXPECT_NE(base, other);
  other = base;
  other.speakerAttribution->mergeSameSpeaker = false;
  EXPECT_NE(base, other);
  other = base;
  other.speakerAttribution->minSegmentMs = 0;
  EXPECT_NE(base, other);
  other = base;
  other.speakerAttribution->padSegmentMs = 0;
  EXPECT_NE(base, other);
}

TEST(ParakeetAttribution, StreamingAndMissingDiarizerPathAreRejected) {
  ParakeetConfig config;
  config.speakerAttribution = SpeakerAttributionConfig{};
  EXPECT_THROW(ParakeetModel model(config), std::exception);
  config.speakerAttribution->modelPath = "diarizer.gguf";
  config.streaming = true;
  EXPECT_THROW(ParakeetModel model(config), std::exception);
}

TEST(
    ParakeetAttribution, FailedSecondModelLoadDoesNotLeaveTheFirstModelLoaded) {
  const auto path = ggufTestPath();
  if (path.empty() || !std::filesystem::exists(path)) {
    GTEST_SKIP() << "Set QVAC_TEST_GGUF to a transcription model";
  }
  ParakeetConfig config;
  config.modelPath = path;
  config.backend = "cpu";
  config.speakerAttribution = SpeakerAttributionConfig{path + ".missing"};
  ParakeetModel model(config);
  EXPECT_THROW(model.load(), std::exception);
  EXPECT_FALSE(model.isLoaded());
  config.speakerAttribution.reset();
  model.setConfig(config);
  EXPECT_NO_THROW(model.load());
  EXPECT_TRUE(model.isLoaded());
}

TEST(ParakeetAttribution, AnAsrModelCannotBeUsedAsTheDiarizer) {
  const auto path = ggufTestPath();
  if (path.empty() || !std::filesystem::exists(path)) {
    GTEST_SKIP() << "Set QVAC_TEST_GGUF to a transcription model";
  }
  ParakeetConfig config;
  config.modelPath = path;
  config.backend = "cpu";
  config.speakerAttribution = SpeakerAttributionConfig{path};
  ParakeetModel model(config);
  EXPECT_THROW(model.load(), std::exception);
  EXPECT_FALSE(model.isLoaded());
}

TEST(ParakeetAttribution, RealPipelineMatchesNativeAttributedTranscription) {
  const char* diarizer = std::getenv("QVAC_TEST_DIARIZER_GGUF");
  const char* audioPath = std::getenv("QVAC_TEST_AUDIO_PCM");
  if (ggufTestPath().empty() || diarizer == nullptr || audioPath == nullptr) {
    GTEST_SKIP() << "Set QVAC_TEST_GGUF, QVAC_TEST_DIARIZER_GGUF and "
                    "QVAC_TEST_AUDIO_PCM";
  }
  const auto audio = readRawPcm(audioPath);
  ASSERT_FALSE(audio.empty());
  ParakeetConfig config = modelConfig();
  config.backend = "cpu";
  config.speakerAttribution = SpeakerAttributionConfig{diarizer, false, 0, 80};
  pkt::Engine nativeAsr(
      ParakeetModel::buildEngineOptions(config, config.modelPath));
  pkt::Engine nativeDiarizer(
      ParakeetModel::buildEngineOptions(config, diarizer));
  const auto native = pkt::transcribe_samples_with_speakers(
      nativeDiarizer,
      nativeAsr,
      audio.data(),
      static_cast<int>(audio.size()),
      SAMPLE_RATE_HZ,
      ParakeetModel::buildAttributionOptions(config));
  ASSERT_FALSE(native.segments.empty());
  ParakeetModel model(config);
  model.load();
  const auto output =
      std::any_cast<ParakeetModel::Output>(model.process(std::any(audio)));
  ASSERT_EQ(output.size(), native.segments.size());
  for (size_t index = 0; index < output.size(); ++index) {
    EXPECT_EQ(output[index].text, native.segments[index].text);
    EXPECT_EQ(output[index].speakerId, native.segments[index].speaker_id);
    EXPECT_FLOAT_EQ(
        output[index].start,
        static_cast<float>(native.segments[index].start_s));
    EXPECT_FLOAT_EQ(
        output[index].end, static_cast<float>(native.segments[index].end_s));
  }
}

TEST(
    ParakeetStreamingMetadata,
    AsrTokensFinalityChunkAndConfidenceArePreserved) {
  pkt::StreamingSegment segment;
  segment.text = "Hello.";
  segment.token_ids = {3, 5, 8};
  segment.start_s = 0.125;
  segment.end_s = 1.5;
  segment.chunk_index = 0;
  segment.is_final = false;
  segment.is_eou_boundary = true;
  segment.eot_confidence = 0.875F;
  const auto mapped = ParakeetModel::toStreamingTranscript(segment);
  EXPECT_EQ(mapped.text, segment.text);
  ASSERT_TRUE(mapped.tokenIds);
  EXPECT_EQ(*mapped.tokenIds, segment.token_ids);
  EXPECT_EQ(mapped.isFinal, false);
  EXPECT_EQ(mapped.chunkIndex, 0);
  EXPECT_EQ(mapped.eotConfidence, 0.875F);
  EXPECT_TRUE(mapped.isEndOfTurn);
  EXPECT_FLOAT_EQ(mapped.start, 0.125F);
  EXPECT_FLOAT_EQ(mapped.end, 1.5F);
  segment.text.clear();
  segment.token_ids.clear();
  segment.is_final = true;
  const auto terminal = ParakeetModel::toStreamingTranscript(segment);
  EXPECT_TRUE(terminal.text.empty());
  EXPECT_EQ(terminal.isFinal, true);
  ASSERT_TRUE(terminal.tokenIds);
  EXPECT_TRUE(terminal.tokenIds->empty());
}

TEST(
    ParakeetStreamingMetadata,
    DiarizationAndSyntheticFinalMarkersKeepFinality) {
  pkt::StreamingDiarizationSegment segment;
  segment.speaker_id = 2;
  segment.start_s = 1.0;
  segment.end_s = 2.0;
  segment.chunk_index = 3;
  const auto mapped = ParakeetModel::toStreamingDiarizationTranscript(segment);
  EXPECT_EQ(mapped.speakerId, 2);
  EXPECT_EQ(mapped.chunkIndex, 3);
  segment.speaker_id = -1;
  segment.is_final = true;
  const auto terminal =
      ParakeetModel::toStreamingDiarizationTranscript(segment);
  EXPECT_TRUE(terminal.text.empty());
  EXPECT_EQ(terminal.isFinal, true);
  EXPECT_EQ(terminal.speakerId, -1);
}

TEST(
    ParakeetStreamingMetadata,
    EndOfTurnPreservesDoublePrecisionAndZeroConfidence) {
  pkt::StreamEvent event;
  event.type = pkt::StreamEventType::EndOfTurn;
  event.timestamp_s = 12.123456789;
  event.chunk_index = 0;
  event.eot_confidence = 0.0F;
  const auto mapped = ParakeetModel::toEndOfTurnEvent(event);
  EXPECT_DOUBLE_EQ(mapped.timestamp, event.timestamp_s);
  EXPECT_EQ(mapped.chunkIndex, 0);
  EXPECT_FLOAT_EQ(mapped.confidence, 0.0F);
}

TEST(ParakeetEngineOptions, ForwardPrewarmAndLongForm) {
  ParakeetConfig cfg;
  cfg.prewarm = true;
  cfg.prewarmAudioSeconds = 2.5F;
  cfg.longFormWindowFrames = 750;
  cfg.longFormContextFrames = -1;
  const pkt::EngineOptions built =
      ParakeetModel::buildEngineOptions(cfg, "model.gguf");
  EXPECT_TRUE(built.prewarm);
  EXPECT_FLOAT_EQ(built.prewarm_audio_seconds, 2.5F);
  EXPECT_EQ(built.long_form_window_frames, 750);
  EXPECT_EQ(built.long_form_context_frames, -1);
  EXPECT_EQ(built.model_gguf_path, "model.gguf");
}

// ── Streaming options ──────────────────────────────────────────────────────

TEST(ParakeetStreamingOptions, EnergyVadDefaultsMatchSpeechCpp) {
  const pkt::StreamingOptions fabric;
  const pkt::StreamingOptions built =
      ParakeetModel::buildAsrStreamingOptions(ParakeetConfig{}, SAMPLE_RATE_HZ);
  EXPECT_FALSE(built.enable_energy_vad);
  EXPECT_FLOAT_EQ(
      built.energy_vad_threshold_db, fabric.energy_vad_threshold_db);
  EXPECT_EQ(built.energy_vad_window_ms, fabric.energy_vad_window_ms);
  EXPECT_EQ(built.energy_vad_hangover_ms, fabric.energy_vad_hangover_ms);
}

TEST(ParakeetStreamingOptions, ForwardEnergyVadTuning) {
  ParakeetConfig cfg;
  cfg.streamingEnergyVad = true;
  cfg.streamingEnergyVadThresholdDb = -48.0F;
  cfg.streamingEnergyVadWindowMs = 50;
  cfg.streamingEnergyVadHangoverMs = 400;
  const pkt::StreamingOptions built =
      ParakeetModel::buildAsrStreamingOptions(cfg, SAMPLE_RATE_HZ);
  EXPECT_TRUE(built.enable_energy_vad);
  EXPECT_FLOAT_EQ(built.energy_vad_threshold_db, -48.0F);
  EXPECT_EQ(built.energy_vad_window_ms, 50);
  EXPECT_EQ(built.energy_vad_hangover_ms, 400);
}

TEST(ParakeetStreamingOptions, EnergyVadFeedSliceIsOneRmsWindow) {
  EXPECT_EQ(
      ParakeetModel::energyVadFeedSliceSamples(false, 30, SAMPLE_RATE_HZ), 0U)
      << "energy VAD off: feed whole buffers";
  EXPECT_EQ(
      ParakeetModel::energyVadFeedSliceSamples(true, 30, SAMPLE_RATE_HZ), 480U);
  EXPECT_EQ(
      ParakeetModel::energyVadFeedSliceSamples(true, 0, SAMPLE_RATE_HZ), 16U)
      << "a zero window is floored at 1 ms";
  EXPECT_EQ(
      ParakeetModel::energyVadFeedSliceSamples(true, 5000, SAMPLE_RATE_HZ),
      16000U)
      << "capped at speech-cpp's 1 s RMS window, like the engine";
}

// ── Diarization options ────────────────────────────────────────────────────

TEST(ParakeetDiarizationOptions, DefaultsKeepAddonTuning) {
  const ParakeetConfig cfg;
  const pkt::DiarizationOptions offline =
      ParakeetModel::buildDiarizationOptions(cfg);
  EXPECT_FLOAT_EQ(offline.threshold, ADDON_DIARIZATION_THRESHOLD);
  EXPECT_EQ(offline.min_segment_ms, ADDON_DIARIZATION_MIN_SEGMENT_MS);

  const pkt::SortformerStreamingOptions streaming =
      ParakeetModel::buildSortformerStreamingOptions(cfg, SAMPLE_RATE_HZ);
  EXPECT_FLOAT_EQ(streaming.threshold, ADDON_DIARIZATION_THRESHOLD);
  EXPECT_EQ(streaming.min_segment_ms, ADDON_DIARIZATION_MIN_SEGMENT_MS);

  const ParakeetModel model(cfg);
  EXPECT_FLOAT_EQ(model.getDiarizationThreshold(), ADDON_DIARIZATION_THRESHOLD);
  EXPECT_EQ(
      model.getDiarizationMinSegmentMs(), ADDON_DIARIZATION_MIN_SEGMENT_MS);
}

TEST(ParakeetDiarizationOptions, OverridesReachOfflineAndStreaming) {
  ParakeetConfig cfg;
  cfg.diarizationThreshold = 0.3F;
  // 0 is a real value (no minimum), not "unset".
  cfg.diarizationMinSegmentMs = 0;
  const pkt::DiarizationOptions offline =
      ParakeetModel::buildDiarizationOptions(cfg);
  EXPECT_FLOAT_EQ(offline.threshold, 0.3F);
  EXPECT_EQ(offline.min_segment_ms, 0);

  const pkt::SortformerStreamingOptions streaming =
      ParakeetModel::buildSortformerStreamingOptions(cfg, SAMPLE_RATE_HZ);
  EXPECT_FLOAT_EQ(streaming.threshold, 0.3F);
  EXPECT_EQ(streaming.min_segment_ms, 0);
}

// ── Stream events ──────────────────────────────────────────────────────────

TEST(ParakeetVadEvents, VadStateChangesMapOntoVadEvent) {
  pkt::StreamEvent speaking;
  speaking.type = pkt::StreamEventType::VadStateChanged;
  speaking.vad_state = pkt::VadState::Speaking;
  speaking.vad_score = 0.87F;
  speaking.timestamp_s = 4.25;
  speaking.speaker_id = 2;
  speaking.chunk_index = 3;

  auto event = ParakeetModel::toVadEvent(speaking, VadSource::Sortformer);
  ASSERT_TRUE(event.has_value());
  EXPECT_TRUE(event->speaking);
  EXPECT_FLOAT_EQ(event->score, 0.87F);
  EXPECT_DOUBLE_EQ(event->timestamp, 4.25);
  EXPECT_EQ(event->speakerId, 2);
  EXPECT_EQ(event->chunkIndex, 3);
  EXPECT_EQ(event->source, VadSource::Sortformer);

  pkt::StreamEvent silent;
  silent.type = pkt::StreamEventType::VadStateChanged;
  silent.vad_state = pkt::VadState::Silent;
  silent.vad_score = 0.004F;
  auto quiet = ParakeetModel::toVadEvent(silent, VadSource::Energy);
  ASSERT_TRUE(quiet.has_value());
  EXPECT_FALSE(quiet->speaking);
  EXPECT_EQ(quiet->speakerId, -1);
  EXPECT_EQ(quiet->source, VadSource::Energy);
}

TEST(ParakeetVadEvents, EndOfTurnAndUnknownStateAreDropped) {
  pkt::StreamEvent endOfTurn;
  endOfTurn.type = pkt::StreamEventType::EndOfTurn;
  endOfTurn.vad_state = pkt::VadState::Speaking;
  EXPECT_FALSE(
      ParakeetModel::toVadEvent(endOfTurn, VadSource::Energy).has_value());

  pkt::StreamEvent unknown;
  unknown.type = pkt::StreamEventType::VadStateChanged;
  unknown.vad_state = pkt::VadState::Unknown;
  EXPECT_FALSE(
      ParakeetModel::toVadEvent(unknown, VadSource::Energy).has_value());
}

// ── Config / output shape ──────────────────────────────────────────────────

TEST(ParakeetFabricConfig, EqualityCoversNewFields) {
  const ParakeetConfig base;
  auto differs = [&](auto mutate) {
    ParakeetConfig other = base;
    mutate(other);
    return other != base;
  };
  EXPECT_TRUE(differs([](ParakeetConfig& c) { c.prewarm = true; }));
  EXPECT_TRUE(differs([](ParakeetConfig& c) { c.prewarmAudioSeconds = 2.0F; }));
  EXPECT_TRUE(differs([](ParakeetConfig& c) { c.longFormWindowFrames = 1; }));
  EXPECT_TRUE(differs([](ParakeetConfig& c) { c.longFormContextFrames = 1; }));
  EXPECT_TRUE(
      differs([](ParakeetConfig& c) { c.diarizationThreshold = 0.5F; }));
  EXPECT_TRUE(
      differs([](ParakeetConfig& c) { c.diarizationMinSegmentMs = 0; }));
  EXPECT_TRUE(differs([](ParakeetConfig& c) { c.streamingSpeakerVad = true; }));
  EXPECT_TRUE(differs(
      [](ParakeetConfig& c) { c.streamingEnergyVadThresholdDb = -40.0F; }));
  EXPECT_TRUE(
      differs([](ParakeetConfig& c) { c.streamingEnergyVadWindowMs = 10; }));
  EXPECT_TRUE(
      differs([](ParakeetConfig& c) { c.streamingEnergyVadHangoverMs = 10; }));
}

TEST(ParakeetFabricConfig, ConstructorAndSetConfigRejectOutOfRangeValues) {
  auto rejects = [](auto mutate) {
    ParakeetConfig cfg;
    mutate(cfg);
    bool constructorThrew = false;
    try {
      const ParakeetModel model(cfg);
    } catch (const std::exception&) {
      constructorThrew = true;
    }
    ParakeetModel model{ParakeetConfig{}};
    bool setConfigThrew = false;
    try {
      model.setConfig(cfg);
    } catch (const std::exception&) {
      setConfigThrew = true;
    }
    return constructorThrew && setConfigThrew;
  };
  EXPECT_TRUE(
      rejects([](ParakeetConfig& c) { c.diarizationThreshold = 1.5F; }));
  EXPECT_TRUE(rejects(
      [](ParakeetConfig& c) { c.diarizationThreshold = std::nanf(""); }));
  EXPECT_TRUE(rejects([](ParakeetConfig& c) {
    c.prewarm = true;
    c.prewarmAudioSeconds = 0.0F;
  }));
  EXPECT_TRUE(rejects([](ParakeetConfig& c) {
    c.streamingEnergyVadThresholdDb = std::numeric_limits<float>::infinity();
  }));

  ParakeetConfig accepted;
  accepted.diarizationThreshold = -1.0F; // keeps the default
  accepted.prewarmAudioSeconds = 0.0F;   // inert while prewarm is off
  EXPECT_NO_THROW(ParakeetModel{accepted});
}

TEST(ParakeetFabricConfig, TranscriptHasNoSpeakerByDefault) {
  const Transcript transcript;
  EXPECT_EQ(transcript.speakerId, -1);
  EXPECT_TRUE(transcript.speakerSegments.empty());
}

TEST(ParakeetFabricConfig, AoscStatReportedOnlyForSortformer) {
  ParakeetConfig cfg;
  cfg.modelType = ModelType::SORTFORMER;
  EXPECT_TRUE(hasStat(ParakeetModel(cfg).runtimeStats(), "aoscActive"));
  cfg.modelType = ModelType::TDT;
  EXPECT_FALSE(hasStat(ParakeetModel(cfg).runtimeStats(), "aoscActive"));
}

TEST(ParakeetFabricConfig, ModelTypeNameEmptyBeforeLoad) {
  const ParakeetModel model(ParakeetConfig{});
  EXPECT_TRUE(model.getModelTypeName().empty());
}

// ── Model-backed (QVAC_TEST_GGUF) ──────────────────────────────────────────
// CI points QVAC_TEST_GGUF at a Sortformer GGUF, so the ASR cases skip on a
// diarization model and the Sortformer cases skip on an ASR model.

namespace {

std::filesystem::path englishClip() {
  return "../../../examples/parakeet-samples/sample.raw";
}

bool haveGguf() {
  return !ggufTestPath().empty() && std::filesystem::exists(ggufTestPath());
}

int64_t statValue(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) {
  for (const auto& [name, value] : stats) {
    if (name != key)
      continue;
    if (std::holds_alternative<int64_t>(value))
      return std::get<int64_t>(value);
    return static_cast<int64_t>(std::get<double>(value));
  }
  return -1;
}

} // namespace

TEST(ParakeetFabricModel, PrewarmLoadsAndReportsModelType) {
  if (!haveGguf()) {
    GTEST_SKIP() << "Set QVAC_TEST_GGUF to a parakeet GGUF to enable.";
  }
  ParakeetConfig cfg = modelConfig();
  cfg.prewarm = true;
  cfg.prewarmAudioSeconds = 0.5F;
  ParakeetModel model(cfg);
  ASSERT_NO_THROW(model.load());
  EXPECT_FALSE(model.getModelTypeName().empty());
  EXPECT_EQ(model.isSortformer(), model.getModelTypeName() == "sortformer");
}

TEST(ParakeetFabricModel, LongFormWindowStillTranscribes) {
  if (!haveGguf() || !std::filesystem::exists(longSpanishClip())) {
    GTEST_SKIP() << "Set QVAC_TEST_GGUF to a parakeet ASR GGUF to enable.";
  }
  std::vector<float> audio = readRawPcm(longSpanishClip());
  audio.resize(static_cast<size_t>(60 * SAMPLE_RATE_HZ));

  // 125 encoder frames = 10 s windows, so the clip needs several windows.
  ParakeetConfig cfg = modelConfig();
  cfg.longFormWindowFrames = 125;
  ParakeetModel model(cfg);
  ASSERT_NO_THROW(model.load());
  if (model.isSortformer()) {
    GTEST_SKIP() << "long-form windowing is an ASR encoder feature";
  }
  auto out =
      std::any_cast<ParakeetModel::Output>(model.process(std::any(audio)));
  ASSERT_EQ(out.size(), 1U);
  EXPECT_GT(out[0].text.size(), 200U) << out[0].text;
}

TEST(ParakeetFabricModel, CancelStopsOfflineTranscriptionMidCall) {
  if (!haveGguf() || !std::filesystem::exists(longSpanishClip())) {
    GTEST_SKIP() << "Set QVAC_TEST_GGUF to a parakeet ASR GGUF to enable.";
  }
  // 300 s stays under speech-cpp's 4096-encoder-frame offline decode limit.
  std::vector<float> audio = readRawPcm(longSpanishClip());
  audio.resize(static_cast<size_t>(300 * SAMPLE_RATE_HZ));

  // 30 encoder passes of 10 s each. Before engine cancel was wired, cancel()
  // only took effect once the whole call had finished.
  ParakeetConfig cfg = modelConfig();
  cfg.longFormWindowFrames = 125;
  ParakeetModel model(cfg);
  ASSERT_NO_THROW(model.load());
  if (model.isSortformer()) {
    GTEST_SKIP() << "speech-cpp checks cancel between ASR encoder windows";
  }

  auto run = std::async(
      std::launch::async, [&] { return model.process(std::any(audio)); });
  std::this_thread::sleep_for(std::chrono::milliseconds(1500));
  const auto cancelledAt = std::chrono::steady_clock::now();
  model.cancel();

  EXPECT_THROW(run.get(), std::exception);
  const auto afterCancel = std::chrono::duration_cast<std::chrono::seconds>(
      std::chrono::steady_clock::now() - cancelledAt);
  EXPECT_LT(afterCancel.count(), 10) << "cancel did not interrupt the engine";
}

TEST(ParakeetFabricModel, OfflineDiarizationListsTurnsAndStageTimings) {
  if (!haveGguf() || !std::filesystem::exists(englishClip())) {
    GTEST_SKIP() << "Set QVAC_TEST_GGUF to a Sortformer GGUF to enable.";
  }
  ParakeetModel model(modelConfig());
  ASSERT_NO_THROW(model.load());
  if (!model.isSortformer()) {
    GTEST_SKIP() << "needs a Sortformer GGUF";
  }
  auto out = std::any_cast<ParakeetModel::Output>(
      model.process(std::any(readRawPcm(englishClip()))));
  ASSERT_EQ(out.size(), 1U);
  const Transcript& transcript = out[0];
  ASSERT_FALSE(transcript.speakerSegments.empty()) << transcript.text;

  // One structured turn per "Speaker N: start - end" line, same order.
  std::vector<std::string> lines;
  std::string line;
  std::istringstream text(transcript.text);
  while (std::getline(text, line)) {
    lines.push_back(line);
  }
  ASSERT_EQ(lines.size(), transcript.speakerSegments.size());
  for (size_t i = 0; i < lines.size(); ++i) {
    const auto& turn = transcript.speakerSegments[i];
    EXPECT_EQ(
        lines[i].rfind("Speaker " + std::to_string(turn.speakerId) + ":", 0),
        0U)
        << lines[i];
    EXPECT_LE(turn.start, turn.end);
  }

  // speech-cpp's own stage timings replace the old wall-clock encoderMs.
  const auto stats = model.runtimeStats();
  EXPECT_GT(statValue(stats, "totalEncodedFrames"), 0);
  EXPECT_GE(statValue(stats, "encoderMs"), 0);
  EXPECT_GE(statValue(stats, "melSpecMs"), 0);
  EXPECT_GE(statValue(stats, "decoderMs"), 0);
  EXPECT_TRUE(hasStat(stats, "aoscActive"));
}

TEST(ParakeetFabricModel, DiarizationMinSegmentLongerThanClipDropsAllTurns) {
  if (!haveGguf() || !std::filesystem::exists(englishClip())) {
    GTEST_SKIP() << "Set QVAC_TEST_GGUF to a Sortformer GGUF to enable.";
  }
  ParakeetConfig cfg = modelConfig();
  cfg.diarizationMinSegmentMs = 600000;
  ParakeetModel model(cfg);
  ASSERT_NO_THROW(model.load());
  if (!model.isSortformer()) {
    GTEST_SKIP() << "needs a Sortformer GGUF";
  }
  auto out = std::any_cast<ParakeetModel::Output>(
      model.process(std::any(readRawPcm(englishClip()))));
  ASSERT_EQ(out.size(), 1U);
  EXPECT_EQ(out[0].text, "[No speakers detected]");
  EXPECT_TRUE(out[0].speakerSegments.empty());
}
