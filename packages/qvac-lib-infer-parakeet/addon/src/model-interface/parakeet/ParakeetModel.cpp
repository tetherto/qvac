#include "ParakeetModel.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstring>
#include <filesystem>
#include <fstream>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include <istream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <vector>

#include "onnxruntime/onnxruntime_cxx_api.h"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#include <Eigen/Core>
#include <unsupported/Eigen/FFT>

namespace qvac_lib_infer_parakeet {

namespace {
template<typename Func>
void measureTime(int64_t& accumulator, Func&& operation) {
  auto start = std::chrono::high_resolution_clock::now();
  operation();
  auto end = std::chrono::high_resolution_clock::now();
  accumulator += std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
}
} // anonymous namespace

ParakeetModel::ParakeetModel(const ParakeetConfig& config) : cfg_(config) {
  ort_env_ = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_WARNING, "Parakeet");
  reset();
}

ParakeetModel::~ParakeetModel() {
  unload();
}

void ParakeetModel::initializeBackend() {
  // Already initialized in constructor
}

void ParakeetModel::set_weights_for_file(
    const std::string& filename,
    const std::span<const uint8_t>& contents, bool completed) {
  if (completed) {
    model_weights_[filename] = std::vector<uint8_t>(contents.begin(), contents.end());
    if (filename == "vocab.txt") {
      loadVocabulary(model_weights_[filename]);
    }
  }
}

void ParakeetModel::set_weights_for_file(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>> streambuf) {
  std::istream stream(streambuf.get());
  std::vector<uint8_t> data((std::istreambuf_iterator<char>(stream)),
                            std::istreambuf_iterator<char>());
  
  model_weights_[filename] = std::move(data);
  if (filename == "vocab.txt") {
    loadVocabulary(model_weights_[filename]);
  }
}

