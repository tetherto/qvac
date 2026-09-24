#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <random>
#include <string>
#include <system_error>
#include <variant>
#include <vector>

#include <gtest/gtest.h>
#include <tts-cpp/moss/engine.h>

#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/moss/MossConfig.hpp"
#include "model-interface/moss/MossModel.hpp"

using qvac::ttsggml::moss::MOSS_MAX_DURATION_TOKENS;
using qvac::ttsggml::moss::MOSS_NATIVE_SAMPLE_RATE;
using qvac::ttsggml::moss::MOSS_SAMPLES_PER_FRAME;
using qvac::ttsggml::moss::MossConfig;
using qvac::ttsggml::moss::MossModel;
using qvac_errors::StatusError;

namespace {

constexpr char MOSS_BACKBONE_ENV[] = "QVAC_TEST_MOSS_BACKBONE_GGUF";
constexpr char MOSS_DECODER_ENV[] = "QVAC_TEST_MOSS_DECODER_GGUF";
constexpr char MOSS_GPU_ENV[] = "QVAC_TEST_MOSS_GPU";
constexpr const char* STUB_DIR_PREFIX = "qvac-tts-ggml-moss-tests-";
constexpr const char* STUB_CONTENTS = "stub";
constexpr int STREAM_CHUNK_FRAMES = 12;
constexpr int CONFIGURED_SEED = 7;
constexpr int CONFIGURED_THREADS = 3;
constexpr int DECODED_FRAMES = 101;
constexpr int DURATION_TOKENS = 38;
constexpr const char* BACKENDS_ROOT = "/opt/qvac/backends";
constexpr const char* REAL_GGUF_TEXT = "Hello from MOSS running on device.";

std::filesystem::path createStubDir() {
  std::random_device entropy;
  auto dir = std::filesystem::temp_directory_path() /
             (std::string(STUB_DIR_PREFIX) + std::to_string(entropy()));
  std::filesystem::create_directories(dir);
  return dir;
}

class StubDir {
public:
  StubDir() : path_(createStubDir()) {}
  ~StubDir() {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
  }
  StubDir(const StubDir&) = delete;
  StubDir& operator=(const StubDir&) = delete;

  const std::filesystem::path& path() const { return path_; }

private:
  std::filesystem::path path_;
};

std::string stubFile(const std::string& name) {
  static const StubDir dir;
  const auto path = dir.path() / name;
  std::ofstream out(path, std::ios::binary);
  out << STUB_CONTENTS;
  return path.string();
}

std::string envOrEmpty(const char* name) {
  if (const char* v = std::getenv(name))
    return v;
  return "";
}

MossConfig minimallyValidStubConfig() {
  MossConfig cfg;
  cfg.backbonePath = stubFile("moss-backbone-stub.gguf");
  cfg.codecDecoderPath = stubFile("moss-decoder-stub.gguf");
  return cfg;
}

MossConfig dialogueStubConfig() {
  MossConfig cfg = minimallyValidStubConfig();
  cfg.codecEncoderPath = stubFile("moss-encoder-stub.gguf");
  cfg.dialogueReferences = {
      stubFile("moss-speaker-1-stub.wav"), stubFile("moss-speaker-2-stub.wav")};
  return cfg;
}

MossConfig cloningStubConfig() {
  MossConfig cfg = minimallyValidStubConfig();
  cfg.codecEncoderPath = stubFile("moss-encoder-stub.gguf");
  cfg.referenceAudio = stubFile("moss-reference-stub.wav");
  return cfg;
}

bool realGgufsConfigured() {
  return !envOrEmpty(MOSS_BACKBONE_ENV).empty() &&
         !envOrEmpty(MOSS_DECODER_ENV).empty();
}

MossConfig realGgufConfig() {
  MossConfig cfg;
  cfg.backbonePath = envOrEmpty(MOSS_BACKBONE_ENV);
  cfg.codecDecoderPath = envOrEmpty(MOSS_DECODER_ENV);
  cfg.language = "en";
  cfg.seed = CONFIGURED_SEED;
  if (!envOrEmpty(MOSS_GPU_ENV).empty())
    cfg.useGpu = true;
  return cfg;
}

int64_t runtimeInt(const MossModel& model, const std::string& key) {
  for (const auto& entry : model.runtimeStats()) {
    if (entry.first == key)
      return std::get<int64_t>(entry.second);
  }
  ADD_FAILURE() << "missing runtimeStats key: " << key;
  return 0;
}

struct CollectedStream {
  std::vector<int16_t> pcm;
  std::vector<int> chunkIndices;
  int lastMarkers = 0;
};

void appendChunk(
    CollectedStream& stream, std::vector<int16_t>&& pcm, int index,
    bool isLast) {
  stream.pcm.insert(stream.pcm.end(), pcm.begin(), pcm.end());
  stream.chunkIndices.push_back(index);
  if (isLast)
    ++stream.lastMarkers;
}

void expectSequentialIndices(const std::vector<int>& indices) {
  for (size_t i = 0; i < indices.size(); ++i)
    EXPECT_EQ(indices[i], static_cast<int>(i));
}

} // namespace

