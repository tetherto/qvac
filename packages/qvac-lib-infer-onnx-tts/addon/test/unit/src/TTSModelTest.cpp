#include <gtest/gtest.h>
#include "mocks/PiperEngineMock.hpp"
#include "src/model-interface/TTSModel.hpp"

#include <filesystem>

using namespace qvac::ttslib::piper::testing;

namespace qvac::ttslib::addon_model::testing {

class TTSModelTest : public ::testing::Test {
public: 
  const std::filesystem::path basePath_ = std::filesystem::path("../../../../models/tts/");
  const std::filesystem::path modelPath_ = basePath_ / "en_US-amy-low.onnx";
  const std::filesystem::path eSpeakDataPath_ = basePath_ / "espeak-ng-data";
  const std::filesystem::path configJsonPath_ = basePath_ / "en_US-amy-low.onnx.json";

  std::unordered_map<std::string, std::string> config_{
    {"modelPath", modelPath_.string()}, {"language", "en"},
    {"eSpeakDataPath", eSpeakDataPath_.string()}, {"configJsonPath", configJsonPath_.string()}};

};

TEST_F(TTSModelTest, positiveInit) {
  EXPECT_NO_THROW(TTSModel model(config_));
}

TEST_F(TTSModelTest, positiveUnload) {
  TTSModel model(config_);
  EXPECT_NO_THROW(model.unload());
}

TEST_F(TTSModelTest, positiveUnloadWeights) {
  TTSModel model(config_);
  EXPECT_NO_THROW(model.unloadWeights());
}

TEST_F(TTSModelTest, positiveLoad) {
  TTSModel model(config_);
  EXPECT_NO_THROW(model.load());
}

TEST_F(TTSModelTest, positiveReload) {
  TTSModel model(config_);
  EXPECT_NO_THROW(model.reload());
}

TEST_F(TTSModelTest, positiveSaveLoadParams) {
  TTSModel model(config_);
  EXPECT_NO_THROW(model.saveLoadParams(config_));
}

TEST_F(TTSModelTest, positiveReset) {
  TTSModel model(config_);
  EXPECT_NO_THROW(model.reset());
}

TEST_F(TTSModelTest, positiveInitializeBackend) {
  TTSModel model(config_);
  EXPECT_NO_THROW(model.initializeBackend());
}

TEST_F(TTSModelTest, positiveIsLoadedTrue) {
  TTSModel model(config_);
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelTest, positiveIsLoadedFalse) {
  TTSModel model(config_);
  model.unload();
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(TTSModelTest, positiveProcess) {
  TTSModel model(config_);
  const TTSModel::Output output = model.process("Hello, world!");
  EXPECT_GT(output.size(), 0);
}

TEST_F(TTSModelTest, positiveProcessWithConsumer) {
  TTSModel model(config_);

  bool called = false;

  auto consumer = [&called](const TTSModel::Output& audio) {
    called = true;
  };
  
  TTSModel::Output output = model.process("Hello, world!", consumer);
  EXPECT_GT(output.size(), 0);
  EXPECT_TRUE(called);
}

TEST_F(TTSModelTest, positiveRuntimeStats) {
  TTSModel model(config_);
  EXPECT_NO_THROW(qvac_lib_inference_addon_cpp::RuntimeStats stats = model.runtimeStats());
}

} // namespace qvac::ttslib::addon_model::testing