void ParakeetModel::loadVocabulary(const std::vector<uint8_t>& vocabData) {
  std::string vocabStr(vocabData.begin(), vocabData.end());
  std::istringstream iss(vocabStr);
  std::string line;
  
  vocab_.clear();
  while (std::getline(iss, line)) {
    // Each line format: "token index" - we just need the token
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

void ParakeetModel::load() {
  if (is_loaded_) return;
  
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Loading Parakeet models from: " + cfg_.modelPath);
  
  auto loadStart = std::chrono::high_resolution_clock::now();
  
  try {
    memory_info_ = std::make_unique<Ort::MemoryInfo>(
        Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault));
    
    Ort::SessionOptions session_options;
    session_options.SetIntraOpNumThreads(cfg_.maxThreads);
    session_options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

    // Enable deterministic compute when seed is set (for GPU reproducibility)
    if (cfg_.seed >= 0) {
      session_options.SetDeterministicCompute(true);
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
           "Deterministic compute enabled (seed=" + std::to_string(cfg_.seed) +
               ")");
    }

    const bool useNamedPaths = !cfg_.encoderPath.empty();
    std::filesystem::path stagingDir;

    // === Encoder ===
    if (useNamedPaths) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
           "Loading encoder from path: " + cfg_.encoderPath);

      bool hasExternalData = !cfg_.encoderDataPath.empty() &&
                             std::filesystem::exists(cfg_.encoderDataPath);

      if (hasExternalData) {
        // ONNX Runtime resolves external data relative to the model file.
        // Stage symlinks with canonical names so the .data file is found
        // alongside the .onnx file in the same directory.
        stagingDir = std::filesystem::temp_directory_path() /
                     ("parakeet_enc_" +
                      std::to_string(reinterpret_cast<uintptr_t>(this)));
        std::filesystem::create_directories(stagingDir);

        auto encLink = stagingDir / "encoder-model.onnx";
        auto dataLink = stagingDir / "encoder-model.onnx.data";
        std::filesystem::create_symlink(cfg_.encoderPath, encLink);
        std::filesystem::create_symlink(cfg_.encoderDataPath, dataLink);

        try {
          encoder_session_ = std::make_unique<Ort::Session>(
              *ort_env_, encLink.c_str(), session_options);
        } catch (...) {
          std::filesystem::remove_all(stagingDir);
          throw;
        }
        std::filesystem::remove_all(stagingDir);
        stagingDir.clear();
      } else {
#ifdef _WIN32
        std::wstring wPath(cfg_.encoderPath.begin(), cfg_.encoderPath.end());
        encoder_session_ = std::make_unique<Ort::Session>(
            *ort_env_, wPath.c_str(), session_options);
#else
        encoder_session_ = std::make_unique<Ort::Session>(
            *ort_env_, cfg_.encoderPath.c_str(), session_options);
#endif
      }
    } else {
      auto encoderIt = model_weights_.find("encoder-model.onnx");
      if (encoderIt == model_weights_.end()) {
        QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
             "Encoder model weights not found");
        throw std::runtime_error("Encoder model not loaded");
      }

      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
           "Loading encoder session...");

      std::string encoderPath = cfg_.modelPath + "/encoder-model.onnx";
      std::string encoderDataPath = cfg_.modelPath + "/encoder-model.onnx.data";
      bool hasExternalData = std::filesystem::exists(encoderDataPath);

      if (hasExternalData) {
        // ONNX Runtime resolves external data files relative to the model
        // file's directory when given an absolute path, so no chdir needed.
#ifdef _WIN32
        std::wstring wEncoderPath(encoderPath.begin(), encoderPath.end());
        encoder_session_ = std::make_unique<Ort::Session>(
            *ort_env_, wEncoderPath.c_str(), session_options);
#else
        encoder_session_ = std::make_unique<Ort::Session>(
            *ort_env_, encoderPath.c_str(), session_options);
#endif
      } else {
        encoder_session_ = std::make_unique<Ort::Session>(
            *ort_env_, encoderIt->second.data(), encoderIt->second.size(),
            session_options);
      }
    }

    // === Decoder ===
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "Loading decoder session...");
    if (useNamedPaths && !cfg_.decoderPath.empty()) {
#ifdef _WIN32
      std::wstring wPath(cfg_.decoderPath.begin(), cfg_.decoderPath.end());
      decoder_session_ = std::make_unique<Ort::Session>(
          *ort_env_, wPath.c_str(), session_options);
#else
      decoder_session_ = std::make_unique<Ort::Session>(
          *ort_env_, cfg_.decoderPath.c_str(), session_options);
#endif
    } else {
      auto decoderIt = model_weights_.find("decoder_joint-model.onnx");
      if (decoderIt == model_weights_.end()) {
        QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
             "Decoder model weights not found");
        throw std::runtime_error("Decoder model not loaded");
      }
      decoder_session_ = std::make_unique<Ort::Session>(
          *ort_env_, decoderIt->second.data(), decoderIt->second.size(),
          session_options);
    }

    // === Preprocessor (optional) ===
    if (useNamedPaths && !cfg_.preprocessorPath.empty()) {
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
    } else {
      auto preprocessorIt = model_weights_.find("preprocessor.onnx");
      if (preprocessorIt != model_weights_.end()) {
        QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
             "Loading preprocessor session...");
        preprocessor_session_ = std::make_unique<Ort::Session>(
            *ort_env_, preprocessorIt->second.data(),
            preprocessorIt->second.size(), session_options);
      }
    }

    // === Vocabulary (load from file if not already loaded via
    // set_weights_for_file) ===
    if (useNamedPaths && vocab_.empty() && !cfg_.vocabPath.empty()) {
      std::ifstream vocabFile(cfg_.vocabPath, std::ios::binary);
      if (vocabFile.is_open()) {
        std::vector<uint8_t> vocabData(
            (std::istreambuf_iterator<char>(vocabFile)),
            std::istreambuf_iterator<char>());
        loadVocabulary(vocabData);
      }
    }

    is_loaded_ = true;
    
    auto loadEnd = std::chrono::high_resolution_clock::now();
    modelLoadMs_ = std::chrono::duration_cast<std::chrono::milliseconds>(loadEnd - loadStart).count();
    
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
         "Parakeet models loaded successfully in " + std::to_string(modelLoadMs_) + "ms");

    // Perform warmup to eliminate cold start penalty
    if (!is_warmed_up_) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
           "Warming up Parakeet model");
      warmup();
      is_warmed_up_ = true;
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
           "Parakeet model warmup completed");
    }

  } catch (const Ort::Exception& e) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
         std::string("ONNX Runtime error: ") + e.what());
    throw;
  }
}

void ParakeetModel::unload() {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Unloading Parakeet model");
  
  preprocessor_session_.reset();
  encoder_session_.reset();
  decoder_session_.reset();
  memory_info_.reset();
  is_loaded_ = false;
  is_warmed_up_ = false;

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Parakeet model unloaded successfully");
}

