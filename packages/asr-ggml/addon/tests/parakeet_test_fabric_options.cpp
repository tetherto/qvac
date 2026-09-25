// speech-cpp capabilities surfaced by the Parakeet binding: every
// ParakeetConfig key must reach its speech-cpp option struct, stream events
// must map onto VadEvent, and the structured diarization / backend fields
// must be populated. The model-backed cases run only when QVAC_TEST_GGUF
// points at a Parakeet ASR GGUF.

#include <any>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <future>
#include <sstream>
#include <string>
#include <thread>
#include <variant>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/ParakeetTypes.hpp"
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

  auto event = ParakeetModel::toVadEvent(speaking, VadSource::Sortformer);
  ASSERT_TRUE(event.has_value());
  EXPECT_TRUE(event->speaking);
  EXPECT_FLOAT_EQ(event->score, 0.87F);
  EXPECT_DOUBLE_EQ(event->timestamp, 4.25);
  EXPECT_EQ(event->speakerId, 2);
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
