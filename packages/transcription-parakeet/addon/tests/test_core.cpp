// C++ unit tests for the pure-ggml ParakeetModel.

// Tests that require an actual GGUF on disk are guarded with a
// `QVAC_TEST_GGUF` env-var fallback so the suite can run as part of CI
// even when no model is present (skipping the few "load + transcribe"
// scenarios that genuinely need it).

#include <gtest/gtest.h>

#include <any>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <span>
#include <sstream>
#include <streambuf>
#include <string>
#include <thread>
#include <vector>

#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/parakeet/ParakeetConfig.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"

using namespace qvac_lib_infer_parakeet;

// ─────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────

namespace {

std::string findStatStr(const qvac_lib_inference_addon_cpp::RuntimeStats & stats,
                        const std::string & key) {
    for (const auto & [k, v] : stats) {
        if (k != key) continue;
        if (std::holds_alternative<int64_t>(v))
            return std::to_string(std::get<int64_t>(v));
        return std::to_string(std::get<double>(v));
    }
    return "";
}

int64_t findStatInt(const qvac_lib_inference_addon_cpp::RuntimeStats & stats,
                    const std::string & key) {
    for (const auto & [k, v] : stats) {
        if (k != key) continue;
        if (std::holds_alternative<int64_t>(v)) return std::get<int64_t>(v);
        return static_cast<int64_t>(std::get<double>(v));
    }
    return 0;
}

bool hasStatKey(const qvac_lib_inference_addon_cpp::RuntimeStats & stats,
                const std::string & key) {
    for (const auto & [k, v] : stats) if (k == key) return true;
    return false;
}

// Path to a GGUF that is "small enough" for unit tests (any of the
// shipping CTC / TDT / EOU / Sortformer GGUFs is fine; the tests don't
// care which engine is loaded). Falls back to an empty string so the
// guarded tests can skip cleanly when no model is available.
std::string gguf_test_path() {
    if (const char * env = std::getenv("QVAC_TEST_GGUF")) return env;
    return "";
}

// Read a file into a vector<uint8_t>. Used to exercise the
// setWeightsForFile() byte-buffer path with real GGUF bytes.
std::vector<uint8_t> read_file_bytes(const std::filesystem::path & p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return {};
    f.seekg(0, std::ios::end);
    const auto n = static_cast<std::streamoff>(f.tellg());
    f.seekg(0, std::ios::beg);
    std::vector<uint8_t> out(n > 0 ? static_cast<size_t>(n) : 0);
    if (n > 0) f.read(reinterpret_cast<char *>(out.data()), n);
    return out;
}

class TestStreamBuf : public std::basic_streambuf<char> {
public:
    explicit TestStreamBuf(std::vector<uint8_t> buf) : buf_(std::move(buf)) {
        char * b = reinterpret_cast<char *>(buf_.data());
        setg(b, b, b + buf_.size());
    }

private:
    std::vector<uint8_t> buf_;
};

class ParakeetModelTest : public ::testing::Test {
protected:
    void SetUp() override {
        cfg.modelType  = ModelType::TDT;
        cfg.maxThreads = 2;
        cfg.useGPU     = false;
        cfg.sampleRate = 16000;
        cfg.channels   = 1;
    }
    ParakeetConfig cfg;
};

}  // namespace

// ─────────────────────────────────────────────────────────────────────
//  Construction + config
// ─────────────────────────────────────────────────────────────────────

TEST_F(ParakeetModelTest, ConstructorDoesNotThrow) {
    EXPECT_NO_THROW({ ParakeetModel m(cfg); });
}

TEST_F(ParakeetModelTest, GetNameMentionsGgmlBackend) {
    ParakeetModel m(cfg);
    const std::string name = m.getName();
    EXPECT_NE(name.find("parakeet"), std::string::npos);
    EXPECT_NE(name.find("ggml"),     std::string::npos);
}

TEST_F(ParakeetModelTest, GetDisplayNameEqualsGetName) {
    ParakeetModel m(cfg);
    EXPECT_EQ(m.getDisplayName(), m.getName());
}

TEST_F(ParakeetModelTest, ConfigEquality) {
    ParakeetConfig a;
    ParakeetConfig b;
    EXPECT_EQ(a, b);

    b.modelPath = "x.gguf";
    EXPECT_NE(a, b);
}