std::tuple<std::vector<float>, int64_t, bool>
ParakeetModel::computeFeatures(const Input &audio) {
  // Compute mel-spectrogram features from audio
  // Uses ONNX preprocessor if available, otherwise falls back to manual
  // computation

  std::vector<float> melFeatures;
  int64_t numFrames = 0;
  bool alreadyTransposed = false;

  if (preprocessor_session_) {
    // ONNX preprocessor produces pre-transposed features
    auto [features, frames] = runPreprocessor(audio);
    melFeatures = std::move(features);
    numFrames = frames;
    alreadyTransposed = true;
  } else {
    // Manual mel-spectrogram computation (not pre-transposed)
    melFeatures = computeMelSpectrogram(audio);
    numFrames = static_cast<int64_t>(melFeatures.size() / MEL_BINS);
    alreadyTransposed = false;
  }

  return {std::move(melFeatures), numFrames, alreadyTransposed};
}

std::string ParakeetModel::runInferencePipeline(const Input &audio) {
  // Run the complete STT inference pipeline:
  //   1. Compute mel-spectrogram features from audio
  //   2. Run encoder to get acoustic embeddings
  //   3. Run decoder (greedy search) to get text tokens
  //
  // Returns empty string if audio is too short for processing

  // Step 1: Compute features
  auto [melFeatures, numFrames, alreadyTransposed] = computeFeatures(audio);

  if (melFeatures.empty() || numFrames <= 0) {
    return "";
  }

  // Step 2: Run encoder
  int64_t encodedLength = 0;
  auto encoderOutput =
      runEncoder(melFeatures, numFrames, encodedLength, alreadyTransposed);

  if (encoderOutput.empty() || encodedLength <= 0) {
    return "";
  }

  // Step 3: Run decoder (greedy decode)
  return greedyDecode(encoderOutput, encodedLength);
}

void ParakeetModel::warmup() {
  if (!is_loaded_ || !encoder_session_ || !decoder_session_) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Cannot warmup - model not loaded");
    return;
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Starting model warmup");

  auto warmupStart = std::chrono::high_resolution_clock::now();

  // Generate 0.5s of silent audio (8000 samples at 16kHz)
  // This is enough to run through all model components without producing output
  constexpr size_t WARMUP_SAMPLES = 8000;
  std::vector<float> silentAudio(WARMUP_SAMPLES, 0.0f);

  try {
    // Run the full inference pipeline to initialize all ONNX Runtime internals
    runInferencePipeline(silentAudio);

    auto warmupEnd = std::chrono::high_resolution_clock::now();
    auto warmupMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                        warmupEnd - warmupStart)
                        .count();

    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "Model warmup completed in " + std::to_string(warmupMs) + "ms");

  } catch (const std::exception &e) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         std::string("Warmup inference failed (non-fatal): ") + e.what());
    // Warmup failure is non-fatal - model can still work, just slower on first
    // real inference
  }
}

// Helper: Convert frequency to mel scale
static float hzToMel(float hz) {
  return 2595.0f * std::log10(1.0f + hz / 700.0f);
}

// Helper: Convert mel to frequency
static float melToHz(float mel) {
  return 700.0f * (std::pow(10.0f, mel / 2595.0f) - 1.0f);
}

// Build mel filterbank matrix
static std::vector<std::vector<float>> buildMelFilterbank(
    int numMelBins, int fftSize, float sampleRate,
    float fMin = 0.0f, float fMax = 8000.0f) {
  
  int numFftBins = fftSize / 2 + 1;
  
  // Compute mel points
  float melMin = hzToMel(fMin);
  float melMax = hzToMel(fMax);
  
  std::vector<float> melPoints(numMelBins + 2);
  for (int i = 0; i < numMelBins + 2; ++i) {
    melPoints[i] = melMin + (melMax - melMin) * i / (numMelBins + 1);
  }
  
  // Convert mel points to frequency bins
  std::vector<int> binPoints(numMelBins + 2);
  for (int i = 0; i < numMelBins + 2; ++i) {
    float hz = melToHz(melPoints[i]);
    binPoints[i] = static_cast<int>(std::floor((fftSize + 1) * hz / sampleRate));
  }
  
  // Build filterbank
  std::vector<std::vector<float>> filterbank(numMelBins, std::vector<float>(numFftBins, 0.0f));
  
  for (int m = 0; m < numMelBins; ++m) {
    int left = binPoints[m];
    int center = binPoints[m + 1];
    int right = binPoints[m + 2];
    
    // Rising slope
    for (int k = left; k < center && k < numFftBins; ++k) {
      if (center != left) {
        filterbank[m][k] = static_cast<float>(k - left) / (center - left);
      }
    }
    
    // Falling slope
    for (int k = center; k < right && k < numFftBins; ++k) {
      if (right != center) {
        filterbank[m][k] = static_cast<float>(right - k) / (right - center);
      }
    }
  }
  
  return filterbank;
}

