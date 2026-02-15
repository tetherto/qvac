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

// Expected layout under models/supertonic (or SUPERTONIC_MODEL_DIR):
//   tokenizer.json
//   onnx/text_encoder.onnx
//   onnx/latent_denoiser.onnx
//   onnx/voice_decoder.onnx
//   voices/<voiceName>.bin  (e.g. M1.bin)

// Returns path to the running executable, or empty string if unavailable.
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

// Package root when test binary lives at build/addon/test/unit/<binary>.
static fs::path getPackageRootFromExe() {
  std::string exe = getExecutablePath();
  if (exe.empty()) {
    return {};
  }
  fs::path exeDir = fs::path(exe).parent_path();
  // build/addon/test/unit -> go up 4 to package root
  fs::path root = exeDir / ".." / ".." / ".." / "..";
  std::error_code ec;
  return fs::canonical(root, ec);
}

// Returns the first candidate path that exists and passes supertonicModelDirExists.
// Tries cwd-relative paths first, then paths relative to executable (package root).
static std::string getSupertonicModelDir(const std::function<bool(const std::string &)> &exists) {
  std::vector<std::string> candidates;
  const char *env = std::getenv("SUPERTONIC_MODEL_DIR");

  // cwd-relative
  if (env != nullptr && env[0] != '\0') {
    candidates.push_back(env);
  }
  candidates.push_back("models/supertonic");
  candidates.push_back("../../../../models/supertonic");

  // executable-relative (package root) so tests find models/ when cwd differs
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
  if (!fs::exists(base / "tokenizer.json")) {
    return false;
  }
  if (!fs::exists(base / "onnx" / "text_encoder.onnx")) {
    return false;
  }
  if (!fs::exists(base / "onnx" / "latent_denoiser.onnx")) {
    return false;
  }
  if (!fs::exists(base / "onnx" / "voice_decoder.onnx")) {
    return false;
  }
  fs::path voicesDir = base / "voices";
  if (!fs::exists(voicesDir) || !fs::is_directory(voicesDir)) {
    return false;
  }
  // At least one voice .bin (e.g. M1.bin)
  bool hasVoice = false;
  for (const auto &e : fs::directory_iterator(voicesDir)) {
    if (e.path().extension() == ".bin") {
      hasVoice = true;
      break;
    }
  }
  return hasVoice;
}

// Returns first voice name (stem of first .bin found) or empty string.
static std::string getFirstVoiceName(const std::string &baseDir) {
  fs::path voicesDir = fs::path(baseDir) / "voices";
  if (!fs::exists(voicesDir) || !fs::is_directory(voicesDir)) {
    return "";
  }
  for (const auto &e : fs::directory_iterator(voicesDir)) {
    if (e.path().extension() == ".bin") {
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
      GTEST_SKIP() << "Supertonic model dir not found or incomplete: "
                   << baseDir_
                   << " (set SUPERTONIC_MODEL_DIR or run from package root with models/supertonic)";
    }
    voiceName_ = getFirstVoiceName(baseDir_);
    if (voiceName_.empty()) {
      GTEST_SKIP() << "No voice .bin found under " << baseDir_ << "/voices";
    }
  }
};

TEST_F(SupertonicIntegrationTest, loadAndSynthesize) {
  std::unordered_map<std::string, std::string> config;
  fs::path base(baseDir_);
  config["textEncoderPath"] = (base / "onnx" / "text_encoder.onnx").string();
  config["latentDenoiserPath"] = (base / "onnx" / "latent_denoiser.onnx").string();
  config["voiceDecoderPath"] = (base / "onnx" / "voice_decoder.onnx").string();
  config["tokenizerPath"] = (base / "tokenizer.json").string();
  config["voicesDir"] = (base / "voices").string();
  config["voiceName"] = voiceName_;
  config["language"] = "en";
  config["speed"] = "1.0";
  config["numInferenceSteps"] = "5";

  TTSModel model(config, {});

  ASSERT_TRUE(model.isLoaded()) << "Model should be loaded after construction";

  TTSModel::Output output = model.process("Hello.");
  EXPECT_FALSE(output.empty()) << "Synthesis should produce non-empty PCM";
  EXPECT_GT(output.size(), 1000u)
      << "Short phrase should yield at least ~1k samples at 44.1kHz";
}

TEST_F(SupertonicIntegrationTest, unloadAfterSynthesize) {
  std::unordered_map<std::string, std::string> config;
  fs::path base(baseDir_);
  config["textEncoderPath"] = (base / "onnx" / "text_encoder.onnx").string();
  config["latentDenoiserPath"] = (base / "onnx" / "latent_denoiser.onnx").string();
  config["voiceDecoderPath"] = (base / "onnx" / "voice_decoder.onnx").string();
  config["tokenizerPath"] = (base / "tokenizer.json").string();
  config["voicesDir"] = (base / "voices").string();
  config["voiceName"] = voiceName_;
  config["language"] = "en";

  TTSModel model(config, {});
  ASSERT_TRUE(model.isLoaded());

  TTSModel::Output output = model.process("Hi");
  EXPECT_FALSE(output.empty());

  model.unload();
  EXPECT_FALSE(model.isLoaded());
}

} // namespace qvac::ttslib::addon_model::testing