TEST_F(ParakeetModelTest, SetConfigUpdatesConfiguration) {
    ParakeetModel m(cfg);
    ParakeetConfig newCfg = cfg;
    newCfg.modelType  = ModelType::EOU;
    newCfg.maxThreads = 4;
    EXPECT_NO_THROW(m.setConfig(newCfg));
}

TEST_F(ParakeetModelTest, SaveLoadParamsAcceptsConfigButIgnoresOthers) {
    ParakeetModel m(cfg);
    m.saveLoadParams(cfg);
    m.saveLoadParams(42);              // template overload, no-op
    m.saveLoadParams(std::string{});    // template overload, no-op
}

// ─────────────────────────────────────────────────────────────────────
//  Lifecycle without a real GGUF on disk
// ─────────────────────────────────────────────────────────────────────

TEST_F(ParakeetModelTest, IsLoadedStartsFalse) {
    ParakeetModel m(cfg);
    EXPECT_FALSE(m.isLoaded());
}

TEST_F(ParakeetModelTest, EndOfStreamFlagsState) {
    ParakeetModel m(cfg);
    EXPECT_FALSE(m.isStreamEnded());
    m.endOfStream();
    EXPECT_TRUE(m.isStreamEnded());
}

TEST_F(ParakeetModelTest, ResetClearsStreamEndedAndDoesNotThrow) {
    ParakeetModel m(cfg);
    m.endOfStream();
    EXPECT_TRUE(m.isStreamEnded());
    EXPECT_NO_THROW(m.reset());
    EXPECT_FALSE(m.isStreamEnded());
}

TEST_F(ParakeetModelTest, UnloadOnUnloadedModelIsHarmless) {
    ParakeetModel m(cfg);
    EXPECT_NO_THROW(m.unload());
    EXPECT_NO_THROW(m.unloadWeights());
    EXPECT_FALSE(m.isLoaded());
}

TEST_F(ParakeetModelTest, InitializeBackendDoesNotThrow) {
    ParakeetModel m(cfg);
    EXPECT_NO_THROW(m.initializeBackend());
}

TEST_F(ParakeetModelTest, LoadWithoutWeightsThrows) {
    ParakeetModel m(cfg);
    EXPECT_THROW(m.load(), std::exception);
    EXPECT_FALSE(m.isLoaded());
}

// ─────────────────────────────────────────────────────────────────────
//  Weight loading -- byte-stream paths
// ─────────────────────────────────────────────────────────────────────

TEST_F(ParakeetModelTest, SetWeightsForFileIgnoresNonGgufFilename) {
    ParakeetModel m(cfg);
    const std::vector<uint8_t> bogus(1024, 0xAB);
    m.set_weights_for_file("vocab.txt",
                           std::span<const uint8_t>(bogus.data(), bogus.size()),
                           /*completed=*/true);
    // Loading still throws because no GGUF was provided.
    EXPECT_THROW(m.load(), std::exception);
}

TEST_F(ParakeetModelTest, SetWeightsForFileIgnoresIncompleteFlag) {
    ParakeetModel m(cfg);
    const std::vector<uint8_t> bogus(64, 0x42);
    m.set_weights_for_file("model.gguf",
                           std::span<const uint8_t>(bogus.data(), bogus.size()),
                           /*completed=*/false);
    // No `completed=true` means no load attempt yet -- load() should
    // throw because the GGUF buffer is "in flight".
    EXPECT_THROW(m.load(), std::exception);
}

TEST_F(ParakeetModelTest, SetWeightsForFileWithEmptyChunk) {
    ParakeetModel m(cfg);
    m.set_weights_for_file("model.gguf",
                           std::span<const uint8_t>(),
                           /*completed=*/true);
    // Even with `completed=true`, an empty buffer is invalid GGUF.
    EXPECT_THROW(m.load(), std::exception);
}

TEST_F(ParakeetModelTest, SetWeightsForFileTemplateOverloadIsHarmless) {
    ParakeetModel m(cfg);
    EXPECT_NO_THROW(m.set_weights_for_file("model.gguf", 1234));
    EXPECT_NO_THROW(m.set_weights_for_file("model.gguf", std::string{"abc"}));
}

// ─────────────────────────────────────────────────────────────────────
//  process() and process(any) dispatching
// ─────────────────────────────────────────────────────────────────────