std::vector<float> ParakeetModel::computeMelSpectrogram(const Input& audio) {
  const size_t numSamples = audio.size();
  
  if (numSamples < static_cast<size_t>(WIN_LENGTH)) {
    return {};
  }
  
  // NeMo models don't use preemphasis - use audio directly
  const size_t numFrames = (numSamples - WIN_LENGTH) / HOP_LENGTH + 1;
  
  if (numFrames == 0) {
    return {};
  }
  
  // Step 2: Precompute Hann window
  std::vector<float> hannWindow(WIN_LENGTH);
  for (int i = 0; i < WIN_LENGTH; ++i) {
    hannWindow[i] = 0.5f * (1.0f - std::cos(2.0f * M_PI * i / (WIN_LENGTH - 1)));
  }
  
  // Step 3: Build mel filterbank (cache this for efficiency in production)
  // fMax = sample_rate / 2 (Nyquist frequency)
  static auto melFilterbank = buildMelFilterbank(MEL_BINS, FFT_SIZE, SAMPLE_RATE, 0.0f, SAMPLE_RATE / 2.0f);
  
  // Initialize Eigen FFT
  Eigen::FFT<float> fft;
  
  // Number of FFT bins (positive frequencies only)
  const int numFftBins = FFT_SIZE / 2 + 1;
  
  // Output mel spectrogram: [numFrames, MEL_BINS]
  std::vector<float> melSpec(numFrames * MEL_BINS);
  
  // Buffer for windowed frame
  std::vector<float> frame(FFT_SIZE, 0.0f);
  std::vector<std::complex<float>> spectrum(FFT_SIZE);
  
  for (size_t f = 0; f < numFrames; ++f) {
    size_t startSample = f * HOP_LENGTH;
    
    // Clear frame buffer
    std::fill(frame.begin(), frame.end(), 0.0f);
    
    // Apply Hann window to audio (NeMo doesn't use preemphasis)
    for (int i = 0; i < WIN_LENGTH && (startSample + i) < numSamples; ++i) {
      frame[i] = audio[startSample + i] * hannWindow[i];
    }
    
    // Step 4: Compute FFT (STFT)
    fft.fwd(spectrum, frame);
    
    // Compute power spectrum (magnitude squared)
    std::vector<float> powerSpec(numFftBins);
    for (int k = 0; k < numFftBins; ++k) {
      powerSpec[k] = std::norm(spectrum[k]);  // |z|^2
    }
    
    // Step 5: Apply mel filterbank
    for (int m = 0; m < MEL_BINS; ++m) {
      float melEnergy = 0.0f;
      for (int k = 0; k < numFftBins; ++k) {
        melEnergy += melFilterbank[m][k] * powerSpec[k];
      }
      // Step 6: Apply log compression
      melSpec[f * MEL_BINS + m] = std::log(std::max(melEnergy, 1e-10f));
    }
  }
  
  // Step 7: Apply per-utterance cepstral mean and variance normalization (CMVN)
  // Compute mean for each mel bin across all frames
  std::vector<float> mean(MEL_BINS, 0.0f);
  std::vector<float> stddev(MEL_BINS, 0.0f);
  
  for (size_t f = 0; f < numFrames; ++f) {
    for (int m = 0; m < MEL_BINS; ++m) {
      mean[m] += melSpec[f * MEL_BINS + m];
    }
  }
  for (int m = 0; m < MEL_BINS; ++m) {
    mean[m] /= static_cast<float>(numFrames);
  }
  
  // Compute stddev
  for (size_t f = 0; f < numFrames; ++f) {
    for (int m = 0; m < MEL_BINS; ++m) {
      float diff = melSpec[f * MEL_BINS + m] - mean[m];
      stddev[m] += diff * diff;
    }
  }
  for (int m = 0; m < MEL_BINS; ++m) {
    stddev[m] = std::sqrt(stddev[m] / static_cast<float>(numFrames) + 1e-10f);
  }
  
  // Normalize: (x - mean) / stddev
  for (size_t f = 0; f < numFrames; ++f) {
    for (int m = 0; m < MEL_BINS; ++m) {
      melSpec[f * MEL_BINS + m] = (melSpec[f * MEL_BINS + m] - mean[m]) / stddev[m];
    }
  }
  
  return melSpec;
}

