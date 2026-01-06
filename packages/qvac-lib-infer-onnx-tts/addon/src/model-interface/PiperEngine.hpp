#pragma once

#include <string>
#include <string_view>
#include <optional>
#include <cstdint>
#include <vector>

#include "IPiperEngine.hpp"
#include "piper/piper.hpp"

namespace qvac::ttslib::piper {

class PiperEngine : public IPiperEngine {
public:
  explicit PiperEngine(const TTSConfig& cfg);
  ~PiperEngine() override;

  void load(const TTSConfig& cfg) override;
  
  void unload() override;

  AudioResult synthesize(const std::string& text) override;

private:
  void loadVoice(const TTSConfig& cfg);
  void initialize();
  void cleanup();
  void configureESpeak(const std::string& lang, const std::string& espeakNgDataPath);
  std::vector<int16_t> generateAudio(const std::string& text);
  void audioCallback();
  Ort::SessionOptions getOrtSessionOptions(bool useGPU);

  ::piper::PiperConfig piperConfig_;
  ::piper::Voice voice_;
  std::optional<::piper::SpeakerId> speakerId_;
  bool initialized_ = false;
  std::vector<int16_t> audioBuffer_;
  std::vector<int16_t> collectedAudio_;
};

} // namespace qvac::ttslib::piper
