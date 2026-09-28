#pragma once

#include <string>
#include <vector>

#include <tts-cpp/voice_controls.h>

// Snapshot of tts-cpp's cross-engine conditioning vocabulary
// (tts-cpp/voice_controls.h). Kept JS-free so it is unit-testable; AddonJs.hpp
// turns it into the object returned by the binding's getVoiceControls().
namespace qvac::ttsggml {

struct EngineVoiceControls {
  std::string engine; // tts-cpp wire name (engine_name)
  std::vector<std::string> emotions;
  std::vector<std::string> paces;
};

struct VoiceControlsCatalog {
  std::vector<std::string> emotions; // canonical vocabulary, model-card order
  std::vector<std::string> paces;
  std::vector<EngineVoiceControls> engines; // tts-cpp declaration order
};

inline VoiceControlsCatalog voiceControlsCatalog() {
  namespace controls = tts_cpp::controls;
  VoiceControlsCatalog catalog;
  catalog.emotions = controls::all_emotions();
  catalog.paces = controls::all_paces();
  for (const controls::EngineId id : controls::all_engines()) {
    catalog.engines.push_back(
        {controls::engine_name(id),
         controls::supported_emotions(id),
         controls::supported_paces(id)});
  }
  return catalog;
}

} // namespace qvac::ttsggml
