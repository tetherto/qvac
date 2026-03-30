#include "src/model-interface/OnnxInferSession.hpp"
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <gtest/gtest.h>
#include <string>

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

static std::string resolveOnnxModelPath() {
  const char *envPath = std::getenv("ONNX_TEST_MODEL_PATH");
  if (envPath != nullptr && envPath[0] != '\0') {
    std::ifstream f(envPath);
    if (f.good()) {
      return envPath;
    }
  }

  std::string exe = getExecutablePath();
  if (exe.empty()) {
    return "";
  }
  fs::path exeDir = fs::path(exe).parent_path();
  fs::path root = exeDir / ".." / ".." / ".." / "..";
  std::error_code ec;
  fs::path canonicalRoot = fs::canonical(root, ec);
  if (ec) {
    return "";
  }

  const std::string candidates[] = {
      (canonicalRoot / "models" / "chatterbox" / "embed_tokens.onnx").string(),
      (canonicalRoot / "models" / "chatterbox" / "embed_tokens_fp16.onnx")
          .string(),
  };
  for (const auto &path : candidates) {
    std::ifstream f(path);
    if (f.good()) {
      return path;
    }
  }
  return "";
}

TEST(OnnxInferSessionIntegrationTest, sessionLoadsAndRunWithRealModel) {
  const std::string modelPath = resolveOnnxModelPath();
  if (modelPath.empty()) {
    GTEST_SKIP() << "Set ONNX_TEST_MODEL_PATH or run integration to have "
                    "models/chatterbox/embed_tokens.onnx";
  }

  OnnxInferSession session(modelPath);

  std::vector<std::string> inputNames = session.getInputNames();
  std::vector<std::string> outputNames = session.getOutputNames();
  EXPECT_FALSE(inputNames.empty());
  EXPECT_FALSE(outputNames.empty());

  std::vector<std::vector<int64_t>> inputShapes;
  if (inputNames.size() == 1u) {
    inputShapes.push_back({1, 1});
  } else if (inputNames.size() >= 3u) {
    inputShapes.push_back({1, 1});
    inputShapes.push_back({1, 1});
    inputShapes.push_back({1});
  } else {
    for (size_t i = 0; i < inputNames.size(); i++) {
      inputShapes.push_back({1, 1});
    }
  }

  session.initInputTensors(inputShapes);

  OrtTensor inputTensor = session.getInput(inputNames[0]);
  EXPECT_FALSE(inputTensor.name.empty());
  EXPECT_EQ(inputTensor.shape.size(), 2u);
  if (inputTensor.shape[0] >= 1 && inputTensor.shape[1] >= 1 &&
      inputTensor.data != nullptr) {
    static_cast<int64_t *>(inputTensor.data)[0] = 0;
  }

  session.run();

  OrtTensor outputTensor = session.getOutput(outputNames[0]);
  EXPECT_FALSE(outputTensor.name.empty());
  EXPECT_TRUE(outputTensor.data != nullptr);
}

TEST(OnnxInferSessionIntegrationTest,
     getInputNamesAndGetOutputNamesReturnModelMetadata) {
  const std::string modelPath = resolveOnnxModelPath();
  if (modelPath.empty()) {
    GTEST_SKIP() << "Set ONNX_TEST_MODEL_PATH or run integration to have "
                    "models/chatterbox/embed_tokens.onnx";
  }

  OnnxInferSession session(modelPath);

  std::vector<std::string> inputNames = session.getInputNames();
  std::vector<std::string> outputNames = session.getOutputNames();

  EXPECT_GE(inputNames.size(), 1u);
  EXPECT_GE(outputNames.size(), 1u);
}

} // namespace qvac::ttslib::chatterbox::testing
