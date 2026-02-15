#include "SupertonicEngine.hpp"

#include "FileUtils.hpp"
#include "OrtSessionFactory.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <numeric>
#include <random>
#include <stdexcept>

namespace qvac::ttslib::supertonic {

namespace {

constexpr int SAMPLE_RATE = 44100;
constexpr int BASE_CHUNK_SIZE = 512;
constexpr int CHUNK_COMPRESS_FACTOR = 6;
constexpr int LATENT_SIZE = BASE_CHUNK_SIZE * CHUNK_COMPRESS_FACTOR; // 3072
constexpr int LATENT_DIM = 24;
constexpr int STYLE_DIM = 128;
constexpr int LATENT_CHANNELS = LATENT_DIM * CHUNK_COMPRESS_FACTOR; // 144

const std::vector<std::string> LANGUAGES = {"en", "ko", "es", "pt", "fr"};

std::vector<float> loadVoiceBin(const std::string &path) {
  std::ifstream f(path, std::ios::binary);
  if (!f)
    throw std::runtime_error("Cannot open voice file: " + path);
  f.seekg(0, std::ios::end);
  const size_t bytes = static_cast<size_t>(f.tellg());
  f.seekg(0);
  if (bytes % sizeof(float) != 0)
    throw std::runtime_error("Invalid voice file size: " + path);
  std::vector<float> data(bytes / sizeof(float));
  if (!f.read(reinterpret_cast<char *>(data.data()), bytes))
    throw std::runtime_error("Failed to read voice file: " + path);
  return data;
}

std::string resolvePath(const std::string &baseDir, const std::string &rel) {
  if (rel.empty())
    return baseDir;
  if (rel[0] == '/' || rel[0] == '\\' || (rel.size() >= 2 && rel[1] == ':'))
    return rel;
#ifdef _WIN32
  constexpr char sep = '\\';
  const bool trailing = baseDir.back() == '/' || baseDir.back() == '\\';
#else
  constexpr char sep = '/';
  const bool trailing = baseDir.back() == '/';
#endif
  return trailing ? baseDir + rel : baseDir + sep + rel;
}

} // namespace

SupertonicEngine::SupertonicEngine(const SupertonicConfig &cfg) { load(cfg); }

SupertonicEngine::~SupertonicEngine() { unload(); }

void SupertonicEngine::load(const SupertonicConfig &cfg) {
  if (std::find(LANGUAGES.begin(), LANGUAGES.end(), cfg.language) ==
      LANGUAGES.end())
    throw std::invalid_argument("Unsupported language: " + cfg.language);

  config_ = cfg;

  const std::string tokenizerPath = cfg.tokenizerPath.empty()
                                        ? resolvePath(cfg.modelDir, "tokenizer.json")
                                        : cfg.tokenizerPath;
  const std::string blob = qvac::ttslib::loadFileBytes(tokenizerPath);
  tokenizerHandle_ = tokenizers_new_from_str(blob.data(), blob.length());
  if (!tokenizerHandle_)
    throw std::runtime_error("Failed to load tokenizer: " + tokenizerPath);

  const std::string onnxDir = resolvePath(cfg.modelDir, "onnx");
  const std::string textEncoderPath =
      cfg.textEncoderPath.empty()
          ? resolvePath(onnxDir, "text_encoder.onnx")
          : cfg.textEncoderPath;
  const std::string latentDenoiserPath =
      cfg.latentDenoiserPath.empty()
          ? resolvePath(onnxDir, "latent_denoiser.onnx")
          : cfg.latentDenoiserPath;
  const std::string voiceDecoderPath =
      cfg.voiceDecoderPath.empty()
          ? resolvePath(onnxDir, "voice_decoder.onnx")
          : cfg.voiceDecoderPath;

  Ort::SessionOptions options;
  options.SetIntraOpNumThreads(1);
  options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

  textEncoderSession_ = qvac::ttslib::createOrtSession(textEncoderPath, options);
  {
    Ort::AllocatorWithDefaultOptions alloc;
    const size_t numOut = textEncoderSession_->GetOutputCount();
    if (numOut < 2)
      throw std::runtime_error("Text encoder must have at least 2 outputs");
    textEncoderOutputNames_.clear();
    for (size_t i = 0; i < 2; ++i) {
      auto name = textEncoderSession_->GetOutputNameAllocated(i, alloc);
      textEncoderOutputNames_.push_back(name.get());
    }
  }
  latentDenoiserSession_ = qvac::ttslib::createOrtSession(latentDenoiserPath, options);
  voiceDecoderSession_ = qvac::ttslib::createOrtSession(voiceDecoderPath, options);

  const std::string voicePath =
      resolvePath(cfg.voicesDir.empty() ? resolvePath(cfg.modelDir, "voices")
                                        : cfg.voicesDir,
                  cfg.voiceName + ".bin");
  loadVoiceStyle(voicePath);

  loaded_ = true;
}

void SupertonicEngine::unload() {
  loaded_ = false;
  config_ = {};
  styleData_.clear();
  styleNumFrames_ = 0;
  textEncoderOutputNames_.clear();
  textEncoderSession_.reset();
  latentDenoiserSession_.reset();
  voiceDecoderSession_.reset();
  if (tokenizerHandle_) {
    tokenizers_free(tokenizerHandle_);
    tokenizerHandle_ = nullptr;
  }
}

bool SupertonicEngine::isLoaded() const { return loaded_; }

void SupertonicEngine::tokenize(const std::string &text,
                                std::vector<int64_t> &inputIds,
                                std::vector<int64_t> &attentionMask) {
  const std::string prepped = text + " ";
  TokenizerEncodeResult result;
  tokenizers_encode(tokenizerHandle_, prepped.data(), prepped.size(), 1,
                    &result);
  inputIds.assign(result.token_ids, result.token_ids + result.len);
  tokenizers_free_encode_results(&result, 1);
  attentionMask.assign(inputIds.size(), 1);
}

void SupertonicEngine::loadVoiceStyle(const std::string &voicePath) {
  styleData_ = loadVoiceBin(voicePath);
  const size_t numFloats = styleData_.size();
  if (numFloats % STYLE_DIM != 0)
    throw std::runtime_error("Invalid voice file shape: " + voicePath);
  styleNumFrames_ = static_cast<int64_t>(numFloats / STYLE_DIM);
}

AudioResult SupertonicEngine::synthesize(const std::string &text) {
  if (!loaded_)
    throw std::runtime_error("SupertonicEngine not loaded");

  std::vector<int64_t> inputIds, attentionMask;
  tokenize(text, inputIds, attentionMask);
  if (inputIds.empty())
    throw std::runtime_error("Tokenization produced no tokens");

  const int64_t seqLen = static_cast<int64_t>(inputIds.size());
  Ort::AllocatorWithDefaultOptions allocator;
  Ort::MemoryInfo memoryInfo = Ort::MemoryInfo::CreateCpu(
      OrtArenaAllocator, OrtMemTypeDefault);

  // 1) Text encoder: input_ids (1, seqLen), attention_mask (1, seqLen), style (1, styleNumFrames_, 128)
  std::vector<int64_t> inputIdsShape = {1, seqLen};
  std::vector<int64_t> attentionMaskShape = {1, seqLen};
  std::vector<int64_t> styleShape = {1, styleNumFrames_, STYLE_DIM};

  std::vector<Ort::Value> textEncInputs;
  textEncInputs.push_back(Ort::Value::CreateTensor<int64_t>(
      memoryInfo, inputIds.data(), inputIds.size(), inputIdsShape.data(),
      inputIdsShape.size()));
  textEncInputs.push_back(Ort::Value::CreateTensor<int64_t>(
      memoryInfo, attentionMask.data(), attentionMask.size(),
      attentionMaskShape.data(), attentionMaskShape.size()));
  textEncInputs.push_back(Ort::Value::CreateTensor<float>(
      memoryInfo, styleData_.data(), styleData_.size(), styleShape.data(),
      styleShape.size()));

  const char *textEncInputNames[] = {"input_ids", "attention_mask", "style"};
  const char *textEncOutputNames[] = {textEncoderOutputNames_[0].c_str(),
                                      textEncoderOutputNames_[1].c_str()};

  auto textEncOutputs = textEncoderSession_->Run(
      Ort::RunOptions{nullptr}, textEncInputNames, textEncInputs.data(),
      textEncInputs.size(), textEncOutputNames, 2);

  const auto &rawDurationsInfo =
      textEncOutputs[1].GetTensorTypeAndShapeInfo();
  const float *rawDurationsPtr =
      textEncOutputs[1].GetTensorData<float>();
  const int64_t numDurations = rawDurationsInfo.GetElementCount();

  std::vector<int64_t> durations(numDurations);
  for (int64_t i = 0; i < numDurations; ++i)
    durations[i] = static_cast<int64_t>(
        std::max(0.0f, rawDurationsPtr[i] / config_.speed * SAMPLE_RATE));

  const int64_t totalDuration = std::accumulate(durations.begin(), durations.end(), int64_t(0));
  const int64_t latentLength =
      (totalDuration + LATENT_SIZE - 1) / LATENT_SIZE;
  if (latentLength <= 0) {
    AudioResult empty;
    empty.sampleRate = SAMPLE_RATE;
    empty.channels = 1;
    return empty;
  }

  std::vector<float> encoderOutputs(
      textEncOutputs[0].GetTensorData<float>(),
      textEncOutputs[0].GetTensorData<float>() +
          textEncOutputs[0].GetTensorTypeAndShapeInfo().GetElementCount());

  std::vector<float> latents;
  int64_t actualLatentLen;
  std::tie(latents, actualLatentLen) =
      runLatentDenoiserLoop(encoderOutputs, attentionMask, durations);

  std::vector<float> waveform =
      runVoiceDecoder(latents, actualLatentLen);
  const size_t numSamples =
      static_cast<size_t>(actualLatentLen * LATENT_SIZE);
  if (waveform.size() > numSamples)
    waveform.resize(numSamples);

  AudioResult result;
  result.sampleRate = SAMPLE_RATE;
  result.channels = 1;
  result.pcm16.reserve(waveform.size());
  result.durationMs = waveform.size() * 1000.0 / SAMPLE_RATE;
  result.samples = waveform.size();
  for (float s : waveform) {
    const float clamped = std::clamp(s, -1.0f, 1.0f);
    result.pcm16.push_back(static_cast<int16_t>(clamped * 32767.0f));
  }
  return result;
}

std::pair<std::vector<float>, int64_t>
SupertonicEngine::runLatentDenoiserLoop(
    const std::vector<float> &encoderOutputs,
    const std::vector<int64_t> &attentionMask,
    const std::vector<int64_t> &durations) {
  Ort::MemoryInfo memoryInfo = Ort::MemoryInfo::CreateCpu(
      OrtArenaAllocator, OrtMemTypeDefault);

  const int64_t totalDuration =
      std::accumulate(durations.begin(), durations.end(), int64_t(0));
  const int64_t latentLen =
      (totalDuration + LATENT_SIZE - 1) / LATENT_SIZE;

  std::vector<int64_t> latentMask(latentLen, 1);
  std::vector<float> noisyLatents(
      static_cast<size_t>(LATENT_CHANNELS * latentLen));
  std::default_random_engine rng(42);
  std::normal_distribution<float> dist(0.0f, 1.0f);
  for (float &v : noisyLatents)
    v = dist(rng);

  const int64_t seqLen = static_cast<int64_t>(attentionMask.size());
  std::vector<int64_t> encoderShape = {1, seqLen,
                                       static_cast<int64_t>(encoderOutputs.size() / seqLen)};
  std::vector<int64_t> styleShape = {1, styleNumFrames_, STYLE_DIM};
  std::vector<int64_t> latentMaskShape = {1, latentLen};
  std::vector<int64_t> noisyLatentsShape = {1, LATENT_CHANNELS, latentLen};

  std::vector<float> latents = noisyLatents;
  const int steps = config_.numInferenceSteps;

  for (int step = 0; step < steps; ++step) {
    std::vector<Ort::Value> inputs;
    inputs.push_back(Ort::Value::CreateTensor<float>(
        memoryInfo, latents.data(), latents.size(),
        noisyLatentsShape.data(), noisyLatentsShape.size()));
    inputs.push_back(Ort::Value::CreateTensor<int64_t>(
        memoryInfo, latentMask.data(), latentMask.size(),
        latentMaskShape.data(), latentMaskShape.size()));
    inputs.push_back(Ort::Value::CreateTensor<float>(
        memoryInfo, styleData_.data(), styleData_.size(), styleShape.data(),
        styleShape.size()));
    inputs.push_back(Ort::Value::CreateTensor<float>(
        memoryInfo, const_cast<float *>(encoderOutputs.data()),
        encoderOutputs.size(), encoderShape.data(), encoderShape.size()));
    inputs.push_back(Ort::Value::CreateTensor<int64_t>(
        memoryInfo, const_cast<int64_t *>(attentionMask.data()),
        attentionMask.size(), std::vector<int64_t>{1, seqLen}.data(), 2));

    const float timestep = static_cast<float>(step);
    const float numSteps = static_cast<float>(steps);
    inputs.push_back(Ort::Value::CreateTensor<float>(
        memoryInfo, const_cast<float *>(&timestep), 1,
        std::vector<int64_t>{1}.data(), 1));
    inputs.push_back(Ort::Value::CreateTensor<float>(
        memoryInfo, const_cast<float *>(&numSteps), 1,
        std::vector<int64_t>{1}.data(), 1));

    const char *inputNames[] = {
        "noisy_latents", "latent_mask", "style", "encoder_outputs",
        "attention_mask", "timestep", "num_inference_steps"};
    Ort::AllocatorWithDefaultOptions alloc;
    auto outName = latentDenoiserSession_->GetOutputNameAllocated(0, alloc);
    const char *outputNames[] = {outName.get()};

    auto outputs = latentDenoiserSession_->Run(
        Ort::RunOptions{nullptr}, inputNames, inputs.data(), inputs.size(),
        outputNames, 1);
    const float *outData = outputs[0].GetTensorData<float>();
    const size_t outCount =
        outputs[0].GetTensorTypeAndShapeInfo().GetElementCount();
    latents.assign(outData, outData + outCount);
  }

  return {latents, latentLen};
}

std::vector<float> SupertonicEngine::runVoiceDecoder(
    const std::vector<float> &latents, int64_t latentLength) {
  Ort::MemoryInfo memoryInfo = Ort::MemoryInfo::CreateCpu(
      OrtArenaAllocator, OrtMemTypeDefault);

  std::vector<int64_t> latentsShape = {1, LATENT_CHANNELS, latentLength};
  std::vector<Ort::Value> inputs;
  inputs.push_back(Ort::Value::CreateTensor<float>(
      memoryInfo, const_cast<float *>(latents.data()), latents.size(),
      latentsShape.data(), latentsShape.size()));

  const char *inputNames[] = {"latents"};
  Ort::AllocatorWithDefaultOptions alloc;
  auto outName = voiceDecoderSession_->GetOutputNameAllocated(0, alloc);
  const char *outputNames[] = {outName.get()};

  auto outputs = voiceDecoderSession_->Run(
      Ort::RunOptions{nullptr}, inputNames, inputs.data(), inputs.size(),
      outputNames, 1);
  const float *outData = outputs[0].GetTensorData<float>();
  const size_t outCount =
      outputs[0].GetTensorTypeAndShapeInfo().GetElementCount();
  return std::vector<float>(outData, outData + outCount);
}

} // namespace qvac::ttslib::supertonic
