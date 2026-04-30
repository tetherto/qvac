#include "ParakeetModel.hpp"

#include <Eigen/Core>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <istream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <unsupported/Eigen/FFT>

#include <nlohmann/json.hpp>

#include "addon/ParakeetErrors.hpp"
#include "onnxruntime/onnxruntime_cxx_api.h"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#pragma push_macro("QLOG")
#undef QLOG
#include <qvac-onnx/OnnxConfig.hpp>
#include <qvac-onnx/OnnxSessionOptionsBuilder.hpp>
#pragma pop_macro("QLOG")

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace qvac_lib_infer_parakeet {

namespace {

// ONNX Runtime's CreateTensor API requires a non-const pointer but only reads
// the data for input tensors. These helpers encapsulate the const_cast so
// call sites don't need the red-flag cast inline.
template <typename T>
Ort::Value createInputTensor(Ort::MemoryInfo &info, const std::vector<T> &data,
                             const std::vector<int64_t> &shape) {
  return Ort::Value::CreateTensor<T>(info, const_cast<T *>(data.data()),
                                     data.size(), shape.data(), shape.size());
}

template <typename T>
Ort::Value createInputTensor(Ort::MemoryInfo &info, const T *data, size_t size,
                             const std::vector<int64_t> &shape) {
  return Ort::Value::CreateTensor<T>(info, const_cast<T *>(data), size,
                                     shape.data(), shape.size());
}

std::string formatSeconds(float seconds) {
  std::ostringstream oss;
  oss << std::fixed << std::setprecision(2) << seconds << 's';
  return oss.str();
}

template <typename Func>
void measureTime(int64_t &accumulator, Func &&operation) {
  auto start = std::chrono::high_resolution_clock::now();
  operation();
  auto end = std::chrono::high_resolution_clock::now();
  accumulator +=
      std::chrono::duration_cast<std::chrono::milliseconds>(end - start)
          .count();
}

float hzToMel(float hz) { return 2595.0f * std::log10(1.0f + hz / 700.0f); }

float melToHz(float mel) {
  return 700.0f * (std::pow(10.0f, mel / 2595.0f) - 1.0f);
}

using MelFilter = ParakeetModel::MelFilter;

std::vector<MelFilter> buildMelFilterbank(int numMelBins, int fftSize,
                                          float sampleRate, float fMin,
                                          float fMax, bool slaney = false) {
  int numFftBins = fftSize / 2 + 1;
  float melMin = hzToMel(fMin);
  float melMax = hzToMel(fMax);

  std::vector<float> hzPoints(numMelBins + 2);
  for (int i = 0; i < numMelBins + 2; ++i) {
    float mel = melMin + (melMax - melMin) * i / (numMelBins + 1);
    hzPoints[i] = melToHz(mel);
  }

  std::vector<MelFilter> filterbank(numMelBins);

  if (slaney) {
    std::vector<float> fftFreqs(numFftBins);
    for (int j = 0; j < numFftBins; ++j) {
      fftFreqs[j] = (sampleRate / static_cast<float>(fftSize)) * j;
    }

    for (int i = 0; i < numMelBins; ++i) {
      float left = hzPoints[i];
      float center = hzPoints[i + 1];
      float right = hzPoints[i + 2];

      std::vector<float> dense(numFftBins, 0.0f);
      for (int j = 0; j < numFftBins; ++j) {
        float freq = fftFreqs[j];
        if (freq >= left && freq <= center && center > left) {
          dense[j] = (freq - left) / (center - left);
        } else if (freq > center && freq <= right && right > center) {
          dense[j] = (right - freq) / (right - center);
        }
      }

      float enorm = (right > left) ? 2.0f / (right - left) : 0.0f;
      int start = numFftBins, end = 0;
      for (int j = 0; j < numFftBins; ++j) {
        dense[j] *= enorm;
        if (dense[j] != 0.0f) {
          if (j < start)
            start = j;
          end = j + 1;
        }
      }
      if (start >= end) {
        start = 0;
        end = 0;
      }
      filterbank[i] = {
          start, end, {dense.begin() + start, dense.begin() + end}};
    }
  } else {
    std::vector<int> binPoints(numMelBins + 2);
    for (int i = 0; i < numMelBins + 2; ++i) {
      binPoints[i] = static_cast<int>(
          std::floor((fftSize + 1) * hzPoints[i] / sampleRate));
    }

    for (int m = 0; m < numMelBins; ++m) {
      int left = binPoints[m];
      int center = binPoints[m + 1];
      int right = binPoints[m + 2];

      int start = std::min(left, numFftBins);
      int end = std::min(right, numFftBins);
      if (start >= end) {
        filterbank[m] = {0, 0, {}};
        continue;
      }

      std::vector<float> weights(end - start, 0.0f);
      for (int k = left; k < center && k < numFftBins; ++k) {
        if (center != left) {
          weights[k - start] = static_cast<float>(k - left) / (center - left);
        }
      }
      for (int k = center; k < right && k < numFftBins; ++k) {
        if (right != center) {
          weights[k - start] = static_cast<float>(right - k) / (right - center);
        }
      }
      filterbank[m] = {start, end, std::move(weights)};
    }
  }

  return filterbank;
}

std::string trimWhitespace(const std::string &s) {
  static constexpr const char *kWs = " \t\n\r";
  size_t start = s.find_first_not_of(kWs);
  size_t end = s.find_last_not_of(kWs);
  if (start == std::string::npos)
    return "";
  return s.substr(start, end - start + 1);
}

// Replace sentencepiece ▁ (UTF-8: E2 96 81) with space
void replaceSentencepieceSpace(std::string &piece) {
  size_t pos = 0;
  while ((pos = piece.find("\xe2\x96\x81", pos)) != std::string::npos) {
    piece.replace(pos, 3, " ");
    pos += 1;
  }
}

bool isSpecialToken(const std::string &piece) {
  return piece.size() >= 2 && piece.front() == '<' && piece.back() == '>';
}

size_t countWords(const std::string &text) {
  if (text.empty())
    return 0;
  size_t count = 0;
  bool inWord = false;
  for (char c : text) {
    if (c == ' ' || c == '\n') {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

} // namespace

// ═════════════════════════════════════════════════════════════════════════════
//  Construction / Destruction
// ═════════════════════════════════════════════════════════════════════════════

ParakeetModel::ParakeetModel(const ParakeetConfig &config) : cfg_(config) {
  ort_env_ = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_WARNING, "Parakeet");
  reset();
}

ParakeetModel::~ParakeetModel() { unload(); }

void ParakeetModel::initializeBackend() {}

// ═════════════════════════════════════════════════════════════════════════════
//  Weight loading
// ═════════════════════════════════════════════════════════════════════════════

void ParakeetModel::dispatchWeightFile(const std::string &filename) {
  if (filename == "vocab.txt") {
    loadVocabulary(model_weights_[filename]);
  } else if (filename == "tokenizer.json") {
    loadTokenizerJson(model_weights_[filename]);
  }
}

void ParakeetModel::set_weights_for_file(const std::string &filename,
                                         std::span<const uint8_t> contents,
                                         bool completed) {
  if (!completed)
    return;

  model_weights_[filename] =
      std::vector<uint8_t>(contents.begin(), contents.end());
  dispatchWeightFile(filename);
}

void ParakeetModel::set_weights_for_file(
    const std::string &filename,
    std::unique_ptr<std::basic_streambuf<char>> streambuf) {
  std::istream stream(streambuf.get());
  std::vector<uint8_t> data((std::istreambuf_iterator<char>(stream)),
                            std::istreambuf_iterator<char>());

  model_weights_[filename] = std::move(data);
  dispatchWeightFile(filename);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Vocabulary
// ═════════════════════════════════════════════════════════════════════════════

void ParakeetModel::setWeightsForFile(
    const std::string &filename,
    std::unique_ptr<std::basic_streambuf<char>> &&streambuf) {
  set_weights_for_file(filename, std::move(streambuf));
}

void ParakeetModel::loadVocabulary(const std::vector<uint8_t> &vocabData) {
  std::string vocabStr(vocabData.begin(), vocabData.end());
  std::istringstream iss(vocabStr);
  std::string line;

  vocab_.clear();
  while (std::getline(iss, line)) {
    size_t spacePos = line.rfind(' ');
    if (spacePos != std::string::npos) {
      vocab_.push_back(line.substr(0, spacePos));
    } else {
      vocab_.push_back(line);
    }
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Loaded vocabulary with " + std::to_string(vocab_.size()) + " tokens");
}

void ParakeetModel::loadTokenizerJson(const std::vector<uint8_t> &data) {
  std::string jsonStr(data.begin(), data.end());
  nlohmann::json json;
  try {
    json = nlohmann::json::parse(jsonStr);
  } catch (const nlohmann::json::parse_error &e) {
    throw errors::makeStatus(errors::Code::VocabularyEmpty,
                             std::string("Failed to parse tokenizer.json: ") +
                                 e.what());
  }

  vocab_.clear();

  if (json.contains("model") && json["model"].contains("vocab")) {
    auto &vocabMap = json["model"]["vocab"];
    for (auto &[token, idx] : vocabMap.items()) {
      size_t i = idx.get<size_t>();
      if (i >= vocab_.size())
        vocab_.resize(i + 1);
      vocab_[i] = token;
    }
  }

  if (json.contains("added_tokens")) {
    for (auto &token : json["added_tokens"]) {
      if (!token.contains("id") || !token.contains("content"))
        continue;
      size_t id = token["id"].get<size_t>();
      std::string content = token["content"].get<std::string>();
      if (id >= vocab_.size()) {
        vocab_.resize(id + 1);
      }
      vocab_[id] = content;
    }
  }

  if (vocab_.empty()) {
    throw errors::makeStatus(errors::Code::VocabularyEmpty,
                             "tokenizer.json parsed but vocabulary is empty");
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Loaded vocabulary with " + std::to_string(vocab_.size()) +
           " tokens from tokenizer.json");
}

std::string
ParakeetModel::tokensToString(const std::vector<int64_t> &tokens) const {
  std::string result;
  for (int64_t token : tokens) {
    if (token < 0 || static_cast<size_t>(token) >= vocab_.size())
      continue;

    const std::string &piece = vocab_[token];
    if (piece.empty() || isSpecialToken(piece))
      continue;

    std::string decoded = piece;
    replaceSentencepieceSpace(decoded);
    result += decoded;
  }
  return trimWhitespace(result);
}

int64_t ParakeetModel::getLanguageToken(const std::string &langCode) const {
  std::string langToken = "<|" + langCode + "|>";
  for (size_t i = 0; i < vocab_.size(); ++i) {
    if (vocab_[i] == langToken) {
      return static_cast<int64_t>(i);
    }
  }
  return PREDICT_LANG;
}

std::string ParakeetModel::getName() const {
  switch (cfg_.modelType) {
  case ModelType::CTC:
    return "Parakeet-CTC";
  case ModelType::TDT:
    return "Parakeet-TDT";
  case ModelType::EOU:
    return "Parakeet-EOU";
  case ModelType::SORTFORMER:
    return "Parakeet-Sortformer";
  default:
    return "Parakeet";
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Lifecycle
// ═════════════════════════════════════════════════════════════════════════════

void ParakeetModel::reset() {
  output_.clear();
  stream_ended_ = false;
  processed_time_ = 0.0f;

  totalSamples_ = 0;
  totalTokens_ = 0;
  totalTranscriptions_ = 0;
  processCalls_ = 0;

  totalWallMs_ = 0;
  modelLoadMs_ = 0;
  melSpecMs_ = 0;
  encoderMs_ = 0;
  decoderMs_ = 0;

  totalMelFrames_ = 0;
  totalEncodedFrames_ = 0;

  eouState_.cacheChan.clear();
  eouState_.cacheTime.clear();
  eouState_.cacheChanLen.clear();
  eouState_.stateH.clear();
  eouState_.stateC.clear();
  eouState_.initialized = false;
}

void ParakeetModel::load() {
  if (is_loaded_)
    return;

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Loading Parakeet models from: " + cfg_.modelPath);

  auto loadStart = std::chrono::high_resolution_clock::now();

  try {
    memory_info_ = std::make_unique<Ort::MemoryInfo>(
        Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault));

    onnx_addon::SessionConfig sessionCfg;
    sessionCfg.provider = cfg_.useGPU ? onnx_addon::ExecutionProvider::AUTO_GPU
                                      : onnx_addon::ExecutionProvider::CPU;
    sessionCfg.optimization = onnx_addon::GraphOptimizationLevel::ALL;
    sessionCfg.intraOpThreads = cfg_.maxThreads;

    Ort::SessionOptions session_options =
        onnx_addon::buildSessionOptions(sessionCfg);

    if (cfg_.seed >= 0) {
      session_options.SetDeterministicCompute(true);
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
           "Deterministic compute enabled (seed=" + std::to_string(cfg_.seed) +
               ")");
    }

    auto loadSessions = [&](Ort::SessionOptions &opts) {
      switch (cfg_.modelType) {
      case ModelType::CTC:
        loadCTCSessions(opts);
        break;
      case ModelType::EOU:
        loadEOUSessions(opts);
        break;
      case ModelType::SORTFORMER:
        loadSortformerSessions(opts);
        break;
      default:
        loadTDTSessions(opts);
        break;
      }
    };

    try {
      loadSessions(session_options);
    } catch (const std::exception &e) {
      if (sessionCfg.provider != onnx_addon::ExecutionProvider::CPU) {
        QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
             std::string("GPU session creation failed, retrying CPU-only: ") +
                 e.what());
        onnx_addon::SessionConfig cpuCfg = sessionCfg;
        cpuCfg.provider = onnx_addon::ExecutionProvider::CPU;
        Ort::SessionOptions cpuOptions =
            onnx_addon::buildSessionOptions(cpuCfg);
        if (cfg_.seed >= 0) {
          cpuOptions.SetDeterministicCompute(true);
        }
        loadSessions(cpuOptions);
      } else {
        throw;
      }
    }

    is_loaded_ = true;
    model_weights_.clear();

    auto loadEnd = std::chrono::high_resolution_clock::now();
    modelLoadMs_ = std::chrono::duration_cast<std::chrono::milliseconds>(
                       loadEnd - loadStart)
                       .count();

    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
         "Parakeet models loaded successfully in " +
             std::to_string(modelLoadMs_) + "ms");

    if (!is_warmed_up_) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
           "Warming up Parakeet model");
      warmup();
      is_warmed_up_ = true;
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
           "Parakeet model warmup completed");
    }

  } catch (const Ort::Exception &e) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
         std::string("ONNX Runtime error: ") + e.what());
    throw;
  }
}