TEST(MossValidate, EmptyBackbonePathRejected) {
  MossConfig cfg;
  cfg.codecDecoderPath = stubFile("moss-decoder-stub.gguf");
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, EmptyDecoderPathRejected) {
  MossConfig cfg;
  cfg.backbonePath = stubFile("moss-backbone-stub.gguf");
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, NonexistentPathsRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.backbonePath = "/definitely/does/not/exist/moss-backbone.gguf";
  EXPECT_THROW(MossModel{cfg}, StatusError);

  cfg = minimallyValidStubConfig();
  cfg.codecDecoderPath = "/definitely/does/not/exist/moss-decoder.gguf";
  EXPECT_THROW(MossModel{cfg}, StatusError);

  cfg = minimallyValidStubConfig();
  cfg.codecEncoderPath = "/definitely/does/not/exist/moss-encoder.gguf";
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, TextOnlyConfigAccepted) {
  EXPECT_NO_THROW(MossModel{minimallyValidStubConfig()});
}

TEST(MossValidate, CloningConfigAccepted) {
  EXPECT_NO_THROW(MossModel{cloningStubConfig()});
}

TEST(MossValidate, ReferenceAudioNeedsEncoder) {
  auto cfg = cloningStubConfig();
  cfg.codecEncoderPath.clear();
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, NonexistentReferenceAudioRejected) {
  auto cfg = cloningStubConfig();
  cfg.referenceAudio = "/definitely/does/not/exist/voice.wav";
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, DialogueConfigAccepted) {
  EXPECT_NO_THROW(MossModel{dialogueStubConfig()});
}

TEST(MossValidate, DialogueReferencesNeedEncoder) {
  auto cfg = dialogueStubConfig();
  cfg.codecEncoderPath.clear();
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, DialogueAndSingleReferenceAreExclusive) {
  auto cfg = dialogueStubConfig();
  cfg.referenceAudio = stubFile("moss-reference-stub.wav");
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, MissingDialogueReferenceRejected) {
  auto cfg = dialogueStubConfig();
  cfg.dialogueReferences.push_back("/definitely/does/not/exist/speaker.wav");
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, EmptyDialogueReferenceRejected) {
  auto cfg = dialogueStubConfig();
  cfg.dialogueReferences.push_back("");
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, DurationTokensNonNegative) {
  auto cfg = minimallyValidStubConfig();
  cfg.durationTokens = -1;
  EXPECT_THROW(MossModel{cfg}, StatusError);
  cfg.durationTokens = 0;
  EXPECT_NO_THROW(MossModel{cfg});
  cfg.durationTokens = DURATION_TOKENS;
  EXPECT_NO_THROW(MossModel{cfg});
  cfg.durationTokens = MOSS_MAX_DURATION_TOKENS;
  EXPECT_NO_THROW(MossModel{cfg});
  cfg.durationTokens = MOSS_MAX_DURATION_TOKENS + 1;
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, ThreadsNonNegative) {
  auto cfg = minimallyValidStubConfig();
  cfg.threads = -1;
  EXPECT_THROW(MossModel{cfg}, StatusError);
  cfg.threads = 0;
  EXPECT_NO_THROW(MossModel{cfg});
  cfg.threads = 1;
  EXPECT_NO_THROW(MossModel{cfg});
}