TEST_F(ParakeetModelTest, ProcessEmptyAudioDoesNotCrashOrEmitOutput) {
    ParakeetModel m(cfg);
    ParakeetModel::Input empty;
    EXPECT_NO_THROW(m.process(empty));
}

TEST_F(ParakeetModelTest, ProcessAnyAcceptsAudioInput) {
    ParakeetModel m(cfg);
    ParakeetModel::Input audio(16000, 0.0f);
    auto result = m.process(std::any(audio));
    ASSERT_TRUE(result.has_value());
    auto out = std::any_cast<ParakeetModel::Output>(result);
    // Without a loaded GGUF the model emits a "[Model not loaded]"
    // sentinel transcript -- still a valid Output.
    ASSERT_FALSE(out.empty());
    EXPECT_FALSE(out.front().text.empty());
}

TEST_F(ParakeetModelTest, ProcessAnyAcceptsAnyInputWrapper) {
    ParakeetModel m(cfg);
    ParakeetModel::AnyInput wrap{ParakeetModel::Input(8000, 0.0f)};
    EXPECT_NO_THROW(m.process(std::any(wrap)));
}

TEST_F(ParakeetModelTest, ProcessAnyRejectsUnsupportedInputType) {
    ParakeetModel m(cfg);
    EXPECT_THROW(m.process(std::any(std::string("not audio"))),
                 std::invalid_argument);
}

TEST_F(ParakeetModelTest, ProcessWithCallbackReturnsOutput) {
    ParakeetModel m(cfg);
    ParakeetModel::Input audio(8000, 0.0f);
    bool called = false;
    auto out = m.process(audio, [&](const ParakeetModel::Output & o) {
        called = true;
        EXPECT_FALSE(o.empty());
    });
    EXPECT_TRUE(called);
    EXPECT_FALSE(out.empty());
}

TEST_F(ParakeetModelTest, SetOnSegmentCallbackFiresPerProcessCall) {
    ParakeetModel m(cfg);
    int hits = 0;
    m.setOnSegmentCallback([&](const Transcript &) { ++hits; });
    m.process(ParakeetModel::Input(4000, 0.0f));
    EXPECT_EQ(hits, 1);
    m.process(ParakeetModel::Input(4000, 0.0f));
    EXPECT_EQ(hits, 2);
}

TEST_F(ParakeetModelTest, AddTranscriptionAppendsToOutput) {
    ParakeetModel m(cfg);
    Transcript t;
    t.text = "hello";
    m.addTranscription(t);
    auto out = m.process(ParakeetModel::Input(1000, 0.0f),
                         [](const ParakeetModel::Output &) {});
    // The custom transcription survives + the new one is appended.
    ASSERT_GE(out.size(), 2u);
    EXPECT_EQ(out.front().text, "hello");
}

// ─────────────────────────────────────────────────────────────────────
//  Cancellation
// ─────────────────────────────────────────────────────────────────────

TEST_F(ParakeetModelTest, CancelBeforeProcessDoesNotPoisonNextRun) {
    ParakeetModel m(cfg);
    m.cancel();  // generation 0 cancel
    EXPECT_NO_THROW(m.process(ParakeetModel::Input(4000, 0.0f)));
}

TEST_F(ParakeetModelTest, CancelBeforeProcessAnyDoesNotPoisonNextRun) {
    ParakeetModel m(cfg);
    m.cancel();
    auto result = m.process(std::any(ParakeetModel::Input(4000, 0.0f)));
    EXPECT_TRUE(result.has_value());
}

// ─────────────────────────────────────────────────────────────────────
//  RuntimeStats shape + accumulation
// ─────────────────────────────────────────────────────────────────────

TEST_F(ParakeetModelTest, RuntimeStatsExposeExpectedKeys) {
    ParakeetModel m(cfg);
    auto stats = m.runtimeStats();
    EXPECT_TRUE(hasStatKey(stats, "processCalls"));
    EXPECT_TRUE(hasStatKey(stats, "totalSamples"));
    EXPECT_TRUE(hasStatKey(stats, "totalTokens"));
    EXPECT_TRUE(hasStatKey(stats, "totalTranscriptions"));
    EXPECT_TRUE(hasStatKey(stats, "totalWallMs"));
    EXPECT_TRUE(hasStatKey(stats, "modelLoadMs"));
    EXPECT_TRUE(hasStatKey(stats, "backendDevice"));
    EXPECT_TRUE(hasStatKey(stats, "backendId"));
    // Pre-load defaults: model never opened the engine -> CPU / id=0.
    EXPECT_EQ(findStatInt(stats, "backendDevice"), 0);
    EXPECT_EQ(findStatInt(stats, "backendId"),     0);
}

