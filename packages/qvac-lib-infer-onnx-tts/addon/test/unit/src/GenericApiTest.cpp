#include "qvac-lib-inference-addon-cpp/ModelApiTest.hpp"
#include "src/model-interface/TTSModel.hpp"
#include "src/model-interface/PiperEngine.hpp"

#include <filesystem>

using namespace qvac::ttslib::addon_model;
using namespace qvac::ttslib::piper;

namespace qvac_model_api_tests {

TTSModel make_valid_model()
{
  const std::filesystem::path basePath = std::filesystem::path("../../../../models/tts/");
  const std::filesystem::path modelPath = basePath / "en_US-amy-low.onnx";
  const std::filesystem::path eSpeakDataPath = basePath / "espeak-ng-data";
  const std::filesystem::path configJsonPath = basePath / "en_US-amy-low.onnx.json";
  
  const std::unordered_map<std::string, std::string> config {
    {"modelPath", modelPath.string()}, {"language", "en"},
    {"eSpeakDataPath", eSpeakDataPath.string()}, {"configJsonPath", configJsonPath.string()}};

  return TTSModel(config);
}

TTSModel make_invalid_model()
{
  const std::unordered_map<std::string, std::string> invalidConfig{};
  
  return TTSModel(invalidConfig);
}

typename TTSModel::Input make_valid_input()
{
    return "Hello, world!";
}

typename TTSModel::Input make_empty_input()
{
    return "";
}

MODEL_API_INSTANTIATE_TESTS(TTSModel);

} // namespace qvac_model_api_tests