std::vector<float> ParakeetModel::runEncoder(
    const std::vector<float>& melFeatures, 
    int64_t numFrames,
    int64_t& encodedLength,
    bool alreadyTransposed) {
  
  if (!encoder_session_) {
    throw std::runtime_error("Encoder session not initialized");
  }
  
  std::vector<float> encoderInput;
  
  if (alreadyTransposed) {
    // Features from ONNX preprocessor are already in [batch, bins, frames] format
    encoderInput = melFeatures;
  } else {
    // Manual mel spectrogram is in [frames, bins] order, transpose to [bins, frames]
    encoderInput.resize(melFeatures.size());
    for (int64_t f = 0; f < numFrames; ++f) {
      for (int b = 0; b < MEL_BINS; ++b) {
        // Source: [f * MEL_BINS + b]
        // Dest: [b * numFrames + f]
        encoderInput[b * numFrames + f] = melFeatures[f * MEL_BINS + b];
      }
    }
  }
  
  // Prepare input tensor: shape [batch=1, mel_bins=128, num_frames]
  std::vector<int64_t> inputShape = {1, MEL_BINS, numFrames};
  
  // Create input tensor
  Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
      *memory_info_, 
      encoderInput.data(), 
      encoderInput.size(),
      inputShape.data(), 
      inputShape.size());
  
  // Prepare length tensor: shape [batch=1]
  std::vector<int64_t> lengthData = {numFrames};
  std::vector<int64_t> lengthShape = {1};
  Ort::Value lengthTensor = Ort::Value::CreateTensor<int64_t>(
      *memory_info_,
      lengthData.data(),
      lengthData.size(),
      lengthShape.data(),
      lengthShape.size());
  
  // Input names
  const char* inputNames[] = {"audio_signal", "length"};
  const char* outputNames[] = {"outputs", "encoded_lengths"};
  
  // Run inference
  std::vector<Ort::Value> inputTensors;
  inputTensors.push_back(std::move(inputTensor));
  inputTensors.push_back(std::move(lengthTensor));
  
  auto outputs = encoder_session_->Run(
      Ort::RunOptions{nullptr},
      inputNames, inputTensors.data(), inputTensors.size(),
      outputNames, 2);
  
  // Get encoder output
  auto& encoderOutput = outputs[0];
  auto outputInfo = encoderOutput.GetTensorTypeAndShapeInfo();
  auto outputShape = outputInfo.GetShape();
  
  // Shape is [batch, encoder_dim, time_steps]
  size_t outputSize = outputInfo.GetElementCount();
  const float* outputData = encoderOutput.GetTensorData<float>();
  
  // Get encoded length
  const int64_t* lengthPtr = outputs[1].GetTensorData<int64_t>();
  encodedLength = lengthPtr[0];
  
  return std::vector<float>(outputData, outputData + outputSize);
}

int64_t ParakeetModel::getLanguageToken(const std::string& langCode) const {
  // Search vocab for language token like <|es|>, <|en|>, etc.
  std::string langToken = "<|" + langCode + "|>";
  for (size_t i = 0; i < vocab_.size(); ++i) {
    if (vocab_[i] == langToken) {
      return static_cast<int64_t>(i);
    }
  }
  // Return predict_lang token for auto-detection if language not found
  return PREDICT_LANG;
}

