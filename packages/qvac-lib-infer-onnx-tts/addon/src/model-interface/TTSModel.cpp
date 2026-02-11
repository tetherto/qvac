#include "TTSModel.hpp"

#include <sstream>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "src/addon/TTSErrors.hpp"
#include "src/model-interface/ChatterboxEngine.hpp"
#include "src/model-interface/PiperEngine.hpp"

using namespace qvac::ttslib::addon_model;
using namespace qvac_lib_inference_addon_cpp::logger;

TTSModel::TTSModel(
    const std::unordered_map<std::string, std::string> &configMap,
    const std::vector<float> &referenceAudio,
    std::shared_ptr<piper::IPiperEngine> piperEngine,
    std::shared_ptr<chatterbox::IChatterboxEngine> chatterboxEngine) {
  engineType_ = detectEngineType(configMap);

  chatterboxConfig_.referenceAudio = referenceAudio;

  saveLoadParams(configMap);

  if (engineType_ == EngineType::Chatterbox) {
    if (chatterboxEngine) {
      chatterboxEngine_ = chatterboxEngine;
    } else {
      chatterboxEngine_ =
          std::make_shared<chatterbox::ChatterboxEngine>(chatterboxConfig_);
    }
    QLOG(Priority::INFO, "TTSModel initialized with Chatterbox engine");
  } else {
    if (piperEngine) {
      piperEngine_ = piperEngine;
    } else {
      piperEngine_ = std::make_shared<piper::PiperEngine>(piperConfig_);
    }
    QLOG(Priority::INFO, "TTSModel initialized with Piper engine");
  }

  load();
  QLOG(Priority::INFO, "TTSModel initialized successfully");
}

EngineType TTSModel::detectEngineType(
    const std::unordered_map<std::string, std::string> &configMap) const {
  // If Chatterbox-specific config keys are present, use Chatterbox
  if (configMap.find("tokenizerPath") != configMap.end() ||
      configMap.find("speechEncoderPath") != configMap.end() ||
      configMap.find("embedTokensPath") != configMap.end()) {
    return EngineType::Chatterbox;
  }
  // Default to Piper
  return EngineType::Piper;
}

