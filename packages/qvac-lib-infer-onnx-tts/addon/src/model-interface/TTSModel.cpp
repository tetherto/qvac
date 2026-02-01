#include "TTSModel.hpp"

#include "src/addon/TTSErrors.hpp"
#include "src/model-interface/PiperEngine.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#include <sstream>

using namespace qvac::ttslib::addon_model;
using namespace qvac_lib_inference_addon_cpp::logger;

TTSModel::TTSModel(const std::unordered_map<std::string, std::string>& configMap, std::shared_ptr<piper::IPiperEngine> engine) {
  saveLoadParams(configMap);
  if (engine) {
    engine_ = engine;
  } else {
    engine_ = std::make_shared<piper::PiperEngine>(config_);
  }
  load();
  QLOG(Priority::INFO, "TTSModel initialized successfully");
}

qvac::ttslib::TTSConfig TTSModel::createTTSConfig(const std::unordered_map<std::string, std::string>& configMap) {
  qvac::ttslib::TTSConfig config = config_;
  
  auto updateConfig = [&](const std::string& key, std::string& config) {
    auto it = configMap.find(key);
    if (it != configMap.end()) {
      config = it->second;
    }
  };
  updateConfig("modelPath", config.modelPath);
  updateConfig("language", config.language);
  updateConfig("eSpeakDataPath", config.eSpeakDataPath);
  updateConfig("configJsonPath", config.configJsonPath);
  updateConfig("tashkeelModelDir", config.tashkeelModelDir);

  auto useGPUIt = configMap.find("useGPU");
  if (useGPUIt != configMap.end()) {
    config.useGPU = (useGPUIt->second == "true");
  }

  std::stringstream ss;
  ss << "Config values: modelPath='" << config.modelPath << "' language='"
     << config.language << "'"
     << "' eSpeakDataPath='" << config.eSpeakDataPath << "'"
     << "' configJsonPath='" << config.configJsonPath << "'"
     << "' tashkeelModelDir='" << config.tashkeelModelDir << "'"
     << "' useGPU=" << (config.useGPU ? "true" : "false") << "'";
  QLOG(Priority::INFO, ss.str());

  return config;
}

bool TTSModel::isConfigValid(const qvac::ttslib::TTSConfig& config) const {
  return !config.modelPath.empty() && !config.language.empty() && !config.eSpeakDataPath.empty() && !config.configJsonPath.empty();
}

void TTSModel::saveLoadParams(const std::unordered_map<std::string, std::string>& configMap) {
  config_ = createTTSConfig(configMap);
  configSet_ = isConfigValid(config_);
}

void TTSModel::load() {
  if (!configSet_) {
    QLOG(Priority::ERROR, "Config is not valid, loading failed.");
    return;
  }

  engine_->load(config_);
  loaded_ = true;
  QLOG(Priority::INFO, "TTS model loaded successfully");
}

void TTSModel::reload() {
  unload();
  load();
}

void TTSModel::unload() {
  engine_->unload();
  loaded_ = false;
  QLOG(Priority::INFO, "TTS model unloaded successfully");
}

void TTSModel::reset() {
  resetRuntimeStats();
}

void TTSModel::initializeBackend() {
  // No-op: backend initialized by engine construction/init
}

bool TTSModel::isLoaded() const {
  return loaded_;
}

TTSModel::Output TTSModel::process(const Input &text) {
  if (text.empty() || text == " ") {
    return {};
  }

  if (!isLoaded()) {
    QLOG(Priority::ERROR, "Model not loaded, processing failed.");
    throw qvac_errors::createTTSError(qvac_errors::tts_error::ModelNotLoaded, "Model not loaded");
  }
  
  auto startTime = std::chrono::high_resolution_clock::now();
  textLength_ += text.size();
  
  AudioResult result = engine_->synthesize(text);
  
  auto endTime = std::chrono::high_resolution_clock::now();
  totalTime_ += std::chrono::duration<double>(endTime - startTime).count();
  
  audioDurationMs_ += result.durationMs;
  totalSamples_ += static_cast<int64_t>(result.samples);
  
  if (audioDurationMs_ > 0) {
    realTimeFactor_ = (totalTime_ * 1000.0) / audioDurationMs_;
  } else {
    realTimeFactor_ = 0.0;
  }
  
  if (totalTime_ > 0) {
    tokensPerSecond_ = textLength_ / totalTime_;
  } else {
    tokensPerSecond_ = 0.0;
  }
  
  return result.pcm16;
}

TTSModel::Output TTSModel::process(
    const Input &text,
    const std::function<void(const Output&)> &consumer) {
  const auto& result = process(text);
  
  if (consumer)  {
    consumer(result);
  }

  return result;
}

qvac_lib_inference_addon_cpp::RuntimeStats TTSModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("tokensPerSecond", tokensPerSecond_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("totalSamples", totalSamples_);
  
  return stats;
}

void TTSModel::resetRuntimeStats() {
  totalTime_ = 0.0;
  tokensPerSecond_ = 0.0;
  realTimeFactor_ = 0.0;
  audioDurationMs_ = 0.0;
  totalSamples_ = 0;
  textLength_ = 0;
}