std::string ParakeetModel::greedyDecode(
    const std::vector<float>& encoderOutput,
    int64_t encodedLength) {
  
  if (!decoder_session_ || vocab_.empty()) {
    return "[Model not ready]";
  }
  
  const size_t vocabSize = vocab_.size();
  const int maxTokensPerStep = 10;  // Safety: max tokens from one frame
  
  std::vector<int64_t> decodedTokens;
  
  // Initialize decoder states (2 LSTM layers, shape: [2, 1, 640])
  std::vector<float> state1(2 * 1 * DECODER_STATE_DIM, 0.0f);
  std::vector<float> state2(2 * 1 * DECODER_STATE_DIM, 0.0f);
  
  // TDT greedy decoding following sherpa-onnx implementation
  // The prediction network starts with blank token
  int32_t lastEmittedToken = static_cast<int32_t>(BLANK_TOKEN);
  
  // Track tokens emitted from current frame (safety limit)
  int tokensThisFrame = 0;
  
  // Time step advancement (skip) - can be 0 meaning stay on same frame
  int skip = 0;
  
  for (int64_t t = 0; t < encodedLength; t += skip) {
    // Prepare encoder output slice for current time step
    // Shape: [batch=1, encoder_dim=1024, time=1]
    std::vector<float> encoderSlice(ENCODER_DIM);
    for (int i = 0; i < ENCODER_DIM; ++i) {
      // encoderOutput shape is [1, 1024, T], we want frame at t
      encoderSlice[i] = encoderOutput[i * encodedLength + t];
    }
    
    std::vector<int64_t> encoderShape = {1, ENCODER_DIM, 1};
    Ort::Value encoderTensor = Ort::Value::CreateTensor<float>(
        *memory_info_,
        encoderSlice.data(),
        encoderSlice.size(),
        encoderShape.data(),
        encoderShape.size());
    
    // Prepare target (last emitted token for prediction network)
    std::vector<int32_t> targetData = {lastEmittedToken};
    std::vector<int64_t> targetShape = {1, 1};
    Ort::Value targetTensor = Ort::Value::CreateTensor<int32_t>(
        *memory_info_,
        targetData.data(),
        targetData.size(),
        targetShape.data(),
        targetShape.size());
    
    // Target length
    std::vector<int32_t> targetLengthData = {1};
    std::vector<int64_t> targetLengthShape = {1};
    Ort::Value targetLengthTensor = Ort::Value::CreateTensor<int32_t>(
        *memory_info_,
        targetLengthData.data(),
        targetLengthData.size(),
        targetLengthShape.data(),
        targetLengthShape.size());
    
    // State tensors
    std::vector<int64_t> stateShape = {2, 1, DECODER_STATE_DIM};
    Ort::Value state1Tensor = Ort::Value::CreateTensor<float>(
        *memory_info_,
        state1.data(),
        state1.size(),
        stateShape.data(),
        stateShape.size());
    Ort::Value state2Tensor = Ort::Value::CreateTensor<float>(
        *memory_info_,
        state2.data(),
        state2.size(),
        stateShape.data(),
        stateShape.size());
    
    // Input names for decoder
    const char* decoderInputNames[] = {
        "encoder_outputs", "targets", "target_length", 
        "input_states_1", "input_states_2"
    };
    const char* decoderOutputNames[] = {
        "outputs", "prednet_lengths", "output_states_1", "output_states_2"
    };
    
    std::vector<Ort::Value> decoderInputs;
    decoderInputs.push_back(std::move(encoderTensor));
    decoderInputs.push_back(std::move(targetTensor));
    decoderInputs.push_back(std::move(targetLengthTensor));
    decoderInputs.push_back(std::move(state1Tensor));
    decoderInputs.push_back(std::move(state2Tensor));
    
    // Run decoder/joiner
    auto decoderOutputs = decoder_session_->Run(
        Ort::RunOptions{nullptr},
        decoderInputNames, decoderInputs.data(), decoderInputs.size(),
        decoderOutputNames, 4);
    
    // Get logits - TDT outputs [vocab_size + num_durations]
    const float* logits = decoderOutputs[0].GetTensorData<float>();
    auto logitsInfo = decoderOutputs[0].GetTensorTypeAndShapeInfo();
    size_t outputSize = logitsInfo.GetShape().back();
    size_t numDurations = outputSize - vocabSize;
    
    // Split into token logits and duration logits
    const float* tokenLogits = logits;
    const float* durationLogits = logits + vocabSize;
    
    // Find argmax over vocabulary tokens
    int64_t tokenId = 0;
    float bestScore = tokenLogits[0];
    for (size_t i = 1; i < vocabSize; ++i) {
      if (tokenLogits[i] > bestScore) {
        bestScore = tokenLogits[i];
        tokenId = static_cast<int64_t>(i);
      }
    }
    
    // Find argmax over duration predictions (skip value)
    // Duration values are 0, 1, 2, 3, 4 (TDT has 5 duration classes)
    skip = 0;
    if (numDurations > 0) {
      float bestDur = durationLogits[0];
      size_t bestIdx = 0;
      for (size_t i = 1; i < numDurations; ++i) {
        if (durationLogits[i] > bestDur) {
          bestDur = durationLogits[i];
          bestIdx = i;
        }
      }
      skip = static_cast<int>(bestIdx);
    }
    
    // Process the predicted token
    if (tokenId != BLANK_TOKEN) {
      // Non-blank token: update decoder states
      const float* newState1 = decoderOutputs[2].GetTensorData<float>();
      const float* newState2 = decoderOutputs[3].GetTensorData<float>();
      std::copy(newState1, newState1 + state1.size(), state1.begin());
      std::copy(newState2, newState2 + state2.size(), state2.begin());
      
      // Check for end of sequence
      if (tokenId == EOS_TOKEN) {
        break;
      }
      
      // Emit token (skip special tokens)
      if (tokenId != NOSPEECH_TOKEN && tokenId != PAD_TOKEN) {
        decodedTokens.push_back(tokenId);
      }
      
      lastEmittedToken = static_cast<int32_t>(tokenId);
      tokensThisFrame++;
    }
    
    // Advance frame based on skip (duration prediction)
    if (skip > 0) {
      tokensThisFrame = 0;
    }
    
    // Safety: limit tokens per frame to prevent infinite loops
    if (tokensThisFrame >= maxTokensPerStep) {
      tokensThisFrame = 0;
      skip = 1;
    }
    
    // If blank with skip=0, force advance to prevent infinite loop
    if (tokenId == BLANK_TOKEN && skip == 0) {
      tokensThisFrame = 0;
      skip = 1;
    }
  }
  
  // Convert tokens to text
  std::string result;
  for (int64_t token : decodedTokens) {
    if (token >= 0 && static_cast<size_t>(token) < vocab_.size()) {
      std::string piece = vocab_[token];
      
      // Handle sentencepiece encoding (▁ = space)
      if (!piece.empty()) {
        // Skip special tokens
        if (piece[0] == '<' && piece.back() == '>') {
          continue;
        }
        
        // Replace ▁ with space (UTF-8: E2 96 81)
        size_t pos = 0;
        while ((pos = piece.find("\xe2\x96\x81", pos)) != std::string::npos) {
          piece.replace(pos, 3, " ");
          pos += 1;
        }
        
        result += piece;
      }
    }
  }
  
  // Trim leading/trailing whitespace
  size_t start = result.find_first_not_of(' ');
  size_t end = result.find_last_not_of(' ');
  if (start != std::string::npos && end != std::string::npos) {
    result = result.substr(start, end - start + 1);
  }
  
  return result.empty() ? "[No speech detected]" : result;
}

