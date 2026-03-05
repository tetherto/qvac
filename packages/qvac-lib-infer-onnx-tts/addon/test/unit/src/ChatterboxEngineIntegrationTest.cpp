#include "src/model-interface/ChatterboxEngine.hpp"
#include "src/model-interface/IChatterboxEngine.hpp"
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <gtest/gtest.h>
#include <sstream>
#include <string>
#include <vector>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#elif defined(_WIN32)
#include <windows.h>
#elif defined(__linux__)
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace qvac::ttslib::chatterbox::testing {

static std::string getExecutablePath() {
#if defined(__APPLE__)
  char buf[4096];
  uint32_t size = sizeof(buf);
  if (_NSGetExecutablePath(buf, &size) != 0) {
    return "";
  }
  return std::string(buf);
#elif defined(_WIN32)
  char buf[MAX_PATH];
  DWORD n = GetModuleFileNameA(nullptr, buf, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) {
    return "";
  }
  return std::string(buf, n);
#elif defined(__linux__)
  char buf[4096];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (n <= 0) {
    return "";
  }
  buf[n] = '\0';
  return std::string(buf);
#else
  return "";
#endif
}

static fs::path getPackageRoot() {
  std::string exe = getExecutablePath();
  if (exe.empty()) {
    return {};
  }
  fs::path exeDir = fs::path(exe).parent_path();
  fs::path root = exeDir / ".." / ".." / ".." / "..";
  std::error_code ec;
  return fs::canonical(root, ec);
}

static bool chatterboxModelDirReady(const fs::path &dir) {
  if (!fs::exists(dir) || !fs::is_directory(dir)) {
    return false;
  }
  const fs::path tokenizer = dir / "tokenizer.json";
  const fs::path speech = dir / "speech_encoder.onnx";
  const fs::path embed = dir / "embed_tokens.onnx";
  const fs::path cond = dir / "conditional_decoder.onnx";
  const fs::path lm = dir / "language_model.onnx";
  return fs::exists(tokenizer) && fs::exists(speech) && fs::exists(embed) &&
         fs::exists(cond) && fs::exists(lm);
}

static std::string getChatterboxModelDir() {
  fs::path root = getPackageRoot();
  if (root.empty()) {
    return "";
  }
  return (root / "models" / "chatterbox").string();
}

static int runEnsureChatterboxModels(const std::string &packageRoot) {
  std::ostringstream cmd;
  cmd << "cd \"" << packageRoot << "\" && npm run models:ensure";
  return std::system(cmd.str().c_str());
}

static std::vector<float> makeMinimalReferenceAudio() {
  const size_t oneSecondAt24k = 24000;
  return std::vector<float>(oneSecondAt24k, 0.01f);
}

TEST(ChatterboxEngineIntegrationTest,
     synthesizeProducesAudioWhenModelsAvailable) {
  fs::path root = getPackageRoot();
  ASSERT_FALSE(root.empty()) << "Could not resolve package root";

  std::string modelDir = getChatterboxModelDir();
  ASSERT_FALSE(modelDir.empty()) << "Could not resolve model dir";

  if (!chatterboxModelDirReady(fs::path(modelDir))) {
    int ret = runEnsureChatterboxModels(root.string());
    ASSERT_EQ(0, ret)
        << "Failed to download Chatterbox models (npm run models:ensure)";
  }

  ASSERT_TRUE(chatterboxModelDirReady(fs::path(modelDir)))
      << "Chatterbox models not ready after download";

  ChatterboxConfig config;
  config.language = "en";
  config.referenceAudio = makeMinimalReferenceAudio();
  config.tokenizerPath = modelDir + "/tokenizer.json";
  config.speechEncoderPath = modelDir + "/speech_encoder.onnx";
  config.embedTokensPath = modelDir + "/embed_tokens.onnx";
  config.conditionalDecoderPath = modelDir + "/conditional_decoder.onnx";
  config.languageModelPath = modelDir + "/language_model.onnx";
  config.lazySessionLoading = false;

  ChatterboxEngine engine(config);
  ASSERT_TRUE(engine.isLoaded());

  AudioResult result = engine.synthesize("Hello");

  EXPECT_GT(result.samples, 0u);
  EXPECT_EQ(result.sampleRate, 24000);
  EXPECT_EQ(result.channels, 1);
  EXPECT_EQ(result.pcm16.size(), result.samples);
}

} // namespace qvac::ttslib::chatterbox::testing
