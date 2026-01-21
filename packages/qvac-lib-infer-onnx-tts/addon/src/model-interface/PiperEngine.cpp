#include "PiperEngine.hpp"
#include <filesystem>
#include <cstdio>
#include <iostream>
#include <cstdlib>
#include <stdexcept>

#include "src/addon/TTSErrors.hpp"
#include <onnxruntime_c_api.h>
#include <onnxruntime_cxx_api.h>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#ifdef __ANDROID__
#include <onnxruntime/nnapi_provider_factory.h>
#endif

#if defined(_WIN32) || defined(_WIN64)
#include <dml_provider_factory.h>
#endif

namespace fs = std::filesystem;
using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac::ttslib::piper {

PiperEngine::PiperEngine(const TTSConfig& cfg)
 : IPiperEngine() {
  load(cfg);
}

PiperEngine::~PiperEngine() {
  unload();
}

void PiperEngine::load(const TTSConfig& cfg) {
  loadVoice(cfg);
  initialize();
}

void PiperEngine::unload() {
  cleanup();
}

AudioResult PiperEngine::synthesize(const std::string& text) {
  const std::vector<int16_t>& wav = generateAudio(text);

  AudioResult result;
  result.sampleRate = voice_.synthesisConfig.sampleRate;
  result.pcm16 = wav;
  result.channels = voice_.synthesisConfig.channels;

  if (result.sampleRate > 0) {
    result.durationMs = (static_cast<double>(wav.size()) / result.sampleRate) * 1000.0;
    result.samples = wav.size();
  }

  return result;
}

void PiperEngine::loadVoice(const TTSConfig& cfg) {
  if (initialized_) return;

  std::filesystem::path model(cfg.modelPath);
  if (!std::filesystem::exists(model)) {
    throw qvac_errors::createTTSError(qvac_errors::tts_error::ModelFileNotFound, "Model file not found: " + cfg.modelPath);
  }

  if (!std::filesystem::exists(cfg.configJsonPath)) {
    throw qvac_errors::createTTSError(qvac_errors::tts_error::ConfigFileNotFound, "Model config (.json) not found: " + cfg.configJsonPath);
  }

  constexpr bool useCuda = false;
  piperConfig_.useESpeak = true;
  piperConfig_.eSpeakDataPath = cfg.eSpeakDataPath;

  // IMPORTANT: Keep piper's built-in Tashkeel DISABLED (useTashkeel = false by
  // default) because it expects a different ONNX model format than our Tashkeel
  // model. We use our own TashkeelDiacritizer that's compatible with the Python
  // piper model.

  // Store language for later use
  language_ = cfg.language;
  QLOG(Priority::INFO, "Language set to: " + language_);

  Ort::SessionOptions opts = getOrtSessionOptions(cfg.useGPU);
  voice_.session.options = std::move(opts);
  ::piper::loadVoice(piperConfig_, model.string(), cfg.configJsonPath, voice_, speakerId_, false);
  
  configureESpeak(cfg.language, cfg.eSpeakDataPath);

  // Initialize our custom Tashkeel for Arabic
  QLOG(Priority::INFO, "Tashkeel model dir: '" + cfg.tashkeelModelDir + "'");
  QLOG(Priority::INFO, "Is Arabic language: " +
                           std::string(isArabicLanguage() ? "true" : "false"));

  if (isArabicLanguage() && !cfg.tashkeelModelDir.empty()) {
    QLOG(Priority::INFO, "Initializing custom Tashkeel for Arabic...");
    initializeTashkeel(cfg.tashkeelModelDir);
  } else if (isArabicLanguage() && cfg.tashkeelModelDir.empty()) {
    QLOG(Priority::WARNING, "Arabic language detected but tashkeelModelDir is "
                            "empty - diacritization disabled");
  }
}

void PiperEngine::initialize() {
  if (initialized_) return;

  ::piper::initialize(piperConfig_);
  initialized_ = true;
}

void PiperEngine::cleanup() {
  if (!initialized_) return;

  ::piper::terminate(piperConfig_);

  piperConfig_ = {};
  voice_ = {};
  speakerId_ = {};
  audioBuffer_.clear();
  collectedAudio_.clear();
  tashkeel_.reset();
  language_.clear();
  initialized_ = false;
}

bool PiperEngine::isArabicLanguage() const {
  // Check if language starts with "ar" (Arabic)
  return language_.size() >= 2 &&
         (language_.substr(0, 2) == "ar" || language_.substr(0, 2) == "AR");
}

void PiperEngine::initializeTashkeel(const std::string &tashkeelModelDir) {
  if (tashkeelModelDir.empty()) {
    QLOG(Priority::WARNING, "Tashkeel model directory not specified, Arabic "
                            "diacritization disabled");
    return;
  }

  if (!std::filesystem::exists(tashkeelModelDir)) {
    QLOG(Priority::WARNING,
         "Tashkeel model directory not found: " + tashkeelModelDir);
    return;
  }

  tashkeel_ = std::make_unique<tashkeel::TashkeelDiacritizer>();
  if (!tashkeel_->initialize(tashkeelModelDir)) {
    QLOG(Priority::ERROR, "Failed to initialize Tashkeel diacritizer");
    tashkeel_.reset();
    return;
  }

  QLOG(Priority::INFO,
       "Custom Tashkeel Arabic diacritizer initialized successfully");
}

std::string PiperEngine::preprocessText(const std::string &text) {
  // Apply Tashkeel diacritization for Arabic
  if (isArabicLanguage() && tashkeel_ && tashkeel_->isInitialized()) {
    QLOG(Priority::INFO, "Applying Tashkeel diacritization...");
    QLOG(Priority::DEBUG, "Original text: " + text);
    std::string diacritized = tashkeel_->diacritize(text, std::nullopt);
    QLOG(Priority::DEBUG, "Diacritized text: " + diacritized);
    QLOG(Priority::INFO, "Tashkeel applied successfully");
    return diacritized;
  } else if (isArabicLanguage()) {
    QLOG(Priority::WARNING, "Arabic text but Tashkeel not available");
  }
  return text;
}

void PiperEngine::configureESpeak(const std::string& lang, const std::string& espeakNgDataPath) {
  piperConfig_.useESpeak = true;
  piperConfig_.eSpeakDataPath = espeakNgDataPath;
  voice_.phonemizeConfig.eSpeak.voice = lang;
}

void PiperEngine::audioCallback() {
  collectedAudio_.insert(collectedAudio_.end(), audioBuffer_.begin(), audioBuffer_.end());
}

std::vector<int16_t> PiperEngine::generateAudio(const std::string& text) {
  collectedAudio_.clear();
  audioBuffer_.clear();

  // Preprocess text (applies Tashkeel for Arabic)
  std::string processedText = preprocessText(text);

  ::piper::SynthesisResult result;
  ::piper::textToAudio(piperConfig_, voice_, processedText, audioBuffer_,
                       result, [this]() { audioCallback(); });
  return collectedAudio_;
}

Ort::SessionOptions PiperEngine::getOrtSessionOptions(bool useGPU) {
  Ort::SessionOptions sessionOptions;
  sessionOptions.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);

  if (!useGPU) {
    return sessionOptions;
  }

  const auto providers = Ort::GetAvailableProviders();

#if defined(__ANDROID__)
  try {
    const bool nnapiAvailable =
        std::find(providers.begin(), providers.end(), "NnapiExecutionProvider") != providers.end();
    if (nnapiAvailable) {
      uint32_t nnapiFlags = NNAPI_FLAG_USE_FP16 | NNAPI_FLAG_CPU_DISABLED;
      Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_Nnapi(sessionOptions, nnapiFlags));
      QLOG(Priority::INFO, "Using NNAPI execution provider");
    }
  } catch (const std::exception& e) {
    QLOG(Priority::ERROR, "Error setting up NNAPI provider: " + std::string(e.what()));
  }

#elif defined(__APPLE__)

  try {
    const bool coremlAvailable =
        std::find(providers.begin(), providers.end(), "CoreMLExecutionProvider") != providers.end();
    if (coremlAvailable) {
      sessionOptions.AppendExecutionProvider("CoreML");
      QLOG(Priority::INFO, "Using CoreML execution provider");
    }
  } catch (const std::exception& e) {
    QLOG(Priority::ERROR, "Error setting up CoreML provider: " + std::string(e.what()));
  }

#elif defined(_WIN32) || defined(_WIN64)

  try {
    const bool DmlExecutionProvider =
        std::find(providers.begin(), providers.end(), "DmlExecutionProvider") !=
        providers.end();
    if (DmlExecutionProvider) {
      sessionOptions.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
      sessionOptions.DisableMemPattern();
      Ort::ThrowOnError(
          OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0));
      QLOG(Priority::INFO, "Using DirectML execution provider");
    }
  } catch (const std::exception &e) {
    QLOG(Priority::ERROR, "Error setting up DirectML provider: " + std::string(e.what()));
  }
#endif
  return sessionOptions;
}


} // namespace qvac::ttslib::piper
