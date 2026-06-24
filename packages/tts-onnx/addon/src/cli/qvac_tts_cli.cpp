#include <chrono>
#include <iostream>
#include <string>
#include <unordered_map>

#include "src/addon/AddonCpp.hpp"
#include "src/model-interface/TTSModel.hpp"

static int run_addon_tts() {
  std::cerr << "[qvac-tts-cli] Starting CLI (AddonCpp + TTSModel)..."
            << std::endl;

  std::unordered_map<std::string, std::string> configMap{
      {"language", "en"},
      {"tokenizerPath", "./models/chatterbox/tokenizer.json"},
      {"speechEncoderPath", "./models/chatterbox/speech_encoder.onnx"},
      {"embedTokensPath", "./models/chatterbox/embed_tokens.onnx"},
      {"conditionalDecoderPath",
       "./models/chatterbox/conditional_decoder.onnx"},
      {"languageModelPath", "./models/chatterbox/language_model.onnx"}};

  std::vector<float> referenceAudio = {0.1f, 0.2f, 0.3f};
  std::string text = "Hello world - TTS test from AddonCpp";

  auto addonInstance =
      qvac_lib_inference_addon_tts::createInstance(
          std::move(configMap), std::move(referenceAudio));
  addonInstance.addon->activate();

  qvac::ttslib::addon_model::TTSModel::AnyInput input{
      .text = text, .config = {}};
  const bool accepted = addonInstance.addon->runJob(std::move(input));
  if (!accepted) {
    std::cerr << "[qvac-tts-cli] Failed to enqueue job (addon busy)" << std::endl;
    return 1;
  }
  std::cerr << "[qvac-tts-cli] Job submitted successfully" << std::endl;

  auto output = addonInstance.outputHandler->tryPop(std::chrono::seconds(120));
  if (!output.has_value()) {
    std::cerr << "[qvac-tts-cli] Timed out waiting for output" << std::endl;
    return 1;
  }

  std::cerr << "[qvac-tts-cli] Received audio samples: " << output->size()
            << std::endl;
  return 0;
}

int main(int argc, char *argv[]) { return run_addon_tts(); }
