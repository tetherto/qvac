#include <filesystem>
#include <iostream>
#include <string>
#include <unordered_map>

#include "cli/AddonShim.hpp"
#include "src/model-interface/TTSModel.hpp"

namespace fs = std::filesystem;

static int run_addon_tts() {
  std::cerr << "[qvac-tts-cli] Starting CLI (AddonShim<TTSModel>)..."
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
  std::string text = "Hello world - TTS test from AddonShim";

  qvac::ttslib::cli_shim::TTSAddonShim shim(configMap, referenceAudio);
  shim.activate();
  uint32_t jobId = shim.append(text);
  std::cerr << "[qvac-tts-cli] Submitted job id=" << jobId << std::endl;

  bool done = false;
  while (!done) {
    std::vector<qvac::ttslib::cli_shim::TTSAddonShim::Event> events;
    if (shim.poll(events)) {
      for (auto &ev : events) {
        switch (ev.type) {
        case qvac::ttslib::cli_shim::TTSAddonShim::EventType::JobStarted:
          std::cerr << "[addon-shim] JobStarted id=" << ev.jobId << std::endl;
          break;
        case qvac::ttslib::cli_shim::TTSAddonShim::EventType::Output:
          std::cerr << "[addon-shim] Output path=" << ev.payload << std::endl;
          break;
        case qvac::ttslib::cli_shim::TTSAddonShim::EventType::Error:
          std::cerr << "[addon-shim] Error=" << ev.payload << std::endl;
          break;
        case qvac::ttslib::cli_shim::TTSAddonShim::EventType::JobEnded:
          std::cerr << "[addon-shim] JobEnded id=" << ev.jobId << std::endl;
          done = true;
          break;
        }
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }

  return 0;
}

int main(int argc, char *argv[]) { return run_addon_tts(); }