TEST_F(ParakeetModelTest, RuntimeStatsAccumulateAcrossCalls) {
    ParakeetModel m(cfg);
    EXPECT_EQ(findStatInt(m.runtimeStats(), "processCalls"), 0);

    m.process(ParakeetModel::Input(8000, 0.0f));
    EXPECT_EQ(findStatInt(m.runtimeStats(), "processCalls"), 1);
    EXPECT_EQ(findStatInt(m.runtimeStats(), "totalSamples"), 8000);

    m.process(ParakeetModel::Input(8000, 0.0f));
    EXPECT_EQ(findStatInt(m.runtimeStats(), "processCalls"), 2);
    EXPECT_EQ(findStatInt(m.runtimeStats(), "totalSamples"), 16000);
}

// ─────────────────────────────────────────────────────────────────────
//  Static helpers
// ─────────────────────────────────────────────────────────────────────

TEST(ParakeetStaticHelpers, PreprocessAudioDataS16LeNormalises) {
    // Two int16_t samples: 16384 → 0.5, -16384 → -0.5
    std::vector<uint8_t> raw = {0x00, 0x40, 0x00, 0xC0};
    auto out = ParakeetModel::preprocessAudioData(raw, "s16le");
    ASSERT_EQ(out.size(), 2u);
    EXPECT_NEAR(out[0],  0.5f, 1e-6f);
    EXPECT_NEAR(out[1], -0.5f, 1e-6f);
}

TEST(ParakeetStaticHelpers, PreprocessAudioDataRejectsUnknownFormat) {
    std::vector<uint8_t> raw(8, 0);
    EXPECT_THROW(ParakeetModel::preprocessAudioData(raw, "f32le"),
                 std::exception);
}

// ─────────────────────────────────────────────────────────────────────
//  GGUF-on-disk smoke: only run when QVAC_TEST_GGUF points at a real
//  file. Covers the happy-path setWeightsForFile + load + process loop
//  end-to-end.
// ─────────────────────────────────────────────────────────────────────

TEST_F(ParakeetModelTest, GgufLoadAndProcessRealAudioIfAvailable) {
    const auto path = gguf_test_path();
    if (path.empty() || !std::filesystem::exists(path)) {
        GTEST_SKIP() << "Set QVAC_TEST_GGUF to a parakeet GGUF to enable.";
    }
    ParakeetModel m(cfg);
    auto bytes = read_file_bytes(path);
    ASSERT_FALSE(bytes.empty());

    m.set_weights_for_file("model.gguf",
                           std::span<const uint8_t>(bytes.data(), bytes.size()),
                           /*completed=*/true);
    EXPECT_NO_THROW(m.load());
    EXPECT_TRUE(m.isLoaded());
    EXPECT_GT(findStatInt(m.runtimeStats(), "modelLoadMs"), 0);

    // Silent input still produces an Output; we just want a no-crash.
    auto out = m.process(ParakeetModel::Input(16000, 0.0f),
                         [](const ParakeetModel::Output &) {});
    EXPECT_FALSE(out.empty());
    EXPECT_NO_THROW(m.unload());
    EXPECT_FALSE(m.isLoaded());
}

TEST_F(ParakeetModelTest, GgufStreambufOverloadIfAvailable) {
    const auto path = gguf_test_path();
    if (path.empty() || !std::filesystem::exists(path)) {
        GTEST_SKIP() << "Set QVAC_TEST_GGUF to a parakeet GGUF to enable.";
    }
    ParakeetModel m(cfg);
    auto bytes = read_file_bytes(path);
    ASSERT_FALSE(bytes.empty());

    auto sb = std::make_unique<TestStreamBuf>(std::move(bytes));
    m.setWeightsForFile("model.gguf", std::move(sb));
    EXPECT_NO_THROW(m.load());
    EXPECT_TRUE(m.isLoaded());
}
