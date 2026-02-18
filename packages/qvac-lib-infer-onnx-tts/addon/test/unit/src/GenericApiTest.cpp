#include "qvac-lib-inference-addon-cpp/ModelApiTest.hpp"
#include "mocks/ChatterboxEngineMock.hpp"
#include "src/model-interface/TTSModel.hpp"

using namespace qvac::ttslib::addon_model;
using namespace qvac::ttslib::chatterbox::testing;

namespace qvac_model_api_tests {

static std::shared_ptr<ChatterboxEngineMock> g_validMock;
static std::shared_ptr<ChatterboxEngineMock> g_invalidMock;

TTSModel make_valid_model() {
  g_validMock = std::make_shared<ChatterboxEngineMock>();

  EXPECT_CALL(*g_validMock, load(::testing::_)).Times(::testing::AnyNumber());
  EXPECT_CALL(*g_validMock, unload()).Times(::testing::AnyNumber());
  EXPECT_CALL(*g_validMock, isLoaded())
      .WillRepeatedly(::testing::Return(true));

  qvac::ttslib::AudioResult mockResult;
  mockResult.pcm16 = {1, 2, 3, 4, 5};
  mockResult.sampleRate = 24000;
  mockResult.channels = 1;
  mockResult.samples = 5;
  mockResult.durationMs = 100.0;

  EXPECT_CALL(*g_validMock, synthesize(::testing::_))
      .Times(::testing::AnyNumber())
      .WillRepeatedly(::testing::Return(mockResult));

  const std::unordered_map<std::string, std::string> config{
      {"language", "en"},
      {"tokenizerPath", "dummy"},
      {"speechEncoderPath", "dummy"},
      {"embedTokensPath", "dummy"},
      {"conditionalDecoderPath", "dummy"},
      {"languageModelPath", "dummy"}};

  std::vector<float> referenceAudio = {0.1f, 0.2f, 0.3f, 0.4f, 0.5f};

  TTSModel model(config, referenceAudio, g_validMock);
  g_validMock.reset(); // TTSModel now owns the mock; avoid leak at exit so mock is verified
  return model;
}

TTSModel make_invalid_model() {
  const std::unordered_map<std::string, std::string> invalidConfig{};

  return TTSModel(invalidConfig);
}

typename TTSModel::Input make_valid_input() { return "Hello, world!"; }

typename TTSModel::Input make_empty_input() { return ""; }

MODEL_API_INSTANTIATE_TESTS(TTSModel);

} // namespace qvac_model_api_tests