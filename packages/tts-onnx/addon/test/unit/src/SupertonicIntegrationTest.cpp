#include "src/model-interface/TTSModel.hpp"

#include <cstdlib>
#include <functional>
#include <filesystem>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#elif defined(_WIN32)
#include <windows.h>
#elif defined(__linux__)
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace qvac::ttslib::addon_model::testing {

// Expected layout (Supertone/supertonic English or multilingual HF supertonic-2 — same directory layout):
//   onnx/{duration_predictor,text_encoder,vector_estimator,vocoder}.onnx
//   onnx/{tts.json,unicode_indexer.json}
//   voice_styles/{Voice}.json

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

static fs::path getPackageRootFromExe() {
  std::string exe = getExecutablePath();
  if (exe.empty()) {
    return {};
  }
  fs::path exeDir = fs::path(exe).parent_path();
  fs::path root = exeDir / ".." / ".." / ".." / "..";
  std::error_code ec;
  return fs::canonical(root, ec);
}

static std::string getSupertonicModelDir(const std::function<bool(const std::string &)> &exists) {
  std::vector<std::string> candidates;
  const char *env = std::getenv("SUPERTONIC_MODEL_DIR");

  if (env != nullptr && env[0] != '\0') {
    candidates.push_back(env);
  }
  candidates.push_back("models/supertonic");
  candidates.push_back("../../../../models/supertonic");

  fs::path packageRoot = getPackageRootFromExe();
  if (!packageRoot.empty()) {
    candidates.push_back((packageRoot / "models" / "supertonic").string());
    if (env != nullptr && env[0] != '\0') {
      fs::path envPath(env);
      if (!envPath.is_absolute()) {
        candidates.push_back((packageRoot / env).string());
      }
    }
  }

  for (const auto &dir : candidates) {
    if (exists(dir)) {
      return dir;
    }
  }
  return candidates.empty() ? "models/supertonic" : candidates[0];
}

static bool supertonicModelDirExists(const std::string &baseDir) {
  fs::path base(baseDir);
  if (!fs::exists(base) || !fs::is_directory(base)) {
    return false;
  }
  const fs::path onnx = base / "onnx";
  if (!fs::exists(onnx / "text_encoder.onnx") ||
      !fs::exists(onnx / "duration_predictor.onnx") ||
      !fs::exists(onnx / "vector_estimator.onnx") ||
      !fs::exists(onnx / "vocoder.onnx") ||
      !fs::exists(onnx / "tts.json") ||
      !fs::exists(onnx / "unicode_indexer.json")) {
    return false;
  }
  fs::path vs = base / "voice_styles";
  if (!fs::exists(vs) || !fs::is_directory(vs)) {
    return false;
  }
  for (const auto &e : fs::directory_iterator(vs)) {
    if (e.path().extension() == ".json") {
      return true;
    }
  }
  return false;
}

static std::string getFirstVoiceName(const std::string &baseDir) {
  fs::path vs = fs::path(baseDir) / "voice_styles";
  if (!fs::exists(vs) || !fs::is_directory(vs)) {
    return "";
  }
  for (const auto &e : fs::directory_iterator(vs)) {
    if (e.path().extension() == ".json") {
      return e.path().stem().string();
    }
  }
  return "";
}

class SupertonicIntegrationTest : public ::testing::Test {
protected:
  std::string baseDir_;
  std::string voiceName_;

  void SetUp() override {
    baseDir_ = getSupertonicModelDir(supertonicModelDirExists);
    if (!supertonicModelDirExists(baseDir_)) {
      GTEST_SKIP() << "Supertone model dir not found or incomplete: "
                   << baseDir_
                   << " (set SUPERTONIC_MODEL_DIR; expected HF Supertone/supertonic layout)";
    }
    voiceName_ = getFirstVoiceName(baseDir_);
    if (voiceName_.empty()) {
      GTEST_SKIP() << "No voice_styles/*.json under " << baseDir_;
    }
  }
};

TEST_F(SupertonicIntegrationTest, loadAndSynthesize) {
  std::unordered_map<std::string, std::string> config;
  fs::path base(baseDir_);
  config["modelDir"] = base.string();
  config["voiceName"] = voiceName_;
  config["language"] = "en";
  config["speed"] = "1.0";
  config["numInferenceSteps"] = "5";

  TTSModel model(config, {});

  ASSERT_TRUE(model.isLoaded()) << "Model should be loaded after construction";

  TTSModel::Output output = model.process(TTSModel::Input{"Hello."});
  EXPECT_FALSE(output.empty()) << "Synthesis should produce non-empty PCM";
  EXPECT_GT(output.size(), 1000u)
      << "Short phrase should yield at least ~1k samples at 44.1kHz";
}

TEST_F(SupertonicIntegrationTest, unloadAfterSynthesize) {
  std::unordered_map<std::string, std::string> config;
  fs::path base(baseDir_);
  config["modelDir"] = base.string();
  config["voiceName"] = voiceName_;
  config["language"] = "en";

  TTSModel model(config, {});
  ASSERT_TRUE(model.isLoaded());

  TTSModel::Output output = model.process(TTSModel::Input{"Hi"});
  EXPECT_FALSE(output.empty());

  model.unload();
  EXPECT_FALSE(model.isLoaded());
}

} // namespace qvac::ttslib::addon_model::testing