void ParakeetModel::reload() {}

void ParakeetModel::unload() {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Unloading Parakeet model");

  preprocessor_session_.reset();
  encoder_session_.reset();
  decoder_session_.reset();
  ctc_session_.reset();
  sortformer_session_.reset();
  memory_info_.reset();
  is_loaded_ = false;
  is_warmed_up_ = false;

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Parakeet model unloaded successfully");
}

void ParakeetModel::warmup() {
  if (!is_loaded_) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Cannot warmup - model not loaded");
    return;
  }

  if (cfg_.modelType == ModelType::CTC) {
    if (!ctc_session_)
      return;
  } else if (cfg_.modelType == ModelType::SORTFORMER) {
    if (!sortformer_session_)
      return;
  } else {
    if (!encoder_session_ || !decoder_session_)
      return;
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Starting model warmup");

  auto warmupStart = std::chrono::high_resolution_clock::now();

  const size_t warmupSamples = (cfg_.modelType == ModelType::EOU ||
                                cfg_.modelType == ModelType::SORTFORMER)
                                   ? 16000
                                   : 8000;
  std::vector<float> silentAudio(warmupSamples, 0.0f);

  try {
    runInferencePipeline(silentAudio);

    auto warmupMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::high_resolution_clock::now() - warmupStart)
                        .count();
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "Model warmup completed in " + std::to_string(warmupMs) + "ms");
  } catch (const std::exception &e) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         std::string("Warmup inference failed (non-fatal): ") + e.what());
  }

  reset();
}

// ═════════════════════════════════════════════════════════════════════════════
//  Session loading helpers (called from load())
// ═════════════════════════════════════════════════════════════════════════════

static void stageFile(const std::filesystem::path &target,
                      const std::filesystem::path &link) {
  std::error_code ec;
  std::filesystem::create_symlink(target, link, ec);
  if (!ec)
    return;

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Symlink failed (" + ec.message() +
           "), trying hardlink: " + link.string());

  ec.clear();
  std::filesystem::create_hard_link(target, link, ec);
  if (!ec)
    return;

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Hardlink failed (" + ec.message() +
           "), falling back to copy: " + link.string());

  std::filesystem::copy_file(target, link,
                             std::filesystem::copy_options::overwrite_existing);
}