TEST(MossValidate, StreamChunkFramesNonNegative) {
  auto cfg = minimallyValidStubConfig();
  cfg.streamChunkFrames = -1;
  EXPECT_THROW(MossModel{cfg}, StatusError);
  cfg.streamChunkFrames = 0;
  EXPECT_NO_THROW(MossModel{cfg});
  cfg.streamChunkFrames = STREAM_CHUNK_FRAMES;
  EXPECT_NO_THROW(MossModel{cfg});
}

TEST(MossValidate, UseGpuNGpuLayersConflictRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.useGpu = true;
  cfg.nGpuLayers = 0;
  EXPECT_THROW(MossModel{cfg}, StatusError);
  cfg.useGpu = false;
  cfg.nGpuLayers = 99;
  EXPECT_THROW(MossModel{cfg}, StatusError);
}

TEST(MossValidate, LoadIsDeferredAndStubFailsToParse) {
  std::unique_ptr<MossModel> m;
  EXPECT_NO_THROW(m = std::make_unique<MossModel>(minimallyValidStubConfig()));
  ASSERT_NE(m, nullptr);
  EXPECT_FALSE(m->isLoaded());
  EXPECT_THROW(m->load(), StatusError);
  EXPECT_FALSE(m->isLoaded());
}

TEST(MossValidate, ConfigDefaultsAllUnset) {
  MossConfig cfg;
  EXPECT_TRUE(cfg.language.empty());
  EXPECT_FALSE(cfg.seed.has_value());
  EXPECT_FALSE(cfg.threads.has_value());
  EXPECT_FALSE(cfg.streamChunkFrames.has_value());
  EXPECT_FALSE(cfg.nGpuLayers.has_value());
  EXPECT_FALSE(cfg.useGpu.has_value());
  EXPECT_FALSE(cfg.durationTokens.has_value());
  EXPECT_TRUE(cfg.dialogueReferences.empty());
  EXPECT_TRUE(cfg.backendsDir.empty());
}

TEST(MossEngineOptions, UnsetFieldsKeepEngineDefaults) {
  const tts_cpp::moss::EngineOptions defaults;
  const auto opts = MossModel::toEngineOptions(minimallyValidStubConfig());
  EXPECT_EQ(opts.language, defaults.language);
  EXPECT_EQ(opts.seed, defaults.seed);
  EXPECT_EQ(opts.n_threads, defaults.n_threads);
  EXPECT_EQ(opts.stream_chunk_frames, defaults.stream_chunk_frames);
  EXPECT_FALSE(opts.use_gpu);
}

TEST(MossEngineOptions, ConfiguredFieldsReachTheEngine) {
  auto cfg = cloningStubConfig();
  cfg.language = "en";
  cfg.seed = CONFIGURED_SEED;
  cfg.threads = CONFIGURED_THREADS;
  cfg.streamChunkFrames = STREAM_CHUNK_FRAMES;
  const auto opts = MossModel::toEngineOptions(cfg);
  EXPECT_EQ(opts.backbone_path, cfg.backbonePath);
  EXPECT_EQ(opts.decoder_path, cfg.codecDecoderPath);
  EXPECT_EQ(opts.encoder_path, cfg.codecEncoderPath);
  EXPECT_EQ(opts.reference_audio_path, cfg.referenceAudio);
  EXPECT_EQ(opts.language, "en");
  EXPECT_EQ(opts.seed, static_cast<uint32_t>(CONFIGURED_SEED));
  EXPECT_EQ(opts.n_threads, CONFIGURED_THREADS);
  EXPECT_EQ(opts.stream_chunk_frames, STREAM_CHUNK_FRAMES);
}

TEST(MossEngineOptions, DirectableAndDialogueFieldsReachTheEngine) {
  auto cfg = dialogueStubConfig();
  cfg.durationTokens = DURATION_TOKENS;
  cfg.backendsDir = BACKENDS_ROOT;
  const auto opts = MossModel::toEngineOptions(cfg);
  EXPECT_EQ(opts.dialogue_reference_paths, cfg.dialogueReferences);
  EXPECT_EQ(opts.duration_tokens, DURATION_TOKENS);
  EXPECT_EQ(opts.backends_dir.rfind(BACKENDS_ROOT, 0), 0u);
}