qvac::ttslib::TTSConfig TTSModel::createTTSConfig(
    const std::unordered_map<std::string, std::string> &configMap) {
  qvac::ttslib::TTSConfig config = piperConfig_;

  auto updateConfig = [&](const std::string &key, std::string &configField) {
    auto it = configMap.find(key);
    if (it != configMap.end()) {
      configField = it->second;
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
  ss << "Piper config values: modelPath='" << config.modelPath << "' language='"
     << config.language << "'"
     << "' eSpeakDataPath='" << config.eSpeakDataPath << "'"
     << "' configJsonPath='" << config.configJsonPath << "'"
     << "' tashkeelModelDir='" << config.tashkeelModelDir << "'"
     << "' useGPU=" << (config.useGPU ? "true" : "false") << "'";
  QLOG(Priority::INFO, ss.str());

  return config;
}

qvac::ttslib::chatterbox::ChatterboxConfig TTSModel::createChatterboxConfig(
    const std::unordered_map<std::string, std::string> &configMap) {
  qvac::ttslib::chatterbox::ChatterboxConfig config = chatterboxConfig_;

  auto updateConfig = [&](const std::string &key, std::string &configField) {
    auto it = configMap.find(key);
    if (it != configMap.end()) {
      configField = it->second;
    }
  };
  updateConfig("language", config.language);
  updateConfig("tokenizerPath", config.tokenizerPath);
  updateConfig("speechEncoderPath", config.speechEncoderPath);
  updateConfig("embedTokensPath", config.embedTokensPath);
  updateConfig("conditionalDecoderPath", config.conditionalDecoderPath);
  updateConfig("languageModelPath", config.languageModelPath);

  std::stringstream ss;
  ss << "Chatterbox config values: language='" << config.language << "'"
     << "' referenceAudio.size()=" << config.referenceAudio.size()
     << " tokenizerPath='" << config.tokenizerPath << "'"
     << "' speechEncoderPath='" << config.speechEncoderPath << "'"
     << "' embedTokensPath='" << config.embedTokensPath << "'"
     << "' conditionalDecoderPath='" << config.conditionalDecoderPath << "'"
     << "' languageModelPath='" << config.languageModelPath << "'";
  QLOG(Priority::INFO, ss.str());

  return config;
}

bool TTSModel::isConfigValid(const qvac::ttslib::TTSConfig &config) const {
  return !config.modelPath.empty() && !config.language.empty() &&
         !config.eSpeakDataPath.empty() && !config.configJsonPath.empty();
}

bool TTSModel::isChatterboxConfigValid(
    const chatterbox::ChatterboxConfig &config) const {
  return !config.language.empty() && !config.referenceAudio.empty() &&
         !config.tokenizerPath.empty() && !config.speechEncoderPath.empty() &&
         !config.embedTokensPath.empty() &&
         !config.conditionalDecoderPath.empty() &&
         !config.languageModelPath.empty();
}

void TTSModel::saveLoadParams(
    const std::unordered_map<std::string, std::string> &configMap) {
  if (engineType_ == EngineType::Chatterbox) {
    chatterboxConfig_ = createChatterboxConfig(configMap);
    configSet_ = isChatterboxConfigValid(chatterboxConfig_);
  } else {
    piperConfig_ = createTTSConfig(configMap);
    configSet_ = isConfigValid(piperConfig_);
  }
}

void TTSModel::load() {
  if (!configSet_) {
    QLOG(Priority::ERROR, "Config is not valid, loading failed.");
    return;
  }

  if (engineType_ == EngineType::Chatterbox) {
    chatterboxEngine_->load(chatterboxConfig_);
    loaded_ = chatterboxEngine_->isLoaded();
    QLOG(Priority::INFO, "Chatterbox TTS model loaded successfully");
  } else {
    piperEngine_->load(piperConfig_);
    loaded_ = true;
    QLOG(Priority::INFO, "Piper TTS model loaded successfully");
  }
}

void TTSModel::reload() {
  unload();
  load();
}

void TTSModel::unload() {
  if (engineType_ == EngineType::Chatterbox) {
    if (chatterboxEngine_) {
      chatterboxEngine_->unload();
    }
  } else {
    if (piperEngine_) {
      piperEngine_->unload();
    }
  }
  loaded_ = false;
  QLOG(Priority::INFO, "TTS model unloaded successfully");
}

void TTSModel::reset() { resetRuntimeStats(); }

void TTSModel::initializeBackend() {
  // No-op: backend initialized by engine construction/init
}

bool TTSModel::isLoaded() const { return loaded_; }

TTSModel::Output TTSModel::process(const Input &text) {
  if (text.empty() || text == " ") {
    return {};
  }

  if (!isLoaded()) {
    QLOG(Priority::ERROR, "Model not loaded, processing failed.");
    throw qvac_errors::createTTSError(qvac_errors::tts_error::ModelNotLoaded,
                                      "Model not loaded");
  }

  auto startTime = std::chrono::high_resolution_clock::now();
  textLength_ += text.size();

  AudioResult result;
  if (engineType_ == EngineType::Chatterbox) {
    result = chatterboxEngine_->synthesize(text);
  } else {
    result = piperEngine_->synthesize(text);
  }

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

TTSModel::Output
TTSModel::process(const Input &text,
                  const std::function<void(const Output &)> &consumer) {
  const auto &result = process(text);

  if (consumer) {
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

void TTSModel::setReferenceAudio(const std::vector<float> &referenceAudio) {
  chatterboxConfig_.referenceAudio = referenceAudio;
  QLOG(Priority::INFO,
       "Reference audio set, size: " + std::to_string(referenceAudio.size()));
}