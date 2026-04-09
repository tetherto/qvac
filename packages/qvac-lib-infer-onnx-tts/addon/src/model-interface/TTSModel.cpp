#include "TTSModel.hpp"

#include <any>
#include <sstream>
#include <stdexcept>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "src/addon/TTSErrors.hpp"
#include "src/model-interface/ChatterboxEngine.hpp"
#include "src/model-interface/SupertonicEngine.hpp"

using namespace qvac::ttslib::addon_model;
using namespace qvac_lib_inference_addon_cpp::logger;

namespace {

bool isSupertonicOnnxConfigValid(
    const qvac::ttslib::supertonic::SupertonicConfig &c) {
  if (c.language.empty())
    return false;
  const bool haveVoice = !c.voiceStyleJsonPath.empty() ||
                         (!c.modelDir.empty() && !c.voiceName.empty());
  if (!haveVoice)
    return false;
  const bool haveOnnxMeta =
      !c.durationPredictorPath.empty() && !c.textEncoderPath.empty() &&
      !c.vectorEstimatorPath.empty() && !c.vocoderPath.empty() &&
      !c.unicodeIndexerPath.empty() && !c.ttsConfigPath.empty();
  return haveOnnxMeta || !c.modelDir.empty();
}

} // namespace

TTSModel::TTSModel(
    const std::unordered_map<std::string, std::string> &configMap,
    const std::vector<float> &referenceAudio,
    std::shared_ptr<chatterbox::IChatterboxEngine> chatterboxEngine,
    std::shared_ptr<qvac::ttslib::supertonic::ISupertonicEngine> supertonicEngine) {
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
  } else if (engineType_ == EngineType::Supertonic) {
    if (supertonicEngine) {
      supertonicEngine_ = supertonicEngine;
    } else {
      supertonicEngine_ =
          std::make_shared<qvac::ttslib::supertonic::SupertonicEngine>();
    }
    QLOG(Priority::INFO, "TTSModel initialized with Supertonic ONNX engine");
  }

  load();
  QLOG(Priority::INFO, "TTSModel initialized successfully");
}

