#include <filesystem>
#include <iostream>
#include <string>

#include "cli/AddonShim.hpp"
#include "src/model-interface/TTSModel.hpp"
#include "src/model-interface/PiperEngine.hpp"

namespace fs = std::filesystem;

static int run_direct_tts() {
  std::cerr << "[qvac-tts-cli] Starting CLI (direct TTSModel)." << std::endl;

  std::string modelPath =
      "/Users/freddy/Work/Tether/models/piper/en_US-amy-low.onnx";
  std::string language = "en";
  std::string eSpeakDataPath =
      "/Users/freddy/Work/Tether/models/piper";
  std::string modelConfigPath =
      "/Users/freddy/Work/Tether/models/piper/en_US-amy-low.onnx.json";
  std::string text = "Hello world - TTS test from CLI";

  try {
    qvac::ttslib::TTSConfig config;
    config.modelPath = modelPath;
    config.language = language;
    config.eSpeakDataPath = eSpeakDataPath;
    config.configJsonPath = modelConfigPath;
    qvac::ttslib::addon_model::TTSModel model(config);

    std::cerr << "[qvac-tts-cli] Synthesizing text: '" << text << "'"
              << std::endl;
    std::string outPath = model.process(text);
    std::cerr << "[qvac-tts-cli] Synthesis complete. Output WAV: " << outPath
              << std::endl;
  } catch (const std::exception& e) {
    std::cerr << "[qvac-tts-cli] Error: " << e.what() << std::endl;
    return 1;
  }

  return 0;
}

static int run_addon_tts() {
  std::cerr << "[qvac-tts-cli] Starting CLI (AddonShim<TTSModel>)..."
            << std::endl;

  std::string modelPath =
      "/Users/freddy/Work/Tether/models/piper/en_US-amy-low.onnx";
  std::string language = "en";
  std::string eSpeakDataPath =
      "/Users/freddy/Work/Tether/models/piper";
  std::string modelConfigPath =
      "/Users/freddy/Work/Tether/models/piper/en_US-amy-low.onnx.json";
  std::string text = "Hello world - TTS test from AddonShim";

  qvac::ttslib::TTSConfig config;
  config.modelPath = modelPath;
  config.language = language;
  config.eSpeakDataPath = eSpeakDataPath;
  config.configJsonPath = modelConfigPath;

  qvac::ttslib::cli_shim::TTSAddonShim shim(config);
  shim.activate();
  uint32_t jobId = shim.append(text);
  std::cerr << "[qvac-tts-cli] Submitted job id=" << jobId << std::endl;

  // Simple poll loop until JobEnded
  bool done = false;
  while (!done) {
    std::vector<qvac::ttslib::cli_shim::TTSAddonShim::Event> events;
    if (shim.poll(events)) {
      for (auto& ev : events) {
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

int main(int argc, char* argv[]) {
  bool useAddon = false;
  for (int i = 1; i < argc; ++i) {
    if (std::string(argv[i]) == "--mode=addon")
      useAddon = true;
    if (std::string(argv[i]) == "--mode=direct")
      useAddon = false;
  }
  return useAddon ? run_addon_tts() : run_direct_tts();
}