void ParakeetModel::loadCTCSessions(Ort::SessionOptions &session_options) {
  if (cfg_.ctcModelPath.empty()) {
    throw errors::makeStatus(errors::Code::CTCModelNotLoaded,
                             "ctcModelPath is required");
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Loading CTC model session...");

  bool hasExternalData = !cfg_.ctcModelDataPath.empty() &&
                         std::filesystem::exists(cfg_.ctcModelDataPath);

  if (hasExternalData) {
    auto basePath = std::filesystem::path(cfg_.ctcModelPath).parent_path();
    auto stagingDir =
        basePath /
        (".parakeet_ctc_" + std::to_string(reinterpret_cast<uintptr_t>(this)));
    std::filesystem::create_directories(stagingDir);

    auto modelLink = stagingDir / "model.onnx";
    stageFile(cfg_.ctcModelPath, modelLink);
    // ONNX exports use either model.onnx_data or model.onnx.data — create both
    stageFile(cfg_.ctcModelDataPath, stagingDir / "model.onnx_data");
    stageFile(cfg_.ctcModelDataPath, stagingDir / "model.onnx.data");

    try {
      ctc_session_ = std::make_unique<Ort::Session>(
          *ort_env_, modelLink.c_str(), session_options);
    } catch (...) {
      std::filesystem::remove_all(stagingDir);
      throw;
    }
    std::filesystem::remove_all(stagingDir);
  } else {
#ifdef _WIN32
    std::wstring wPath(cfg_.ctcModelPath.begin(), cfg_.ctcModelPath.end());
    ctc_session_ = std::make_unique<Ort::Session>(*ort_env_, wPath.c_str(),
                                                  session_options);
#else
    ctc_session_ = std::make_unique<Ort::Session>(
        *ort_env_, cfg_.ctcModelPath.c_str(), session_options);
#endif
  }

  if (!cfg_.tokenizerPath.empty() && vocab_.empty()) {
    std::ifstream file(cfg_.tokenizerPath, std::ios::binary);
    if (file.is_open()) {
      std::vector<uint8_t> data((std::istreambuf_iterator<char>(file)),
                                std::istreambuf_iterator<char>());
      loadTokenizerJson(data);
    }
  }
}

void ParakeetModel::loadEOUSessions(Ort::SessionOptions &session_options) {
  if (cfg_.eouEncoderPath.empty()) {
    throw errors::makeStatus(errors::Code::EOUEncoderNotLoaded,
                             "eouEncoderPath is required");
  }
  if (cfg_.eouDecoderPath.empty()) {
    throw errors::makeStatus(errors::Code::EOUDecoderNotLoaded,
                             "eouDecoderPath is required");
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Loading EOU encoder session...");
#ifdef _WIN32
  std::wstring wEncPath(cfg_.eouEncoderPath.begin(), cfg_.eouEncoderPath.end());
  encoder_session_ = std::make_unique<Ort::Session>(*ort_env_, wEncPath.c_str(),
                                                    session_options);
#else
  encoder_session_ = std::make_unique<Ort::Session>(
      *ort_env_, cfg_.eouEncoderPath.c_str(), session_options);
#endif

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Loading EOU decoder session...");
#ifdef _WIN32
  std::wstring wDecPath(cfg_.eouDecoderPath.begin(), cfg_.eouDecoderPath.end());
  decoder_session_ = std::make_unique<Ort::Session>(*ort_env_, wDecPath.c_str(),
                                                    session_options);
#else
  decoder_session_ = std::make_unique<Ort::Session>(
      *ort_env_, cfg_.eouDecoderPath.c_str(), session_options);
#endif

  if (!cfg_.tokenizerPath.empty() && vocab_.empty()) {
    std::ifstream file(cfg_.tokenizerPath, std::ios::binary);
    if (file.is_open()) {
      std::vector<uint8_t> data((std::istreambuf_iterator<char>(file)),
                                std::istreambuf_iterator<char>());
      loadTokenizerJson(data);
    }
  }
}

void ParakeetModel::loadSortformerSessions(
    Ort::SessionOptions &session_options) {
  if (cfg_.sortformerPath.empty()) {
    throw errors::makeStatus(errors::Code::SortformerNotLoaded,
                             "sortformerPath is required");
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Loading Sortformer session...");
#ifdef _WIN32
  std::wstring wPath(cfg_.sortformerPath.begin(), cfg_.sortformerPath.end());
  sortformer_session_ =
      std::make_unique<Ort::Session>(*ort_env_, wPath.c_str(), session_options);
#else
  sortformer_session_ = std::make_unique<Ort::Session>(
      *ort_env_, cfg_.sortformerPath.c_str(), session_options);
#endif
}

void ParakeetModel::loadTDTSessions(Ort::SessionOptions &session_options) {
  if (cfg_.encoderPath.empty()) {
    throw errors::makeStatus(errors::Code::EncoderNotLoaded,
                             "encoderPath is required");
  }
  if (cfg_.decoderPath.empty()) {
    throw errors::makeStatus(errors::Code::DecoderNotLoaded,
                             "decoderPath is required");
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Loading encoder from path: " + cfg_.encoderPath);

  bool hasExternalData = !cfg_.encoderDataPath.empty() &&
                         std::filesystem::exists(cfg_.encoderDataPath);

  if (hasExternalData) {
    auto basePath = std::filesystem::path(cfg_.encoderPath).parent_path();
    auto stagingDir =
        basePath /
        (".parakeet_enc_" + std::to_string(reinterpret_cast<uintptr_t>(this)));
    std::filesystem::create_directories(stagingDir);

    auto encLink = stagingDir / "encoder-model.onnx";
    auto dataLink = stagingDir / "encoder-model.onnx.data";
    stageFile(cfg_.encoderPath, encLink);
    stageFile(cfg_.encoderDataPath, dataLink);

    try {
      encoder_session_ = std::make_unique<Ort::Session>(
          *ort_env_, encLink.c_str(), session_options);
    } catch (...) {
      std::filesystem::remove_all(stagingDir);
      throw;
    }
    std::filesystem::remove_all(stagingDir);
  } else {
#ifdef _WIN32
    std::wstring wPath(cfg_.encoderPath.begin(), cfg_.encoderPath.end());
    encoder_session_ = std::make_unique<Ort::Session>(*ort_env_, wPath.c_str(),
                                                      session_options);
#else
    encoder_session_ = std::make_unique<Ort::Session>(
        *ort_env_, cfg_.encoderPath.c_str(), session_options);
#endif
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Loading decoder session...");
#ifdef _WIN32
  std::wstring wDecoderPath(cfg_.decoderPath.begin(), cfg_.decoderPath.end());
  decoder_session_ = std::make_unique<Ort::Session>(
      *ort_env_, wDecoderPath.c_str(), session_options);
#else
  decoder_session_ = std::make_unique<Ort::Session>(
      *ort_env_, cfg_.decoderPath.c_str(), session_options);
#endif

  if (!cfg_.preprocessorPath.empty()) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "Loading preprocessor session...");
#ifdef _WIN32
    std::wstring wPath(cfg_.preprocessorPath.begin(),
                       cfg_.preprocessorPath.end());
    preprocessor_session_ = std::make_unique<Ort::Session>(
        *ort_env_, wPath.c_str(), session_options);
#else
    preprocessor_session_ = std::make_unique<Ort::Session>(
        *ort_env_, cfg_.preprocessorPath.c_str(), session_options);
#endif
  }

  if (vocab_.empty() && !cfg_.vocabPath.empty()) {
    std::ifstream vocabFile(cfg_.vocabPath, std::ios::binary);
    if (vocabFile.is_open()) {
      std::vector<uint8_t> vocabData(
          (std::istreambuf_iterator<char>(vocabFile)),
          std::istreambuf_iterator<char>());
      loadVocabulary(vocabData);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Feature extraction
// ═════════════════════════════════════════════════════════════════════════════

std::pair<std::vector<float>, int64_t>
ParakeetModel::runPreprocessor(const Input &audio) {
  if (!preprocessor_session_ || audio.empty()) {
    return {{}, 0};
  }

  std::vector<int64_t> waveformShape = {1, static_cast<int64_t>(audio.size())};
  std::vector<float> audioData(audio.begin(), audio.end());

  Ort::Value waveformTensor = Ort::Value::CreateTensor<float>(
      *memory_info_, audioData.data(), audioData.size(), waveformShape.data(),
      waveformShape.size());

  std::vector<int64_t> waveformLens = {static_cast<int64_t>(audio.size())};
  std::vector<int64_t> lensShape = {1};
  Ort::Value lensTensor = Ort::Value::CreateTensor<int64_t>(
      *memory_info_, waveformLens.data(), waveformLens.size(), lensShape.data(),
      lensShape.size());

  const char *inputNames[] = {"waveforms", "waveforms_lens"};
  const char *outputNames[] = {"features", "features_lens"};

  std::vector<Ort::Value> inputs;
  inputs.push_back(std::move(waveformTensor));
  inputs.push_back(std::move(lensTensor));

  auto outputs =
      preprocessor_session_->Run(Ort::RunOptions{nullptr}, inputNames,
                                 inputs.data(), inputs.size(), outputNames, 2);

  auto &featuresTensor = outputs[0];
  auto featuresInfo = featuresTensor.GetTensorTypeAndShapeInfo();
  auto featuresShape = featuresInfo.GetShape();

  if (featuresShape.size() < 3) {
    throw errors::makeStatus(errors::Code::InferenceFailed,
                             "Preprocessor returned tensor with " +
                                 std::to_string(featuresShape.size()) +
                                 " dims, expected >= 3");
  }

  const float *featuresData = featuresTensor.GetTensorData<float>();
  size_t featuresSize = featuresInfo.GetElementCount();
  int64_t numFrames = featuresShape[2];

  return {std::vector<float>(featuresData, featuresData + featuresSize),
          numFrames};
}

void ParakeetModel::stftMelEnergies(const float *source, size_t sourceLen,
                                    size_t numFrames, int numMelBins,
                                    float logGuard,
                                    const std::vector<MelFilter> &melFilterbank,
                                    std::vector<float> &melSpec) {
  static const std::vector<float> hannWindow = []() {
    std::vector<float> w(WIN_LENGTH);
    for (int i = 0; i < WIN_LENGTH; ++i) {
      w[i] = 0.5f * (1.0f - std::cos(2.0f * M_PI * i / (WIN_LENGTH - 1)));
    }
    return w;
  }();

  static thread_local Eigen::FFT<float> fft;
  const int numFftBins = FFT_SIZE / 2 + 1;
  std::vector<float> frame(FFT_SIZE, 0.0f);
  std::vector<std::complex<float>> spectrum(FFT_SIZE);
  std::vector<float> powerSpec(numFftBins);

  for (size_t f = 0; f < numFrames; ++f) {
    size_t startSample = f * HOP_LENGTH;
    std::fill(frame.begin(), frame.end(), 0.0f);

    for (int i = 0; i < WIN_LENGTH && (startSample + i) < sourceLen; ++i) {
      frame[i] = source[startSample + i] * hannWindow[i];
    }

    fft.fwd(spectrum, frame);

    for (int k = 0; k < numFftBins; ++k) {
      powerSpec[k] = std::norm(spectrum[k]);
    }

    for (int m = 0; m < numMelBins; ++m) {
      const auto &filt = melFilterbank[m];
      float melEnergy = 0.0f;
      for (int k = filt.startBin; k < filt.endBin; ++k) {
        melEnergy += filt.weights[k - filt.startBin] * powerSpec[k];
      }
      melSpec[f * numMelBins + m] = std::log(std::max(melEnergy, logGuard));
    }
  }
}

void ParakeetModel::applyCMVN(std::vector<float> &melSpec, size_t numFrames,
                              int numMelBins) {
  std::vector<float> mean(numMelBins, 0.0f);
  std::vector<float> stddev(numMelBins, 0.0f);

  for (size_t f = 0; f < numFrames; ++f) {
    for (int m = 0; m < numMelBins; ++m) {
      mean[m] += melSpec[f * numMelBins + m];
    }
  }
  for (int m = 0; m < numMelBins; ++m) {
    mean[m] /= static_cast<float>(numFrames);
  }

  for (size_t f = 0; f < numFrames; ++f) {
    for (int m = 0; m < numMelBins; ++m) {
      float diff = melSpec[f * numMelBins + m] - mean[m];
      stddev[m] += diff * diff;
    }
  }
  for (int m = 0; m < numMelBins; ++m) {
    stddev[m] = std::sqrt(stddev[m] / static_cast<float>(numFrames) + 1e-10f);
  }

  for (size_t f = 0; f < numFrames; ++f) {
    for (int m = 0; m < numMelBins; ++m) {
      melSpec[f * numMelBins + m] =
          (melSpec[f * numMelBins + m] - mean[m]) / stddev[m];
    }
  }
}

std::vector<float> ParakeetModel::computeMelSpectrogram(const Input &audio,
                                                        int numMelBins) {
  const bool isNemoStyle = (cfg_.modelType == ModelType::EOU ||
                            cfg_.modelType == ModelType::SORTFORMER);
  const float preEmphCoeff = isNemoStyle ? 0.97f : 0.0f;
  const float logGuard = isNemoStyle ? 5.960464e-8f : 1e-10f;

  std::vector<float> processedAudio;
  const float *audioPtr = audio.data();
  size_t numSamples = audio.size();

  if (preEmphCoeff > 0.0f && numSamples > 0) {
    processedAudio.resize(numSamples);
    processedAudio[0] = audio[0];
    for (size_t i = 1; i < numSamples; ++i) {
      processedAudio[i] = audio[i] - preEmphCoeff * audio[i - 1];
    }
    audioPtr = processedAudio.data();
  }

  if (numSamples < static_cast<size_t>(WIN_LENGTH)) {
    return {};
  }

  size_t numFrames;
  size_t padAmount = 0;
  std::vector<float> paddedAudio;

  if (isNemoStyle) {
    padAmount = FFT_SIZE / 2;
    paddedAudio.resize(padAmount + numSamples + padAmount, 0.0f);
    std::copy(audioPtr, audioPtr + numSamples, paddedAudio.begin() + padAmount);
    numFrames = 1 + (paddedAudio.size() - WIN_LENGTH) / HOP_LENGTH;
  } else {
    numFrames = (numSamples - WIN_LENGTH) / HOP_LENGTH + 1;
  }

  if (numFrames == 0) {
    return {};
  }

  FilterbankKey fbKey{numMelBins, isNemoStyle};
  auto [it, inserted] = filterbanks_.try_emplace(fbKey);
  if (inserted) {
    it->second = isNemoStyle
                     ? buildMelFilterbank(numMelBins, FFT_SIZE, SAMPLE_RATE,
                                          0.0f, 8000.0f, true)
                     : buildMelFilterbank(numMelBins, FFT_SIZE, SAMPLE_RATE,
                                          0.0f, SAMPLE_RATE / 2.0f, false);
  }

  const float *stftSource = isNemoStyle ? paddedAudio.data() : audioPtr;
  size_t stftLen = isNemoStyle ? paddedAudio.size() : numSamples;

  std::vector<float> melSpec(numFrames * numMelBins);
  stftMelEnergies(stftSource, stftLen, numFrames, numMelBins, logGuard,
                  it->second, melSpec);

  if (!isNemoStyle) {
    applyCMVN(melSpec, numFrames, numMelBins);
  }

  return melSpec;
}

// ═════════════════════════════════════════════════════════════════════════════
//  TDT pipeline
// ═════════════════════════════════════════════════════════════════════════════

std::vector<float>
ParakeetModel::runEncoder(const std::vector<float> &melFeatures,
                          int64_t numFrames, int64_t &encodedLength,
                          bool alreadyTransposed) {
  if (!encoder_session_) {
    throw errors::makeStatus(errors::Code::EncoderNotLoaded,
                             "Encoder session not initialized");
  }

  std::vector<float> transposedBuf;
  const float *encoderData;
  size_t encoderSize;
  if (alreadyTransposed) {
    encoderData = melFeatures.data();
    encoderSize = melFeatures.size();
  } else {
    transposedBuf.resize(melFeatures.size());
    Eigen::Map<const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic,
                                   Eigen::RowMajor>>
        src(melFeatures.data(), numFrames, MEL_BINS);
    Eigen::Map<
        Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>>
        dst(transposedBuf.data(), MEL_BINS, numFrames);
    dst.noalias() = src.transpose();
    encoderData = transposedBuf.data();
    encoderSize = transposedBuf.size();
  }

  std::vector<int64_t> inputShape = {1, MEL_BINS, numFrames};
  Ort::Value inputTensor =
      createInputTensor(*memory_info_, encoderData, encoderSize, inputShape);

  std::vector<int64_t> lengthData = {numFrames};
  std::vector<int64_t> lengthShape = {1};
  Ort::Value lengthTensor = Ort::Value::CreateTensor<int64_t>(
      *memory_info_, lengthData.data(), lengthData.size(), lengthShape.data(),
      lengthShape.size());

  const char *inputNames[] = {"audio_signal", "length"};
  const char *outputNames[] = {"outputs", "encoded_lengths"};

  std::vector<Ort::Value> inputTensors;
  inputTensors.push_back(std::move(inputTensor));
  inputTensors.push_back(std::move(lengthTensor));

  auto outputs = encoder_session_->Run(Ort::RunOptions{nullptr}, inputNames,
                                       inputTensors.data(), inputTensors.size(),
                                       outputNames, 2);

  auto &encoderOutput = outputs[0];
  auto outputInfo = encoderOutput.GetTensorTypeAndShapeInfo();
  size_t outputSize = outputInfo.GetElementCount();
  const float *outputData = encoderOutput.GetTensorData<float>();

  encodedLength = outputs[1].GetTensorData<int64_t>()[0];

  return std::vector<float>(outputData, outputData + outputSize);
}

std::string ParakeetModel::greedyDecode(const std::vector<float> &encoderOutput,
                                        int64_t encodedLength) {
  if (!decoder_session_ || vocab_.empty()) {
    return ERR_MODEL_NOT_READY;
  }

  const size_t vocabSize = vocab_.size();
  const int maxTokensPerStep = 10;

  std::vector<int64_t> decodedTokens;
  std::vector<float> state1(TDT_DECODER_LSTM_LAYERS * 1 * DECODER_STATE_DIM,
                            0.0f);
  std::vector<float> state2(TDT_DECODER_LSTM_LAYERS * 1 * DECODER_STATE_DIM,
                            0.0f);

  int32_t lastEmittedToken = static_cast<int32_t>(BLANK_TOKEN);
  int tokensThisFrame = 0;
  int skip = 0;
  std::vector<float> encoderSlice(ENCODER_DIM);

  for (int64_t t = 0; t < encodedLength; t += skip) {
    throwIfCancelled();
    for (int i = 0; i < ENCODER_DIM; ++i) {
      encoderSlice[i] = encoderOutput[i * encodedLength + t];
    }

    std::vector<int64_t> encoderShape = {1, ENCODER_DIM, 1};
    Ort::Value encoderTensor = Ort::Value::CreateTensor<float>(
        *memory_info_, encoderSlice.data(), encoderSlice.size(),
        encoderShape.data(), encoderShape.size());

    std::vector<int32_t> targetData = {lastEmittedToken};
    std::vector<int64_t> targetShape = {1, 1};
    Ort::Value targetTensor = Ort::Value::CreateTensor<int32_t>(
        *memory_info_, targetData.data(), targetData.size(), targetShape.data(),
        targetShape.size());

    std::vector<int32_t> targetLengthData = {1};
    std::vector<int64_t> targetLengthShape = {1};
    Ort::Value targetLengthTensor = Ort::Value::CreateTensor<int32_t>(
        *memory_info_, targetLengthData.data(), targetLengthData.size(),
        targetLengthShape.data(), targetLengthShape.size());

    std::vector<int64_t> stateShape = {TDT_DECODER_LSTM_LAYERS, 1,
                                       DECODER_STATE_DIM};
    Ort::Value state1Tensor = Ort::Value::CreateTensor<float>(
        *memory_info_, state1.data(), state1.size(), stateShape.data(),
        stateShape.size());
    Ort::Value state2Tensor = Ort::Value::CreateTensor<float>(
        *memory_info_, state2.data(), state2.size(), stateShape.data(),
        stateShape.size());

    const char *decoderInputNames[] = {"encoder_outputs", "targets",
                                       "target_length", "input_states_1",
                                       "input_states_2"};
    const char *decoderOutputNames[] = {"outputs", "prednet_lengths",
                                        "output_states_1", "output_states_2"};

    std::vector<Ort::Value> decoderInputs;
    decoderInputs.push_back(std::move(encoderTensor));
    decoderInputs.push_back(std::move(targetTensor));
    decoderInputs.push_back(std::move(targetLengthTensor));
    decoderInputs.push_back(std::move(state1Tensor));
    decoderInputs.push_back(std::move(state2Tensor));

    auto decoderOutputs = decoder_session_->Run(
        Ort::RunOptions{nullptr}, decoderInputNames, decoderInputs.data(),
        decoderInputs.size(), decoderOutputNames, 4);

    const float *logits = decoderOutputs[0].GetTensorData<float>();
    auto logitsInfo = decoderOutputs[0].GetTensorTypeAndShapeInfo();
    size_t outputSize = logitsInfo.GetShape().back();
    size_t numDurations = outputSize - vocabSize;

    const float *tokenLogits = logits;
    const float *durationLogits = logits + vocabSize;

    int64_t tokenId = 0;
    float bestScore = tokenLogits[0];
    for (size_t i = 1; i < vocabSize; ++i) {
      if (std::isfinite(tokenLogits[i]) && tokenLogits[i] > bestScore) {
        bestScore = tokenLogits[i];
        tokenId = static_cast<int64_t>(i);
      }
    }

    skip = 0;
    if (numDurations > 0) {
      float bestDur = durationLogits[0];
      size_t bestIdx = 0;
      for (size_t i = 1; i < numDurations; ++i) {
        if (std::isfinite(durationLogits[i]) && durationLogits[i] > bestDur) {
          bestDur = durationLogits[i];
          bestIdx = i;
        }
      }
      skip = static_cast<int>(bestIdx);
    }

    if (tokenId != BLANK_TOKEN) {
      const float *newState1 = decoderOutputs[2].GetTensorData<float>();
      const float *newState2 = decoderOutputs[3].GetTensorData<float>();
      std::copy(newState1, newState1 + state1.size(), state1.begin());
      std::copy(newState2, newState2 + state2.size(), state2.begin());

      if (tokenId == EOS_TOKEN)
        break;

      if (tokenId != NOSPEECH_TOKEN && tokenId != PAD_TOKEN) {
        decodedTokens.push_back(tokenId);
      }

      lastEmittedToken = static_cast<int32_t>(tokenId);
      tokensThisFrame++;
    }

    if (skip > 0) {
      tokensThisFrame = 0;
    }

    if (tokensThisFrame >= maxTokensPerStep) {
      tokensThisFrame = 0;
      skip = 1;
    }

    if (tokenId == BLANK_TOKEN && skip == 0) {
      tokensThisFrame = 0;
      skip = 1;
    }
  }

  std::string result = tokensToString(decodedTokens);
  return result.empty() ? ERR_NO_SPEECH : result;
}

// ═════════════════════════════════════════════════════════════════════════════
//  CTC pipeline
// ═════════════════════════════════════════════════════════════════════════════

std::vector<float>
ParakeetModel::runCTCModel(const std::vector<float> &melFeatures,
                           int64_t numFrames) {
  if (!ctc_session_) {
    throw errors::makeStatus(errors::Code::CTCModelNotLoaded,
                             "CTC session not initialized");
  }

  std::vector<int64_t> featShape = {1, numFrames, CTC_MEL_BINS};
  Ort::Value featTensor =
      createInputTensor(*memory_info_, melFeatures, featShape);

  std::vector<int64_t> maskData(numFrames, 1);
  std::vector<int64_t> maskShape = {1, numFrames};
  Ort::Value maskTensor = Ort::Value::CreateTensor<int64_t>(
      *memory_info_, maskData.data(), maskData.size(), maskShape.data(),
      maskShape.size());

  const char *inputNames[] = {"input_features", "attention_mask"};
  const char *outputNames[] = {"logits"};

  std::vector<Ort::Value> inputs;
  inputs.push_back(std::move(featTensor));
  inputs.push_back(std::move(maskTensor));

  auto outputs =
      ctc_session_->Run(Ort::RunOptions{nullptr}, inputNames, inputs.data(),
                        inputs.size(), outputNames, 1);

  auto &logitsTensor = outputs[0];
  auto logitsInfo = logitsTensor.GetTensorTypeAndShapeInfo();
  size_t logitsSize = logitsInfo.GetElementCount();
  const float *logitsData = logitsTensor.GetTensorData<float>();

  return std::vector<float>(logitsData, logitsData + logitsSize);
}

std::string ParakeetModel::ctcGreedyDecode(const std::vector<float> &logits,
                                           int64_t numFrames) {
  if (vocab_.empty())
    return ERR_MODEL_NOT_READY;

  const size_t vocabSize = vocab_.size();
  const int64_t outputFrames = static_cast<int64_t>(logits.size() / vocabSize);

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "CTC output: " + std::to_string(outputFrames) + " frames (from " +
           std::to_string(numFrames) + " input frames)");

  std::vector<int64_t> decodedTokens;
  int64_t prevToken = -1;

  for (int64_t t = 0; t < outputFrames; ++t) {
    const float *frameLogits = logits.data() + t * vocabSize;
    int64_t bestToken = 0;
    float bestScore = frameLogits[0];
    for (size_t i = 1; i < vocabSize; ++i) {
      if (std::isfinite(frameLogits[i]) && frameLogits[i] > bestScore) {
        bestScore = frameLogits[i];
        bestToken = static_cast<int64_t>(i);
      }
    }

    if (bestToken != CTC_BLANK_TOKEN && bestToken != prevToken) {
      decodedTokens.push_back(bestToken);
    }
    prevToken = bestToken;
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "CTC decoded: " + std::to_string(decodedTokens.size()) + " tokens");

  std::string result = tokensToString(decodedTokens);
  return result.empty() ? ERR_NO_SPEECH : result;
}

// ═════════════════════════════════════════════════════════════════════════════
//  EOU streaming pipeline
// ═════════════════════════════════════════════════════════════════════════════

void ParakeetModel::resetEOUStreamingState() {
  const size_t cacheChanSize =
      EOU_NUM_LAYERS * 1 * EOU_CACHE_LOOKBACK * EOU_ENCODER_DIM;
  const size_t cacheTimeSize =
      EOU_NUM_LAYERS * 1 * EOU_ENCODER_DIM * EOU_CACHE_TIME_STEPS;

  eouState_.cacheChan.assign(cacheChanSize, 0.0f);
  eouState_.cacheTime.assign(cacheTimeSize, 0.0f);
  eouState_.cacheChanLen = {0};

  const size_t decoderStateSize =
      EOU_DECODER_LSTM_LAYERS * 1 * EOU_DECODER_STATE_DIM;
  eouState_.stateH.assign(decoderStateSize, 0.0f);
  eouState_.stateC.assign(decoderStateSize, 0.0f);

  const size_t vocabSize = vocab_.size();
  eouState_.blankId = static_cast<int64_t>(vocabSize) - 1;
  eouState_.lastToken = static_cast<int32_t>(eouState_.blankId);

  eouState_.eouId = -1;
  for (size_t i = 0; i < vocabSize; ++i) {
    if (vocab_[i] == "<EOU>") {
      eouState_.eouId = static_cast<int64_t>(i);
      break;
    }
  }
  if (eouState_.eouId < 0) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Vocabulary does not contain <EOU> token; falling back to id " +
             std::to_string(EOU_FALLBACK_TOKEN));
    eouState_.eouId = EOU_FALLBACK_TOKEN;
  }

  eouState_.initialized = true;
}

std::vector<float>
ParakeetModel::eouEncodeChunk(const std::vector<float> &melChunk,
                              int64_t chunkFrames, int64_t &outFrames) {
  if (!encoder_session_) {
    throw errors::makeStatus(errors::Code::EOUEncoderNotLoaded,
                             "EOU encoder session not initialized");
  }

  std::vector<float> transposed(MEL_BINS * chunkFrames);
  Eigen::Map<const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic,
                                 Eigen::RowMajor>>
      melSrc(melChunk.data(), chunkFrames, MEL_BINS);
  Eigen::Map<
      Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>>
      melDst(transposed.data(), MEL_BINS, chunkFrames);
  melDst.noalias() = melSrc.transpose();

  std::vector<int64_t> featShape = {1, MEL_BINS, chunkFrames};
  Ort::Value featTensor = Ort::Value::CreateTensor<float>(
      *memory_info_, transposed.data(), transposed.size(), featShape.data(),
      featShape.size());

  std::vector<int64_t> lengthData = {chunkFrames};
  std::vector<int64_t> lengthShape = {1};
  Ort::Value lengthTensor = Ort::Value::CreateTensor<int64_t>(
      *memory_info_, lengthData.data(), lengthData.size(), lengthShape.data(),
      lengthShape.size());

  std::vector<int64_t> cacheChanShape = {EOU_NUM_LAYERS, 1, EOU_CACHE_LOOKBACK,
                                         EOU_ENCODER_DIM};
  Ort::Value cacheChanTensor = Ort::Value::CreateTensor<float>(
      *memory_info_, eouState_.cacheChan.data(), eouState_.cacheChan.size(),
      cacheChanShape.data(), cacheChanShape.size());

  std::vector<int64_t> cacheTimeShape = {EOU_NUM_LAYERS, 1, EOU_ENCODER_DIM,
                                         EOU_CACHE_TIME_STEPS};
  Ort::Value cacheTimeTensor = Ort::Value::CreateTensor<float>(
      *memory_info_, eouState_.cacheTime.data(), eouState_.cacheTime.size(),
      cacheTimeShape.data(), cacheTimeShape.size());

  std::vector<int64_t> cacheLenShape = {1};
  Ort::Value cacheLenTensor = Ort::Value::CreateTensor<int64_t>(
      *memory_info_, eouState_.cacheChanLen.data(),
      eouState_.cacheChanLen.size(), cacheLenShape.data(),
      cacheLenShape.size());

  const char *inputNames[] = {"audio_signal", "length", "cache_last_channel",
                              "cache_last_time", "cache_last_channel_len"};
  const char *outputNames[] = {"outputs", "encoded_lengths",
                               "new_cache_last_channel", "new_cache_last_time",
                               "new_cache_last_channel_len"};

  std::vector<Ort::Value> inputs;
  inputs.push_back(std::move(featTensor));
  inputs.push_back(std::move(lengthTensor));
  inputs.push_back(std::move(cacheChanTensor));
  inputs.push_back(std::move(cacheTimeTensor));
  inputs.push_back(std::move(cacheLenTensor));

  auto outputs =
      encoder_session_->Run(Ort::RunOptions{nullptr}, inputNames, inputs.data(),
                            inputs.size(), outputNames, 5);

  auto &encOut = outputs[0];
  auto encShape = encOut.GetTensorTypeAndShapeInfo().GetShape();
  outFrames = encShape.size() >= 3 ? encShape[2] : 0;
  const float *encData = encOut.GetTensorData<float>();

  std::vector<float> result(outFrames * EOU_ENCODER_DIM);
  Eigen::Map<const Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic,
                                 Eigen::RowMajor>>
      encSrc(encData, EOU_ENCODER_DIM, outFrames);
  Eigen::Map<
      Eigen::Matrix<float, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>>
      encDst(result.data(), outFrames, EOU_ENCODER_DIM);
  encDst.noalias() = encSrc.transpose();

  {
    const float *ptr = outputs[2].GetTensorData<float>();
    size_t sz = outputs[2].GetTensorTypeAndShapeInfo().GetElementCount();
    eouState_.cacheChan.assign(ptr, ptr + sz);
  }
  {
    const float *ptr = outputs[3].GetTensorData<float>();
    size_t sz = outputs[3].GetTensorTypeAndShapeInfo().GetElementCount();
    eouState_.cacheTime.assign(ptr, ptr + sz);
  }
  {
    const int64_t *ptr = outputs[4].GetTensorData<int64_t>();
    size_t sz = outputs[4].GetTensorTypeAndShapeInfo().GetElementCount();
    eouState_.cacheChanLen.assign(ptr, ptr + sz);
  }

  return result;
}

std::string
ParakeetModel::eouDecodeChunk(const std::vector<float> &encoderOutput,
                              int64_t encodedFrames, int &eouCount) {
  eouCount = 0;
  if (!decoder_session_ || vocab_.empty())
    return "";

  const size_t vocabSize = vocab_.size();
  std::string result;
  std::string currentSegment;
  std::vector<float> encoderFrame(EOU_ENCODER_DIM);

  for (int64_t t = 0; t < encodedFrames; ++t) {
    throwIfCancelled();
    std::copy(encoderOutput.begin() + t * EOU_ENCODER_DIM,
              encoderOutput.begin() + (t + 1) * EOU_ENCODER_DIM,
              encoderFrame.begin());

    std::vector<int64_t> encFrameShape = {1, EOU_ENCODER_DIM, 1};
    Ort::Value encTensor = Ort::Value::CreateTensor<float>(
        *memory_info_, encoderFrame.data(), encoderFrame.size(),
        encFrameShape.data(), encFrameShape.size());

    int symsThisFrame = 0;
    while (symsThisFrame < EOU_MAX_SYMBOLS_PER_STEP) {
      throwIfCancelled();
      std::vector<int32_t> targetData = {eouState_.lastToken};
      std::vector<int64_t> targetShape = {1, 1};
      Ort::Value targetTensor = Ort::Value::CreateTensor<int32_t>(
          *memory_info_, targetData.data(), targetData.size(),
          targetShape.data(), targetShape.size());

      std::vector<int32_t> targetLenData = {1};
      std::vector<int64_t> targetLenShape = {1};
      Ort::Value targetLenTensor = Ort::Value::CreateTensor<int32_t>(
          *memory_info_, targetLenData.data(), targetLenData.size(),
          targetLenShape.data(), targetLenShape.size());

      std::vector<int64_t> stateShape = {EOU_DECODER_LSTM_LAYERS, 1,
                                         EOU_DECODER_STATE_DIM};
      Ort::Value stateHTensor = Ort::Value::CreateTensor<float>(
          *memory_info_, eouState_.stateH.data(), eouState_.stateH.size(),
          stateShape.data(), stateShape.size());
      Ort::Value stateCTensor = Ort::Value::CreateTensor<float>(
          *memory_info_, eouState_.stateC.data(), eouState_.stateC.size(),
          stateShape.data(), stateShape.size());

      const char *inputNames[] = {"encoder_outputs", "targets", "target_length",
                                  "input_states_1", "input_states_2"};
      const char *outputNames[] = {"outputs", "prednet_lengths",
                                   "output_states_1", "output_states_2"};

      std::vector<Ort::Value> decInputs;
      decInputs.push_back(std::move(encTensor));
      decInputs.push_back(std::move(targetTensor));
      decInputs.push_back(std::move(targetLenTensor));
      decInputs.push_back(std::move(stateHTensor));
      decInputs.push_back(std::move(stateCTensor));

      auto decOutputs = decoder_session_->Run(Ort::RunOptions{nullptr},
                                              inputNames, decInputs.data(),
                                              decInputs.size(), outputNames, 4);

      const float *logits = decOutputs[0].GetTensorData<float>();
      size_t outputDim =
          decOutputs[0].GetTensorTypeAndShapeInfo().GetShape().back();

      int32_t bestIdx = 0;
      float bestVal = logits[0];
      for (size_t i = 1; i < outputDim; ++i) {
        if (std::isfinite(logits[i]) && logits[i] > bestVal) {
          bestVal = logits[i];
          bestIdx = static_cast<int32_t>(i);
        }
      }

      if (bestIdx == static_cast<int32_t>(eouState_.blankId) ||
          bestIdx >= static_cast<int32_t>(vocabSize) ||
          isSpecialToken(vocab_[bestIdx])) {
        break;
      }

      if (bestIdx == static_cast<int32_t>(eouState_.eouId)) {
        std::string seg = trimWhitespace(currentSegment);
        if (!seg.empty()) {
          if (!result.empty())
            result += "\n";
          result += seg;
          currentSegment.clear();
          eouCount++;
          eouState_.stateH.assign(
              EOU_DECODER_LSTM_LAYERS * 1 * EOU_DECODER_STATE_DIM, 0.0f);
          eouState_.stateC.assign(
              EOU_DECODER_LSTM_LAYERS * 1 * EOU_DECODER_STATE_DIM, 0.0f);
          eouState_.lastToken = static_cast<int32_t>(eouState_.blankId);
        }
        break;
      }

      const float *newH = decOutputs[2].GetTensorData<float>();
      const float *newC = decOutputs[3].GetTensorData<float>();
      std::copy(newH, newH + eouState_.stateH.size(), eouState_.stateH.begin());
      std::copy(newC, newC + eouState_.stateC.size(), eouState_.stateC.begin());
      eouState_.lastToken = bestIdx;

      std::string piece = vocab_[bestIdx];
      if (!piece.empty() && !isSpecialToken(piece)) {
        replaceSentencepieceSpace(piece);
        currentSegment += piece;
      }

      symsThisFrame++;
      if (symsThisFrame < EOU_MAX_SYMBOLS_PER_STEP) {
        encTensor = Ort::Value::CreateTensor<float>(
            *memory_info_, encoderFrame.data(), encoderFrame.size(),
            encFrameShape.data(), encFrameShape.size());
      }
    }
  }

  std::string trailingSegment = trimWhitespace(currentSegment);
  if (!trailingSegment.empty()) {
    if (!result.empty())
      result += "\n";
    result += trailingSegment;
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Sortformer diarization pipeline
// ═════════════════════════════════════════════════════════════════════════════

std::string
ParakeetModel::runSortformerFromMel(const std::vector<float> &melFeatures,
                                    int64_t numFrames) {
  auto rawPreds = runSortformerChunked(melFeatures, numFrames);
  int64_t totalOutputFrames =
      static_cast<int64_t>(rawPreds.size() / SF_NUM_SPEAKERS);

  if (totalOutputFrames <= 0) {
    return ERR_NO_SPEAKERS;
  }

  auto smoothed = medianFilter(rawPreds, totalOutputFrames, SF_NUM_SPEAKERS);
  auto segments = binarizePredictions(smoothed, totalOutputFrames);

  if (segments.empty()) {
    return ERR_NO_SPEAKERS;
  }

  std::string result;
  for (const auto &seg : segments) {
    if (!result.empty())
      result += "\n";
    result += "Speaker " + std::to_string(seg.speakerId) + ": " +
              formatSeconds(seg.start) + " - " + formatSeconds(seg.end);
  }
  return result;
}

std::vector<float>
ParakeetModel::runSortformerChunked(const std::vector<float> &melFeatures,
                                    int64_t numFrames) {
  if (!sortformer_session_) {
    throw errors::makeStatus(errors::Code::SortformerNotLoaded,
                             "Sortformer session not initialized");
  }

  const int64_t chunkMelFrames =
      static_cast<int64_t>(SF_CHUNK_LEN) * SF_SUBSAMPLING;

  std::vector<float> spkcache;
  spkcache.reserve(static_cast<size_t>(SF_SPKCACHE_LEN) * SF_EMB_DIM);
  int64_t cacheFrames = 0;
  std::vector<float> fifo;
  fifo.reserve(static_cast<size_t>(SF_FIFO_LEN) * SF_EMB_DIM);
  int64_t fifoFrames = 0;
  std::vector<float> allPredictions;

  for (int64_t start = 0; start < numFrames; start += chunkMelFrames) {
    int64_t end = std::min(start + chunkMelFrames, numFrames);
    int64_t chunkLen = end - start;

    std::vector<float> chunkData(melFeatures.begin() + start * MEL_BINS,
                                 melFeatures.begin() + end * MEL_BINS);

    std::vector<int64_t> chunkShape = {1, chunkLen, MEL_BINS};
    Ort::Value chunkTensor = Ort::Value::CreateTensor<float>(
        *memory_info_, chunkData.data(), chunkData.size(), chunkShape.data(),
        chunkShape.size());

    std::vector<int64_t> chunkLenData = {chunkLen};
    std::vector<int64_t> chunkLenShape = {1};
    Ort::Value chunkLenTensor = Ort::Value::CreateTensor<int64_t>(
        *memory_info_, chunkLenData.data(), chunkLenData.size(),
        chunkLenShape.data(), chunkLenShape.size());

    std::vector<int64_t> cacheShape = {1, cacheFrames, SF_EMB_DIM};
    Ort::Value cacheTensor = Ort::Value::CreateTensor<float>(
        *memory_info_, spkcache.data(), spkcache.size(), cacheShape.data(),
        cacheShape.size());

    std::vector<int64_t> cacheLenData = {cacheFrames};
    std::vector<int64_t> cacheLenShape = {1};
    Ort::Value cacheLenTensor = Ort::Value::CreateTensor<int64_t>(
        *memory_info_, cacheLenData.data(), cacheLenData.size(),
        cacheLenShape.data(), cacheLenShape.size());

    std::vector<int64_t> fifoShape = {1, fifoFrames, SF_EMB_DIM};
    Ort::Value fifoTensor =
        Ort::Value::CreateTensor<float>(*memory_info_, fifo.data(), fifo.size(),
                                        fifoShape.data(), fifoShape.size());

    std::vector<int64_t> fifoLenData = {fifoFrames};
    std::vector<int64_t> fifoLenShape = {1};
    Ort::Value fifoLenTensor = Ort::Value::CreateTensor<int64_t>(
        *memory_info_, fifoLenData.data(), fifoLenData.size(),
        fifoLenShape.data(), fifoLenShape.size());

    const char *inputNames[] = {"chunk",    "chunk_lengths",
                                "spkcache", "spkcache_lengths",
                                "fifo",     "fifo_lengths"};
    const char *outputNames[] = {"spkcache_fifo_chunk_preds",
                                 "chunk_pre_encode_embs",
                                 "chunk_pre_encode_lengths"};

    std::vector<Ort::Value> inputs;
    inputs.push_back(std::move(chunkTensor));
    inputs.push_back(std::move(chunkLenTensor));
    inputs.push_back(std::move(cacheTensor));
    inputs.push_back(std::move(cacheLenTensor));
    inputs.push_back(std::move(fifoTensor));
    inputs.push_back(std::move(fifoLenTensor));

    auto outputs =
        sortformer_session_->Run(Ort::RunOptions{nullptr}, inputNames,
                                 inputs.data(), inputs.size(), outputNames, 3);

    auto &predsOut = outputs[0];
    auto predsShape = predsOut.GetTensorTypeAndShapeInfo().GetShape();
    int64_t totalOut = predsShape[1];
    const float *predsData = predsOut.GetTensorData<float>();

    auto &embsOut = outputs[1];
    auto embsShape = embsOut.GetTensorTypeAndShapeInfo().GetShape();
    int64_t embFrames = embsShape[1];
    const float *embsData = embsOut.GetTensorData<float>();

    int64_t chunkPredStart = std::max(int64_t(0), totalOut - embFrames);
    for (int64_t t = chunkPredStart; t < totalOut; ++t) {
      for (int s = 0; s < SF_NUM_SPEAKERS; ++s) {
        allPredictions.push_back(predsData[t * SF_NUM_SPEAKERS + s]);
      }
    }

    size_t newEmbSize = static_cast<size_t>(embFrames * SF_EMB_DIM);
    fifo.insert(fifo.end(), embsData, embsData + newEmbSize);
    fifoFrames += embFrames;
    if (fifoFrames > SF_FIFO_LEN) {
      int64_t excess = fifoFrames - SF_FIFO_LEN;
      fifo.erase(fifo.begin(), fifo.begin() + excess * SF_EMB_DIM);
      fifoFrames = SF_FIFO_LEN;
    }

    spkcache.insert(spkcache.end(), embsData, embsData + newEmbSize);
    cacheFrames += embFrames;
    if (cacheFrames > SF_SPKCACHE_LEN) {
      int64_t excess = cacheFrames - SF_SPKCACHE_LEN;
      spkcache.erase(spkcache.begin(), spkcache.begin() + excess * SF_EMB_DIM);
      cacheFrames = SF_SPKCACHE_LEN;
    }
  }

  int64_t totalPredFrames =
      static_cast<int64_t>(allPredictions.size() / SF_NUM_SPEAKERS);
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Sortformer: " + std::to_string(numFrames) + " mel frames -> " +
           std::to_string(totalPredFrames) + " prediction frames");

  return allPredictions;
}

std::vector<float> ParakeetModel::medianFilter(const std::vector<float> &preds,
                                               int64_t numFrames,
                                               int numSpeakers) const {
  std::vector<float> filtered = preds;
  int half = diarConfig_.medianWindow / 2;
  std::vector<float> window(diarConfig_.medianWindow);

  for (int spk = 0; spk < numSpeakers; ++spk) {
    for (int64_t t = 0; t < numFrames; ++t) {
      int64_t wStart = std::max(int64_t(0), t - half);
      int64_t wEnd = std::min(numFrames, t + half + 1);
      size_t wLen = static_cast<size_t>(wEnd - wStart);

      for (int64_t i = wStart; i < wEnd; ++i) {
        window[static_cast<size_t>(i - wStart)] = preds[i * numSpeakers + spk];
      }

      auto mid = window.begin() + static_cast<ptrdiff_t>(wLen / 2);
      std::nth_element(window.begin(), mid,
                       window.begin() + static_cast<ptrdiff_t>(wLen));
      filtered[t * numSpeakers + spk] = *mid;
    }
  }

  return filtered;
}

std::vector<SpeakerSegment>
ParakeetModel::binarizePredictions(const std::vector<float> &preds,
                                   int64_t numFrames) const {
  std::vector<SpeakerSegment> segments;

  for (int spk = 0; spk < SF_NUM_SPEAKERS; ++spk) {
    bool inSegment = false;
    int64_t segStart = 0;
    std::vector<SpeakerSegment> spkSegments;

    for (int64_t t = 0; t < numFrames; ++t) {
      float p = preds[t * SF_NUM_SPEAKERS + spk];

      if (p >= diarConfig_.onset && !inSegment) {
        inSegment = true;
        segStart = t;
      } else if (p < diarConfig_.offset && inSegment) {
        inSegment = false;
        float startTime = segStart * SF_FRAME_DURATION - diarConfig_.padOnset;
        float endTime = t * SF_FRAME_DURATION + diarConfig_.padOffset;
        if (startTime < 0.0f)
          startTime = 0.0f;

        if (endTime - startTime >= diarConfig_.minDurationOn) {
          spkSegments.push_back({startTime, endTime, spk});
        }
      }
    }

    if (inSegment) {
      float startTime = segStart * SF_FRAME_DURATION - diarConfig_.padOnset;
      float endTime = numFrames * SF_FRAME_DURATION + diarConfig_.padOffset;
      if (startTime < 0.0f)
        startTime = 0.0f;

      if (endTime - startTime >= diarConfig_.minDurationOn) {
        spkSegments.push_back({startTime, endTime, spk});
      }
    }

    if (spkSegments.size() > 1) {
      std::vector<SpeakerSegment> merged = {spkSegments[0]};
      for (size_t i = 1; i < spkSegments.size(); ++i) {
        float gap = spkSegments[i].start - merged.back().end;
        if (gap < diarConfig_.minDurationOff) {
          merged.back().end = spkSegments[i].end;
        } else {
          merged.push_back(spkSegments[i]);
        }
      }
      segments.insert(segments.end(), merged.begin(), merged.end());
    } else {
      segments.insert(segments.end(), spkSegments.begin(), spkSegments.end());
    }
  }

  std::sort(segments.begin(), segments.end(),
            [](const SpeakerSegment &a, const SpeakerSegment &b) {
              return a.start < b.start;
            });

  return segments;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Processing dispatch
// ═════════════════════════════════════════════════════════════════════════════

std::string ParakeetModel::runInferencePipeline(const Input &audio) {
  switch (cfg_.modelType) {
  case ModelType::CTC:
    return processCTC(audio);
  case ModelType::EOU:
    return processEOU(audio);
  case ModelType::SORTFORMER:
    return processSortformer(audio);
  default:
    return processTDT(audio);
  }
}

std::string ParakeetModel::processTDT(const Input &input) {
  std::vector<float> melFeatures;
  int64_t numFrames = 0;
  bool alreadyTransposed = false;

  measureTime(melSpecMs_, [&]() {
    if (preprocessor_session_) {
      auto [features, frames] = runPreprocessor(input);
      melFeatures = std::move(features);
      numFrames = frames;
      alreadyTransposed = true;
    } else {
      melFeatures = computeMelSpectrogram(input);
      numFrames = static_cast<int64_t>(melFeatures.size() / MEL_BINS);
    }
    totalMelFrames_ += numFrames;
  });

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Mel-spectrogram: " + std::to_string(numFrames) + " frames");

  if (melFeatures.empty() || numFrames <= 0) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Audio too short for processing");
    return ERR_AUDIO_SHORT;
  }

  int64_t encodedLength = 0;
  std::vector<float> encoderOutput;

  measureTime(encoderMs_, [&]() {
    encoderOutput =
        runEncoder(melFeatures, numFrames, encodedLength, alreadyTransposed);
    totalEncodedFrames_ += encodedLength;
  });
  throwIfCancelled();

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Encoder output: " + std::to_string(encodedLength) + " encoded frames");

  std::string text;
  measureTime(decoderMs_,
              [&]() { text = greedyDecode(encoderOutput, encodedLength); });
  throwIfCancelled();

  if (!isSentinel(text)) {
    totalTokens_ += static_cast<int64_t>(countWords(text));
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "TDT decoded: " + text);

  return text;
}

std::string ParakeetModel::processCTC(const Input &input) {
  std::vector<float> melFeatures;
  int64_t numFrames = 0;

  measureTime(melSpecMs_, [&]() {
    melFeatures = computeMelSpectrogram(input, CTC_MEL_BINS);
    numFrames = static_cast<int64_t>(melFeatures.size() / CTC_MEL_BINS);
    totalMelFrames_ += numFrames;
  });

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Mel-spectrogram: " + std::to_string(numFrames) + " frames");

  if (melFeatures.empty() || numFrames <= 0) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Audio too short for processing");
    return ERR_AUDIO_SHORT;
  }

  std::vector<float> logits;
  measureTime(encoderMs_,
              [&]() { logits = runCTCModel(melFeatures, numFrames); });
  throwIfCancelled();

  std::string text;
  measureTime(decoderMs_, [&]() { text = ctcGreedyDecode(logits, numFrames); });
  throwIfCancelled();

  if (!isSentinel(text)) {
    totalTokens_ += static_cast<int64_t>(countWords(text));
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "CTC decoded: " + text);

  return text;
}

std::string ParakeetModel::processEOU(const Input &input) {
  std::vector<float> melFeatures;
  int64_t numFrames = 0;

  measureTime(melSpecMs_, [&]() {
    melFeatures = computeMelSpectrogram(input, MEL_BINS);
    numFrames = static_cast<int64_t>(melFeatures.size() / MEL_BINS);
    totalMelFrames_ += numFrames;
  });

  if (melFeatures.empty() || numFrames <= 0)
    return ERR_AUDIO_SHORT;
  if (!eouState_.initialized)
    resetEOUStreamingState();

  std::string fullResult;
  int64_t totalEncoded = 0;
  int eouCount = 0;

  for (int64_t start = 0; start < numFrames;
       start += EOU_ENCODER_CHUNK_FRAMES) {
    throwIfCancelled();
    int64_t end = std::min(
        start + static_cast<int64_t>(EOU_ENCODER_CHUNK_FRAMES), numFrames);
    int64_t chunkLen = end - start;

    if (chunkLen < EOU_MIN_ENCODER_FRAMES && start > 0)
      break;

    std::vector<float> melChunk(melFeatures.begin() + start * MEL_BINS,
                                melFeatures.begin() + end * MEL_BINS);

    int64_t outFrames = 0;
    std::vector<float> encoderOutput;
    measureTime(encoderMs_, [&]() {
      encoderOutput = eouEncodeChunk(melChunk, chunkLen, outFrames);
    });
    throwIfCancelled();
    totalEncoded += outFrames;
    totalEncodedFrames_ += outFrames;

    if (outFrames <= 0)
      continue;

    int chunkEou = 0;
    std::string chunkText;
    measureTime(decoderMs_, [&]() {
      chunkText = eouDecodeChunk(encoderOutput, outFrames, chunkEou);
    });
    throwIfCancelled();
    eouCount += chunkEou;

    if (!chunkText.empty()) {
      if (!fullResult.empty() && fullResult.back() != '\n' &&
          fullResult.back() != ' ') {
        fullResult += " ";
      }
      fullResult += chunkText;
    }
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "EOU streaming: " + std::to_string(numFrames) + " mel frames -> " +
           std::to_string(totalEncoded) + " encoded, " +
           std::to_string(eouCount) + " utterance boundaries");

  std::string text = trimWhitespace(fullResult);
  totalTokens_ += static_cast<int64_t>(countWords(text));

  if (text.empty())
    text = ERR_NO_SPEECH;

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "EOU output: " + text.substr(0, 100) + (text.size() > 100 ? "..." : ""));

  return text;
}

std::string ParakeetModel::processSortformer(const Input &input) {
  std::vector<float> melFeatures;
  int64_t numFrames = 0;

  measureTime(melSpecMs_, [&]() {
    melFeatures = computeMelSpectrogram(input, MEL_BINS);
    numFrames = static_cast<int64_t>(melFeatures.size() / MEL_BINS);
    totalMelFrames_ += numFrames;
  });

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Mel-spectrogram: " + std::to_string(numFrames) + " frames");

  if (melFeatures.empty() || numFrames <= 0) {
    return ERR_AUDIO_SHORT;
  }

  std::string text;
  measureTime(encoderMs_,
              [&]() { text = runSortformerFromMel(melFeatures, numFrames); });
  throwIfCancelled();

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Sortformer output: " + text.substr(0, 80) +
           (text.size() > 80 ? "..." : ""));

  return text;
}

void ParakeetModel::process(const Input &input) {
  throwIfCancelled();

  if (input.empty()) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Empty audio input received");
    return;
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Processing audio: " + std::to_string(input.size()) + " samples");

  auto processStart = std::chrono::high_resolution_clock::now();

  processCalls_++;
  totalSamples_ += input.size();

  float startTime = processed_time_;
  float duration = static_cast<float>(input.size()) / SAMPLE_RATE;

  std::string text;

  bool modelReady = false;
  if (cfg_.modelType == ModelType::CTC) {
    modelReady = is_loaded_ && ctc_session_;
  } else if (cfg_.modelType == ModelType::SORTFORMER) {
    modelReady = is_loaded_ && sortformer_session_;
  } else {
    modelReady = is_loaded_ && encoder_session_ && decoder_session_;
  }

  if (modelReady) {
    try {
      throwIfCancelled();
      text = runInferencePipeline(input);
      throwIfCancelled();
    } catch (const std::exception &e) {
      if (isCancellationError(e)) {
        throw;
      }
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
           std::string("Inference error: ") + e.what());
      text = ERR_INFERENCE;
    }
  } else {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Cannot process: model not loaded");
    text = ERR_MODEL_NOT_LOADED;
  }

  auto processEnd = std::chrono::high_resolution_clock::now();
  totalWallMs_ += std::chrono::duration_cast<std::chrono::milliseconds>(
                      processEnd - processStart)
                      .count();

  Transcript transcript;
  transcript.text = text;
  transcript.start = startTime;
  transcript.end = startTime + duration;
  transcript.toAppend = true;
  output_.push_back(transcript);

  processed_time_ += duration;
  totalTranscriptions_++;

  if (on_segment_) {
    on_segment_(transcript);
  }
}