TEST(MossEngineOptions, UnsetDirectableFieldsKeepEngineDefaults) {
  const tts_cpp::moss::EngineOptions defaults;
  const auto opts = MossModel::toEngineOptions(minimallyValidStubConfig());
  EXPECT_TRUE(opts.dialogue_reference_paths.empty());
  EXPECT_EQ(opts.duration_tokens, defaults.duration_tokens);
  EXPECT_TRUE(opts.backends_dir.empty());
}

TEST(MossEngineOptions, ZeroThreadsKeepsTheEngineDefault) {
  const tts_cpp::moss::EngineOptions defaults;
  auto cfg = minimallyValidStubConfig();
  cfg.threads = 0;
  EXPECT_EQ(MossModel::toEngineOptions(cfg).n_threads, defaults.n_threads);
}

TEST(MossStats, FramesCountDecodedCodecFrames) {
  EXPECT_EQ(MossModel::decodedFrames(0), 0);
  EXPECT_EQ(MossModel::decodedFrames(MOSS_SAMPLES_PER_FRAME - 1), 0);
  EXPECT_EQ(
      MossModel::decodedFrames(DECODED_FRAMES * MOSS_SAMPLES_PER_FRAME),
      DECODED_FRAMES);
}

TEST(MossEngineOptions, GpuIntentFollowsEitherSwitch) {
  auto cfg = minimallyValidStubConfig();
  cfg.useGpu = true;
  EXPECT_TRUE(MossModel::toEngineOptions(cfg).use_gpu);
  cfg.useGpu.reset();
  cfg.nGpuLayers = 99;
  EXPECT_TRUE(MossModel::toEngineOptions(cfg).use_gpu);
  cfg.nGpuLayers = 0;
  EXPECT_FALSE(MossModel::toEngineOptions(cfg).use_gpu);
}

TEST(MossReload, RefusedReloadKeepsTheConfiguration) {
  MossModel model{cloningStubConfig()};
  auto broken = cloningStubConfig();
  broken.codecEncoderPath.clear();
  EXPECT_THROW(model.reloadWith(broken), StatusError);
  EXPECT_FALSE(model.config().codecEncoderPath.empty());
}

TEST(MossRealGguf, BatchSynthesisRoundTrip) {
  if (!realGgufsConfigured()) {
    GTEST_SKIP() << "set QVAC_TEST_MOSS_BACKBONE_GGUF and "
                    "QVAC_TEST_MOSS_DECODER_GGUF to run this";
  }
  MossModel model{realGgufConfig()};
  ASSERT_NO_THROW(model.load());

  MossModel::AnyInput input;
  input.text = REAL_GGUF_TEXT;
  const auto pcm =
      std::any_cast<MossModel::Output>(model.process(std::any(input)));
  EXPECT_FALSE(pcm.empty());
  EXPECT_EQ(model.sampleRate(), MOSS_NATIVE_SAMPLE_RATE);
  EXPECT_EQ(
      runtimeInt(model, "generatedFrames"),
      MossModel::decodedFrames(static_cast<int64_t>(pcm.size())));
}

TEST(MossRealGguf, StreamingDeliversOrderedChunksThenOneLastMarker) {
  if (!realGgufsConfigured()) {
    GTEST_SKIP() << "set QVAC_TEST_MOSS_BACKBONE_GGUF and "
                    "QVAC_TEST_MOSS_DECODER_GGUF to run this";
  }
  auto cfg = realGgufConfig();
  cfg.streamChunkFrames = STREAM_CHUNK_FRAMES;
  MossModel model{cfg};
  ASSERT_NO_THROW(model.load());

  CollectedStream stream;
  MossModel::AnyInput input;
  input.text = REAL_GGUF_TEXT;
  input.chunkCallback =
      [&stream](std::vector<int16_t>&& pcm, int index, bool isLast) {
        appendChunk(stream, std::move(pcm), index, isLast);
      };
  const auto result = model.process(std::any(input));

  EXPECT_FALSE(result.has_value());
  EXPECT_FALSE(stream.pcm.empty());
  EXPECT_EQ(stream.lastMarkers, 1);
  expectSequentialIndices(stream.chunkIndices);
}