std::pair<std::vector<float>, int64_t> ParakeetModel::runPreprocessor(const Input& audio) {
  if (!preprocessor_session_ || audio.empty()) {
    return {{}, 0};
  }
  
  // Prepare input: waveforms [batch=1, N] and waveforms_lens [batch=1]
  std::vector<int64_t> waveformShape = {1, static_cast<int64_t>(audio.size())};
  std::vector<float> audioData(audio.begin(), audio.end());
  
  Ort::Value waveformTensor = Ort::Value::CreateTensor<float>(
      *memory_info_,
      audioData.data(),
      audioData.size(),
      waveformShape.data(),
      waveformShape.size());
  
  std::vector<int64_t> waveformLens = {static_cast<int64_t>(audio.size())};
  std::vector<int64_t> lensShape = {1};
  Ort::Value lensTensor = Ort::Value::CreateTensor<int64_t>(
      *memory_info_,
      waveformLens.data(),
      waveformLens.size(),
      lensShape.data(),
      lensShape.size());
  
  const char* inputNames[] = {"waveforms", "waveforms_lens"};
  const char* outputNames[] = {"features", "features_lens"};
  
  std::vector<Ort::Value> inputs;
  inputs.push_back(std::move(waveformTensor));
  inputs.push_back(std::move(lensTensor));
  
  auto outputs = preprocessor_session_->Run(
      Ort::RunOptions{nullptr},
      inputNames, inputs.data(), inputs.size(),
      outputNames, 2);
  
  // Get output: features [batch, 128, T] and features_lens [batch]
  auto& featuresTensor = outputs[0];
  auto featuresInfo = featuresTensor.GetTensorTypeAndShapeInfo();
  auto featuresShape = featuresInfo.GetShape();
  
  const float* featuresData = featuresTensor.GetTensorData<float>();
  size_t featuresSize = featuresInfo.GetElementCount();
  
  // Use the actual shape for numFrames, not the length output (which can be off by 1)
  int64_t numFrames = featuresShape[2];  // Shape is [batch, 128, T]
  
  return {std::vector<float>(featuresData, featuresData + featuresSize), numFrames};
}