EngineType TTSModel::detectEngineType(
    const std::unordered_map<std::string, std::string> &configMap) const {
  auto nonEmpty = [](const std::unordered_map<std::string, std::string> &m,
                     const char *k) {
    auto it = m.find(k);
    return it != m.end() && !it->second.empty();
  };
  if (nonEmpty(configMap, "textEncoderPath") ||
      nonEmpty(configMap, "durationPredictorPath") ||
      nonEmpty(configMap, "unicodeIndexerPath") ||
      nonEmpty(configMap, "ttsConfigPath") ||
      nonEmpty(configMap, "vectorEstimatorPath") ||
      nonEmpty(configMap, "vocoderPath") ||
      (nonEmpty(configMap, "modelDir") && nonEmpty(configMap, "voiceName"))) {
    return EngineType::Supertonic;
  }
  return EngineType::Chatterbox;
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

  auto lazyIt = configMap.find("lazySessionLoading");
  if (lazyIt != configMap.end()) {
    config.lazySessionLoading = lazyIt->second == "true";
  }

  auto gpuIt = configMap.find("useGPU");
  if (gpuIt != configMap.end()) {
    config.useGPU = gpuIt->second == "true";
  }

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

bool TTSModel::isChatterboxConfigValid(
    const chatterbox::ChatterboxConfig &config) const {
  return !config.language.empty() && !config.referenceAudio.empty() &&
         !config.tokenizerPath.empty() && !config.speechEncoderPath.empty() &&
         !config.embedTokensPath.empty() &&
         !config.conditionalDecoderPath.empty() &&
         !config.languageModelPath.empty();
}

qvac::ttslib::supertonic::SupertonicConfig TTSModel::createSupertonicConfig(
    const std::unordered_map<std::string, std::string> &configMap) {
  qvac::ttslib::supertonic::SupertonicConfig config = supertonicConfig_;

  auto updateConfig = [&](const std::string &key, std::string &configField) {
    auto it = configMap.find(key);
    if (it != configMap.end()) {
      configField = it->second;
    }
  };
  updateConfig("modelDir", config.modelDir);
  updateConfig("textEncoderPath", config.textEncoderPath);
  updateConfig("voiceName", config.voiceName);
  updateConfig("language", config.language);
  updateConfig("unicodeIndexerPath", config.unicodeIndexerPath);
  updateConfig("ttsConfigPath", config.ttsConfigPath);
  updateConfig("durationPredictorPath", config.durationPredictorPath);
  updateConfig("vectorEstimatorPath", config.vectorEstimatorPath);
  updateConfig("vocoderPath", config.vocoderPath);
  updateConfig("voiceStyleJsonPath", config.voiceStyleJsonPath);

  auto mulIt = configMap.find("supertonicMultilingual");
  if (mulIt != configMap.end()) {
    config.supertonicMultilingual = (mulIt->second == "true");
  }

  auto gpuIt = configMap.find("useGPU");
  if (gpuIt != configMap.end()) {
    config.useGPU = gpuIt->second == "true";
  }

  auto it = configMap.find("speed");
  if (it != configMap.end() && !it->second.empty()) {
    try {
      config.speed = std::stof(it->second);
    } catch (...) {
    }
  }
  it = configMap.find("numInferenceSteps");
  if (it != configMap.end() && !it->second.empty()) {
    try {
      config.numInferenceSteps = std::stoi(it->second);
    } catch (...) {
    }
  }

  std::stringstream ss;
  ss << "Supertone ONNX config: modelDir='" << config.modelDir
     << "' textEncoderPath='" << config.textEncoderPath << "' durationPredictorPath='"
     << config.durationPredictorPath << "' vectorEstimatorPath='"
     << config.vectorEstimatorPath << "' vocoderPath='" << config.vocoderPath
     << "' unicodeIndexerPath='" << config.unicodeIndexerPath << "' ttsConfigPath='"
     << config.ttsConfigPath << "' voiceStyleJsonPath='" << config.voiceStyleJsonPath
     << "' voiceName='" << config.voiceName << "' language='" << config.language
     << "' speed=" << config.speed
     << " numInferenceSteps=" << config.numInferenceSteps
     << " supertonicMultilingual=" << (config.supertonicMultilingual ? "true" : "false");
  QLOG(Priority::INFO, ss.str());

  return config;
}

bool TTSModel::isSupertonicConfigValid(
    const qvac::ttslib::supertonic::SupertonicConfig &config) const {
  return isSupertonicOnnxConfigValid(config);
}

void TTSModel::saveLoadParams(
    const std::unordered_map<std::string, std::string> &configMap) {
  if (engineType_ == EngineType::Chatterbox) {
    chatterboxConfig_ = createChatterboxConfig(configMap);
    configSet_ = isChatterboxConfigValid(chatterboxConfig_);
  } else if (engineType_ == EngineType::Supertonic) {
    supertonicConfig_ = createSupertonicConfig(configMap);
    configSet_ = isSupertonicConfigValid(supertonicConfig_);
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
  } else if (engineType_ == EngineType::Supertonic) {
    supertonicEngine_->load(supertonicConfig_);
    loaded_ = supertonicEngine_->isLoaded();
    QLOG(Priority::INFO, "Supertone ONNX TTS model loaded successfully");
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
  } else if (engineType_ == EngineType::Supertonic) {
    if (supertonicEngine_) {
      supertonicEngine_->unload();
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
  if (cancelRequested_.exchange(false)) {
    throw std::runtime_error("Job cancelled");
  }

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
  } else if (engineType_ == EngineType::Supertonic) {
    result = supertonicEngine_->synthesize(text);
  }

  if (cancelRequested_.exchange(false)) {
    throw std::runtime_error("Job cancelled");
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

std::any TTSModel::process(const std::any &input) {
  if (input.type() == typeid(Input)) {
    return std::any{process(std::any_cast<const Input &>(input))};
  }
  if (input.type() == typeid(AnyInput)) {
    const auto &jobInput = std::any_cast<const AnyInput &>(input);
    if (!jobInput.config.empty()) {
      saveLoadParams(jobInput.config);
    }
    return std::any{process(jobInput.text)};
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      std::string("Unsupported TTS input type: ") + input.type().name());
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

std::string TTSModel::getName() const { return "TTSModel"; }

void TTSModel::cancel() const {
  cancelRequested_.store(true);
  QLOG(Priority::INFO, "TTSModel cancellation requested");
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
  if (engineType_ == EngineType::Chatterbox) {
    chatterboxConfig_.referenceAudio = referenceAudio;
    QLOG(Priority::INFO,
         "Reference audio set, size: " + std::to_string(referenceAudio.size()));
  }
}