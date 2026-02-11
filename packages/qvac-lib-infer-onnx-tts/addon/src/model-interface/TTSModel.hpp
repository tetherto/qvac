#pragma once

#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>

#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"
#include "src/model-interface/IChatterboxEngine.hpp"
#include "src/model-interface/IPiperEngine.hpp"

namespace qvac::ttslib::addon_model {

enum class EngineType { Piper, Chatterbox };

// Adapter compatible with ModelInterface (declarations only)
class TTSModel {
public:
  using Input = std::string;
  using InputView = std::string_view;
  using Output = std::vector<int16_t>;

  TTSModel(const std::unordered_map<std::string, std::string> &configMap,
           const std::vector<float> &referenceAudio = {},
           std::shared_ptr<piper::IPiperEngine> piperEngine = nullptr,
           std::shared_ptr<chatterbox::IChatterboxEngine> chatterboxEngine =
               nullptr);

  void unload();
  void unloadWeights() {};
  void load();
  void reload();
  void
  saveLoadParams(const std::unordered_map<std::string, std::string> &configMap);

  void reset();
  void initializeBackend();
  bool isLoaded() const;

  Output process(const Input &text);
  Output process(const Input &text,
                 const std::function<void(const Output &)> &consumer);
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const;

  // Set reference audio for Chatterbox voice cloning
  void setReferenceAudio(const std::vector<float> &referenceAudio);

private:
  EngineType engineType_ = EngineType::Piper;
  std::shared_ptr<piper::IPiperEngine> piperEngine_;
  std::shared_ptr<chatterbox::IChatterboxEngine> chatterboxEngine_;
  TTSConfig piperConfig_;
  chatterbox::ChatterboxConfig chatterboxConfig_;
  bool configSet_ = false;

  double totalTime_ = 0.0;
  double tokensPerSecond_ = 0.0;
  double realTimeFactor_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  size_t textLength_ = 0;
  bool loaded_ = false;

  EngineType detectEngineType(
      const std::unordered_map<std::string, std::string> &configMap) const;
  qvac::ttslib::TTSConfig createTTSConfig(
      const std::unordered_map<std::string, std::string> &configMap);
  chatterbox::ChatterboxConfig createChatterboxConfig(
      const std::unordered_map<std::string, std::string> &configMap);
  bool isConfigValid(const qvac::ttslib::TTSConfig &config) const;
  bool
  isChatterboxConfigValid(const chatterbox::ChatterboxConfig &config) const;
  void resetRuntimeStats();
};

} // namespace qvac::ttslib::addon_model
