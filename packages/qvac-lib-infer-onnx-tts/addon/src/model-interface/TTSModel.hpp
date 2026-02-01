#pragma once

#include <functional>
#include <string>
#include <string_view>
#include <memory>
#include <unordered_map>
#include <chrono>

#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"
#include "src/model-interface/IPiperEngine.hpp"

namespace qvac::ttslib::addon_model {

// Adapter compatible with ModelInterface (declarations only)
class TTSModel {
public:
  using Input = std::string;
  using InputView = std::string_view;
  using Output = std::vector<int16_t>;

  TTSModel(const std::unordered_map<std::string, std::string>& configMap, std::shared_ptr<piper::IPiperEngine> engine = nullptr);

  void unload();
  void unloadWeights() {};
  void load();
  void reload();
  void saveLoadParams(const std::unordered_map<std::string, std::string>& configMap);

  void reset();
  void initializeBackend();
  bool isLoaded() const;

  Output process(const Input& text);
  Output process(const Input& text, const std::function<void(const Output&)>& consumer);
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const;

private:
  std::shared_ptr<piper::IPiperEngine> engine_;
  TTSConfig config_;
  bool configSet_ = false;
  
  double totalTime_ = 0.0;
  double tokensPerSecond_ = 0.0;
  double realTimeFactor_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  size_t textLength_ = 0;
  bool loaded_ = false;
  
  qvac::ttslib::TTSConfig createTTSConfig(const std::unordered_map<std::string, std::string>& configMap);
  bool isConfigValid(const qvac::ttslib::TTSConfig& config) const;
  void resetRuntimeStats();
};

} // namespace qvac::ttslib::addon_model
