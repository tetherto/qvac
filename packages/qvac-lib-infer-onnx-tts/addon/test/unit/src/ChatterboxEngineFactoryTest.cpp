#include "mocks/OnnxInferSessionMock.hpp"
#include "src/model-interface/ChatterboxEngine.hpp"
#include "src/model-interface/IChatterboxEngine.hpp"
#include <cstdlib>
#include <fstream>
#include <gtest/gtest.h>
#include <memory>
#include <string>
#include <vector>

namespace qvac::ttslib::chatterbox::testing {

static std::string getTokenizerPathFromEnv() {
  const char *path = std::getenv("CHATTERBOX_TOKENIZER_PATH");
  if (path == nullptr || path[0] == '\0') {
    return "";
  }
  std::ifstream f(path);
  if (!f.good()) {
    return "";
  }
  return path;
}

TEST(ChatterboxEngineFactoryTest, injectedFactoryIsUsedWhenLoadingSessions) {
  const std::string tokenizerPath = getTokenizerPathFromEnv();
  if (tokenizerPath.empty()) {
    GTEST_SKIP()
        << "Set CHATTERBOX_TOKENIZER_PATH to a valid tokenizer.json to run";
  }

  std::vector<std::string> factoryInvokedPaths;
  ChatterboxEngine::SessionFactory factory =
      [&factoryInvokedPaths](const std::string &path) {
        factoryInvokedPaths.push_back(path);
        return std::make_unique<OnnxInferSessionMock>();
      };

  const std::vector<float> referenceAudio = {0.1f, 0.2f, 0.3f, 0.4f, 0.5f};
  const std::string speechPath = "speech_encoder.onnx";
  const std::string embedPath = "embed_tokens.onnx";
  const std::string condDecPath = "conditional_decoder.onnx";
  const std::string langPath = "language_model.onnx";

  ChatterboxConfig config{"en",      referenceAudio, tokenizerPath, speechPath,
                          embedPath, condDecPath,    langPath,      false};

  ChatterboxEngine engine(config, factory);

  ASSERT_TRUE(engine.isLoaded());
  EXPECT_EQ(factoryInvokedPaths.size(), 4u);
  EXPECT_EQ(factoryInvokedPaths[0], speechPath);
  EXPECT_EQ(factoryInvokedPaths[1], embedPath);
  EXPECT_EQ(factoryInvokedPaths[2], condDecPath);
  EXPECT_EQ(factoryInvokedPaths[3], langPath);
}

TEST(ChatterboxEngineFactoryTest,
     constructorAcceptsNullFactoryWithLazyLoading) {
  const std::string tokenizerPath = getTokenizerPathFromEnv();
  if (tokenizerPath.empty()) {
    GTEST_SKIP()
        << "Set CHATTERBOX_TOKENIZER_PATH to a valid tokenizer.json to run";
  }

  const std::vector<float> referenceAudio = {0.1f, 0.2f, 0.3f, 0.4f, 0.5f};
  const std::string dummyPath = "dummy.onnx";
  ChatterboxConfig config{"en",      referenceAudio, tokenizerPath, dummyPath,
                          dummyPath, dummyPath,      dummyPath,     true};

  EXPECT_NO_THROW({
    ChatterboxEngine engine(config, nullptr);
    EXPECT_TRUE(engine.isLoaded());
  });
}

} // namespace qvac::ttslib::chatterbox::testing