ParakeetModel::Output
ParakeetModel::process(const Input &input,
                       std::function<void(const Output &)> callback) {
  process(input);
  Output result = std::move(output_);
  output_.clear();

  if (callback) {
    callback(result);
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Audio preprocessing
// ═════════════════════════════════════════════════════════════════════════════

std::any ParakeetModel::process(const std::any &input) {
  AnyInput modelInput;
  if (const auto *anyInput = std::any_cast<AnyInput>(&input)) {
    modelInput = *anyInput;
  } else if (const auto *inputVector = std::any_cast<Input>(&input)) {
    modelInput.input = *inputVector;
  } else {
    throw std::invalid_argument(
        std::string("Invalid input type for ParakeetModel::process: ") +
        input.type().name());
  }

  const auto generation =
      nextGeneration_.fetch_add(1, std::memory_order_relaxed);
  reset();
  activeGeneration_.store(generation, std::memory_order_relaxed);
  try {
    process(modelInput.input);
  } catch (...) {
    activeGeneration_.store(0, std::memory_order_relaxed);
    throw;
  }
  activeGeneration_.store(0, std::memory_order_relaxed);
  return output_;
}

std::vector<float>
ParakeetModel::preprocessAudioData(const std::vector<uint8_t> &audioData,
                                   const std::string &audioFormat) {
  std::vector<float> result;

  if (audioFormat == "s16le") {
    result.reserve(audioData.size() / 2);
    for (size_t i = 0; i + 1 < audioData.size(); i += 2) {
      int16_t sample = static_cast<int16_t>(audioData[i]) |
                       (static_cast<int16_t>(audioData[i + 1]) << 8);
      result.push_back(static_cast<float>(sample) / 32768.0f);
    }
  } else if (audioFormat == "f32le") {
    size_t numSamples = audioData.size() / sizeof(float);
    result.resize(numSamples);
    std::memcpy(result.data(), audioData.data(), numSamples * sizeof(float));
  } else {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Unknown audio format: " + audioFormat);
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Runtime stats
// ═════════════════════════════════════════════════════════════════════════════
qvac_lib_inference_addon_cpp::RuntimeStats ParakeetModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;

  const double audioDurationSec =
      totalSamples_ > 0 ? static_cast<double>(totalSamples_) / SAMPLE_RATE
                        : 0.0;
  const int64_t audioDurationMs =
      static_cast<int64_t>(audioDurationSec * 1000.0);
  const double totalTimeSec = totalWallMs_ / 1000.0;
  const double rtf =
      audioDurationSec > 0.0 ? (totalTimeSec / audioDurationSec) : 0.0;
  const double tps = totalTimeSec > 0.0
                         ? (static_cast<double>(totalTokens_) / totalTimeSec)
                         : 0.0;
  const double msPerToken =
      totalTokens_ > 0 ? (static_cast<double>(totalWallMs_) / totalTokens_)
                       : 0.0;

  stats.emplace_back("totalTime", totalTimeSec);
  stats.emplace_back("realTimeFactor", rtf);
  stats.emplace_back("tokensPerSecond", tps);
  stats.emplace_back("msPerToken", msPerToken);
  stats.emplace_back("audioDurationMs", audioDurationMs);
  stats.emplace_back("totalSamples", totalSamples_);
  stats.emplace_back("totalTokens", totalTokens_);
  stats.emplace_back("totalTranscriptions", totalTranscriptions_);
  stats.emplace_back("processCalls", processCalls_);
  stats.emplace_back("modelLoadMs", modelLoadMs_);
  stats.emplace_back("melSpecMs", melSpecMs_);
  stats.emplace_back("encoderMs", encoderMs_);
  stats.emplace_back("decoderMs", decoderMs_);
  stats.emplace_back("totalWallMs", totalWallMs_);
  stats.emplace_back("totalMelFrames", totalMelFrames_);
  stats.emplace_back("totalEncodedFrames", totalEncodedFrames_);

  return stats;
}

void ParakeetModel::cancel() const {
  const auto activeGeneration =
      activeGeneration_.load(std::memory_order_relaxed);
  if (activeGeneration != 0) {
    cancelGeneration_.store(activeGeneration, std::memory_order_relaxed);
  }
}

void ParakeetModel::throwIfCancelled() const {
  const auto activeGeneration =
      activeGeneration_.load(std::memory_order_relaxed);
  if (activeGeneration != 0 &&
      cancelGeneration_.load(std::memory_order_relaxed) == activeGeneration) {
    cancelGeneration_.store(0, std::memory_order_relaxed);
    throw std::runtime_error(ERR_JOB_CANCELLED);
  }
}

bool ParakeetModel::isCancellationError(const std::exception &e) {
  return std::string_view(e.what()) == ERR_JOB_CANCELLED;
}

} // namespace qvac_lib_infer_parakeet