void ParakeetModel::process(const Input& input) {
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
  int64_t encodedLength = 0;
  
  if (is_loaded_ && encoder_session_ && decoder_session_) {
    try {
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
          alreadyTransposed = false;
        }
        totalMelFrames_ += numFrames;
      });
      
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
           "Mel-spectrogram: " + std::to_string(numFrames) + " frames");
      
      if (!melFeatures.empty() && numFrames > 0) {
        std::vector<float> encoderOutput;
        
        measureTime(encoderMs_, [&]() {
          encoderOutput = runEncoder(melFeatures, numFrames, encodedLength, alreadyTransposed);
          totalEncodedFrames_ += encodedLength;
        });
        
        QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
             "Encoder output: " + std::to_string(encodedLength) + " encoded frames");
        
        measureTime(decoderMs_, [&]() {
          text = greedyDecode(encoderOutput, encodedLength);
        });
        
        size_t wordCount = std::count(text.begin(), text.end(), ' ') + (text.empty() ? 0 : 1);
        totalTokens_ += static_cast<int64_t>(wordCount);
        
        QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
             "Decoded: " + std::to_string(wordCount) + " tokens, text: " + text);
      } else {
        QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
             "Audio too short for processing");
        text = "[Audio too short]";
      }
    } catch (const std::exception& e) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
           std::string("Inference error: ") + e.what());
      text = "[Inference error]";
    }
  } else {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
         "Cannot process: model not loaded");
    text = "[Model not loaded]";
  }
  
  auto processEnd = std::chrono::high_resolution_clock::now();
  totalWallMs_ += std::chrono::duration_cast<std::chrono::milliseconds>(processEnd - processStart).count();
  
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

ParakeetModel::Output ParakeetModel::process(
    const Input& input, std::function<void(const Output&)> callback) {
  process(input);
  Output result = std::move(output_);
  output_.clear();

  if (callback) {
    callback(result);
  }

  return result;
}

std::vector<float> ParakeetModel::preprocessAudioData(
    const std::vector<uint8_t>& audioData, const std::string& audioFormat) {
  std::vector<float> result;

  if (audioFormat == "s16le") {
    result.reserve(audioData.size() / 2);
    for (size_t i = 0; i + 1 < audioData.size(); i += 2) {
      int16_t sample = static_cast<int16_t>(audioData[i]) |
                       (static_cast<int16_t>(audioData[i + 1]) << 8);
      result.push_back(static_cast<float>(sample) / 32768.0f);
    }
  } else if (audioFormat == "f32le") {
    result.reserve(audioData.size() / 4);
    const float* floatData = reinterpret_cast<const float*>(audioData.data());
    result.assign(floatData, floatData + (audioData.size() / 4));
  }

  return result;
}

qvac_lib_inference_addon_cpp::RuntimeStats ParakeetModel::runtimeStats() {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  
  const double audioDurationSec = totalSamples_ > 0 ? (double)totalSamples_ / SAMPLE_RATE : 0.0;
  const int64_t audioDurationMs = static_cast<int64_t>(audioDurationSec * 1000.0);
  const double totalTimeSec = totalWallMs_ / 1000.0;
  const double rtf = audioDurationSec > 0.0 ? (totalTimeSec / audioDurationSec) : 0.0;
  const double tps = totalTimeSec > 0.0 ? ((double)totalTokens_ / totalTimeSec) : 0.0;
  const double msPerToken = totalTokens_ > 0 ? ((double)totalWallMs_ / totalTokens_) : 0.0;
  
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

} // namespace qvac_lib_infer_parakeet
