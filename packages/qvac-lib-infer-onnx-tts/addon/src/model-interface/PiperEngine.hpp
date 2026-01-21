#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "IPiperEngine.hpp"
#include "TashkeelDiacritizer.hpp"
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

  // Tashkeel (Arabic diacritization) support
  void initializeTashkeel(const std::string &tashkeelModelDir);
  std::string preprocessText(const std::string &text);
  bool isArabicLanguage() const;

  ::piper::PiperConfig piperConfig_;
  ::piper::Voice voice_;
  std::optional<::piper::SpeakerId> speakerId_;
  bool initialized_ = false;
  std::vector<int16_t> audioBuffer_;
  std::vector<int16_t> collectedAudio_;

  // Tashkeel diacritizer for Arabic
  std::unique_ptr<tashkeel::TashkeelDiacritizer> tashkeel_;
  std::string language_;
};

} // namespace qvac::ttslib::piper
