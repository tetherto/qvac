#include "ChatterboxEngine.hpp"
#include "FileUtils.hpp"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <numeric>

namespace {

// parameters
const float REPETITION_PENALTY = 1.2;
const int MAX_NEW_TOKENS_ENGLISH = 1024;
const int MAX_NEW_TOKENS_MULTILINGUAL = 256;
const float EXAGGERATION = 0.5;

// constants
const std::vector<std::string> SUPPORTED_LANGUAGES = {
    "en", // English
    "es", // Spanish
    "fr", // French
    "de", // German
    "it", // Italian
    "pt", // Portuguese
    "ru", // Russian
};

const std::pair<int, int> UNSUPPORTED_TOKEN_RANGE = {2351, 2453};
const int UNKNOWN_TOKEN_ID = 605; // [UH]
const int64_t NUM_HIDDEN_LAYERS = 30;
const int64_t NUM_KV_HEADS = 16;
const int64_t HEAD_DIM = 64;
const int64_t START_SPEECH_TOKEN = 6561;
const int64_t STOP_SPEECH_TOKEN = 6562;
const int64_t SILENCE_TOKEN = 4299;
const int SAMPLE_RATE = 24000;
const int OFFSET = 3;
const int OFFSET_MULTILINGUAL = 2;

void validateConfigs(const qvac::ttslib::chatterbox::ChatterboxConfig &cfg) {
  if (std::find(SUPPORTED_LANGUAGES.begin(), SUPPORTED_LANGUAGES.end(),
                cfg.language) == SUPPORTED_LANGUAGES.end()) {
    throw std::invalid_argument("Unsupported language: " + cfg.language);
  }
}

void penalizeRepetitionLogits(std::vector<float> &logits,
                              const std::vector<int64_t> &inputIds) {
  for (auto id : inputIds) {
    if (logits[id] < 0) {
      logits[id] *= REPETITION_PENALTY;
    } else {
      logits[id] /= REPETITION_PENALTY;
    }
  }
}

std::string prepareText(const std::string& text, const std::string& language) {
  if (language == "en") {
    return text;
  }
  return "[" + language + "]" + text;
}

int64_t getNumElements(const qvac::ttslib::chatterbox::OrtTensor &tensor) {
  if (tensor.shape.empty()) {
    return 0;
  }

  int64_t numElements = 1;
  for (const auto &shape : tensor.shape) {
    numElements *= shape;
  }
  return numElements;
}

float fp16ToFp32(uint16_t h) {
  uint32_t sign = (h & 0x8000u) << 16u;
  uint32_t exponent = (h >> 10u) & 0x1Fu;
  uint32_t mantissa = h & 0x03FFu;

  if (exponent == 0) {
    if (mantissa == 0) {
      float f;
      std::memcpy(&f, &sign, sizeof(f));
      return f;
    }
    exponent = 1;
    while (!(mantissa & 0x0400u)) {
      mantissa <<= 1u;
      exponent--;
    }
    mantissa &= 0x03FFu;
    exponent = exponent + (127 - 15);
    uint32_t result = sign | (exponent << 23u) | (mantissa << 13u);
    float f;
    std::memcpy(&f, &result, sizeof(f));
    return f;
  }

  if (exponent == 31) {
    uint32_t result = sign | 0x7F800000u | (mantissa << 13u);
    float f;
    std::memcpy(&f, &result, sizeof(f));
    return f;
  }

  exponent = exponent + (127 - 15);
  uint32_t result = sign | (exponent << 23u) | (mantissa << 13u);
  float f;
  std::memcpy(&f, &result, sizeof(f));
  return f;
}

uint16_t fp32ToFp16(float f) {
  uint32_t x;
  std::memcpy(&x, &f, sizeof(x));

  uint16_t sign = (x >> 16u) & 0x8000u;
  int32_t exponent = static_cast<int32_t>((x >> 23u) & 0xFFu) - 127 + 15;
  uint32_t mantissa = x & 0x007FFFFFu;

  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x00800000u) >> (1 - exponent);
    return sign | static_cast<uint16_t>(mantissa >> 13u);
  }

  if (exponent == 0xFF - (127 - 15)) {
    if (mantissa == 0) return sign | 0x7C00u;
    return sign | 0x7C00u | static_cast<uint16_t>(mantissa >> 13u);
  }

  if (exponent > 30) return sign | 0x7C00u;
  return sign | static_cast<uint16_t>(exponent << 10u) | static_cast<uint16_t>(mantissa >> 13u);
}

bool isFp16(const qvac::ttslib::chatterbox::OrtTensor &tensor) {
  return tensor.type == qvac::ttslib::chatterbox::OrtElementType::Fp16;
}

void readTensorToFloatVector(
    const qvac::ttslib::chatterbox::OrtTensor &tensor,
    std::vector<float> &dest,
    typename std::vector<float>::iterator destStart) {
  const int64_t numElements = getNumElements(tensor);
  if (isFp16(tensor)) {
    const auto *src = static_cast<const uint16_t *>(tensor.data);
    std::vector<float> converted(numElements);
    for (int64_t i = 0; i < numElements; i++) {
      converted[i] = fp16ToFp32(src[i]);
    }
    dest.insert(destStart, converted.begin(), converted.end());
  } else {
    const auto *src = static_cast<const float *>(tensor.data);
    dest.insert(destStart, src, src + numElements);
  }
}

void readTensorToFloatBuffer(
    const qvac::ttslib::chatterbox::OrtTensor &tensor,
    float *dest, int64_t offset, int64_t count) {
  if (isFp16(tensor)) {
    const auto *src = static_cast<const uint16_t *>(tensor.data) + offset;
    for (int64_t i = 0; i < count; i++) {
      dest[i] = fp16ToFp32(src[i]);
    }
  } else {
    const auto *src = static_cast<const float *>(tensor.data) + offset;
    std::memcpy(dest, src, count * sizeof(float));
  }
}

void writeFloatDataToTensor(
    const qvac::ttslib::chatterbox::OrtTensor &tensor,
    const float *src, size_t numElements) {
  if (isFp16(tensor)) {
    auto *dest = static_cast<uint16_t *>(tensor.data);
    for (size_t i = 0; i < numElements; i++) {
      dest[i] = fp32ToFp16(src[i]);
    }
  } else {
    std::memcpy(tensor.data, src, numElements * sizeof(float));
  }
}

template <typename T>
void insertFromOrtTensorToVector(
    const qvac::ttslib::chatterbox::OrtTensor &tensor, std::vector<T> &dest,
    typename std::vector<T>::iterator destStart) {
  dest.insert(destStart, static_cast<T *>(tensor.data),
              static_cast<T *>(tensor.data) + getNumElements(tensor));
}

template <typename T> size_t argmax(const std::vector<T> &vector) {
  auto maxIt = std::max_element(vector.begin(), vector.end());
  return std::distance(vector.begin(), maxIt);
}

template <typename T> void printVector(const std::vector<T> &vector) {
  for (auto el : vector) {
    std::cout << el << " ";
  }
  std::cout << std::endl;
}

} // namespace

namespace qvac::ttslib::chatterbox {

ChatterboxEngine::ChatterboxEngine(const ChatterboxConfig &cfg) { load(cfg); }

ChatterboxEngine::~ChatterboxEngine() { unload(); }

void ChatterboxEngine::load(const ChatterboxConfig &cfg) {
  validateConfigs(cfg);

  config_ = cfg;
  language_ = cfg.language;
  lazySessionLoading_ = cfg.lazySessionLoading;

  const std::string blob = qvac::ttslib::loadFileBytes(cfg.tokenizerPath);
  tokenizerHandle_ = tokenizers_new_from_str(blob.data(), blob.length());

  if (!lazySessionLoading_) {
    speechEncoderSession_ = std::make_unique<OnnxInferSession>(cfg.speechEncoderPath);
    embedTokensSession_ = std::make_unique<OnnxInferSession>(cfg.embedTokensPath);
    conditionalDecoderSession_ = std::make_unique<OnnxInferSession>(cfg.conditionalDecoderPath);
    languageModelSession_ = std::make_unique<OnnxInferSession>(cfg.languageModelPath);
  }

  isEnglish_ = language_ == "en";
  loaded_ = true;
  std::cout << "Language: " << language_ << std::endl;

  keyValueOffset_ = isEnglish_ ? OFFSET : OFFSET_MULTILINGUAL;
}

void ChatterboxEngine::ensureSession(std::unique_ptr<OnnxInferSession> &session, const std::string &modelPath) {
  if (!session) {
    session = std::make_unique<OnnxInferSession>(modelPath);
  }
}

void ChatterboxEngine::releaseSession(std::unique_ptr<OnnxInferSession> &session) {
  if (lazySessionLoading_) {
    session.reset();
  }
}

void ChatterboxEngine::unload() {
  config_ = {};
  language_ = "";
  loaded_ = false;
  speechEncoderSession_.reset();
  embedTokensSession_.reset();
  conditionalDecoderSession_.reset();
  languageModelSession_.reset();

  if (tokenizerHandle_ != nullptr) {
    tokenizers_free(tokenizerHandle_);
    tokenizerHandle_ = nullptr;
  }
}

bool ChatterboxEngine::isLoaded() const { return loaded_; }

void ChatterboxEngine::sanitizeTokenIds(std::vector<int64_t> &inputIds) {
  std::replace_if(inputIds.begin(), inputIds.end(),
    [](int64_t id) {
      return id > UNSUPPORTED_TOKEN_RANGE.first && id <= UNSUPPORTED_TOKEN_RANGE.second;
    },
    UNKNOWN_TOKEN_ID);
}

TensorData<int64_t> ChatterboxEngine::buildInitialPositionIds(const std::vector<int64_t> &inputIds) {
  TensorData<int64_t> positionIds;
  positionIds.data.reserve(inputIds.size());
  for (int i = 0; i < static_cast<int>(inputIds.size()); i++) {
    positionIds.data.push_back(inputIds[i] >= START_SPEECH_TOKEN ? 0 : i - 1);
  }
  positionIds.shape = {1, static_cast<int64_t>(positionIds.data.size())};
  return positionIds;
}

TensorData<float> ChatterboxEngine::extractEmbeddings(
    const std::vector<int64_t> &inputIds,
    const std::vector<int64_t> &positionIds) {
  runEmbedTokensInfer(inputIds, positionIds);
  OrtTensor tensor = embedTokensSession_->getOutput("inputs_embeds");
  TensorData<float> embeddings;
  embeddings.shape = tensor.shape;
  readTensorToFloatVector(tensor, embeddings.data, embeddings.data.begin());
  return embeddings;
}

void ChatterboxEngine::processSpeechEncoderOutputs(
    TensorData<float> &inputsEmbs,
    TensorData<int64_t> &promptToken,
    TensorData<float> &speakerEmbeddings,
    TensorData<float> &speakerFeatures,
    TensorData<int64_t> &positionIds,
    TensorData<int64_t> &attentionMask,
    std::unordered_map<std::string, TensorData<float>> &pastKeyValues) {

  std::cout << "SpeechEncoderInfer stared ... " << std::endl;
  runSpeechEncoderInfer();
  std::cout << "SpeechEncoderInfer finished" << std::endl;

  OrtTensor condEmbTensor = speechEncoderSession_->getOutput("audio_features");
  OrtTensor promptTokenTensor = speechEncoderSession_->getOutput("audio_tokens");
  OrtTensor speakerEmbeddingsTensor = speechEncoderSession_->getOutput("speaker_embeddings");
  OrtTensor speakerFeaturesTensor = speechEncoderSession_->getOutput("speaker_features");

  insertFromOrtTensorToVector(promptTokenTensor, promptToken.data, promptToken.data.begin());
  readTensorToFloatVector(speakerEmbeddingsTensor, speakerEmbeddings.data, speakerEmbeddings.data.begin());
  readTensorToFloatVector(speakerFeaturesTensor, speakerFeatures.data, speakerFeatures.data.begin());
  readTensorToFloatVector(condEmbTensor, inputsEmbs.data, inputsEmbs.data.begin());

  promptToken.shape = promptTokenTensor.shape;
  speakerEmbeddings.shape = speakerEmbeddingsTensor.shape;
  speakerFeatures.shape = speakerFeaturesTensor.shape;
  inputsEmbs.shape[1] += condEmbTensor.shape[1];

  releaseSession(speechEncoderSession_);

  const int64_t seqLen = inputsEmbs.shape[1];
  attentionMask.data.resize(seqLen, 1);
  attentionMask.shape = {1, seqLen};

  if (isEnglish_) {
    positionIds.data.resize(seqLen);
    positionIds.shape = {1, seqLen};
    std::iota(positionIds.data.begin(), positionIds.data.end(), 0);
  }

  for (size_t i = keyValueOffset_; i < languageModelSession_->getInputNames().size(); i++) {
    TensorData<float> pastKeyValue;
    pastKeyValue.shape = {1, NUM_KV_HEADS, 0, HEAD_DIM};
    pastKeyValues[languageModelSession_->getInputNames()[i]] = pastKeyValue;
  }
}

int64_t ChatterboxEngine::selectNextToken(
    const OrtTensor &logitsTensor,
    std::vector<int64_t> &generatedTokens) {
  std::vector<float> logits;
  logits.resize(logitsTensor.shape[2]);
  const int64_t logitsOffset = (logitsTensor.shape[1] - 1) * logitsTensor.shape[2];
  readTensorToFloatBuffer(logitsTensor, logits.data(), logitsOffset, logitsTensor.shape[2]);

  penalizeRepetitionLogits(logits, generatedTokens);
  return static_cast<int64_t>(argmax(logits));
}

void ChatterboxEngine::advancePositionIds(TensorData<int64_t> &positionIds, size_t iteration) {
  if (isEnglish_) {
    positionIds.data = {positionIds.data.back() + 1};
    positionIds.shape[1] = 1;
  } else {
    positionIds.data = {static_cast<int64_t>(iteration + 1)};
    positionIds.shape = {1, 1};
  }
}

void ChatterboxEngine::cachePastKeyValues(
    std::unordered_map<std::string, TensorData<float>> &pastKeyValues) {
  for (size_t i = keyValueOffset_; i < languageModelSession_->getInputNames().size(); i++) {
    const std::string inputName = languageModelSession_->getInputNames()[i];
    const std::string outputName = languageModelSession_->getOutputNames()[i - keyValueOffset_ + 1];
    OrtTensor outputTensor = languageModelSession_->getOutput(outputName);

    const int64_t numElements = getNumElements(outputTensor);
    pastKeyValues[inputName].shape = outputTensor.shape;
    pastKeyValues[inputName].data.resize(numElements);

    readTensorToFloatBuffer(outputTensor, pastKeyValues[inputName].data.data(), 0, numElements);
  }
}

std::vector<int64_t> ChatterboxEngine::generateSpeechTokens(
    std::vector<int64_t> &inputIds,
    TensorData<int64_t> &positionIds,
    TensorData<float> &speakerEmbeddings,
    TensorData<float> &speakerFeatures) {

  TensorData<int64_t> promptToken;
  TensorData<int64_t> attentionMask;
  std::unordered_map<std::string, TensorData<float>> pastKeyValues;
  std::vector<int64_t> generatedTokens{START_SPEECH_TOKEN};

  const size_t maxNewTokens = isEnglish_ ? MAX_NEW_TOKENS_ENGLISH : MAX_NEW_TOKENS_MULTILINGUAL;

  for (size_t i = 0; i < maxNewTokens; i++) {
    TensorData<float> inputsEmbs = extractEmbeddings(inputIds, positionIds.data);

    if (i == 0) {
      processSpeechEncoderOutputs(inputsEmbs, promptToken, speakerEmbeddings,
                                   speakerFeatures, positionIds, attentionMask, pastKeyValues);
    }

    runLanguageModelInfer(inputsEmbs, positionIds, attentionMask, pastKeyValues);

    OrtTensor logitsTensor = languageModelSession_->getOutput("logits");
    const int64_t nextToken = selectNextToken(logitsTensor, generatedTokens);
    generatedTokens.push_back(nextToken);
    inputIds = {nextToken};

    if (nextToken == STOP_SPEECH_TOKEN) {
      std::cout << "STOP_SPEECH_TOKEN reached: stopping generation" << std::endl;
      break;
    }

    attentionMask.data.push_back(1);
    attentionMask.shape[1]++;
    advancePositionIds(positionIds, i);
    cachePastKeyValues(pastKeyValues);
  }

  releaseSession(embedTokensSession_);
  releaseSession(languageModelSession_);

  return assembleSpeechTokenSequence(promptToken, generatedTokens);
}

std::vector<int64_t> ChatterboxEngine::assembleSpeechTokenSequence(
    const TensorData<int64_t> &promptToken,
    const std::vector<int64_t> &generatedTokens) {
  std::vector<int64_t> speechTokens(promptToken.data.begin(), promptToken.data.end());
  speechTokens.insert(speechTokens.end(), generatedTokens.begin() + 1, generatedTokens.end() - 1);

  if (isEnglish_) {
    const std::vector<int64_t> silenceTokens(3, SILENCE_TOKEN);
    speechTokens.insert(speechTokens.end(), silenceTokens.begin(), silenceTokens.end());
  }

  return speechTokens;
}

std::vector<float> ChatterboxEngine::synthesizeWaveform(
    const std::vector<int64_t> &speechTokens,
    const TensorData<float> &speakerEmbeddings,
    const TensorData<float> &speakerFeatures) {
  ensureSession(conditionalDecoderSession_, config_.conditionalDecoderPath);

  std::cout << "ConditionalDecoderInfer started ... " << std::endl;
  runConditionalDecoderInfer(speechTokens, speakerEmbeddings, speakerFeatures);
  std::cout << "ConditionalDecoderInfer finished" << std::endl;

  OrtTensor wavTensor = conditionalDecoderSession_->getOutput("waveform");
  std::vector<float> wav;
  readTensorToFloatVector(wavTensor, wav, wav.begin());

  releaseSession(conditionalDecoderSession_);
  return wav;
}

AudioResult ChatterboxEngine::convertToAudioResult(const std::vector<float> &wav) {
  std::cout << "Generated audio size: " << wav.size() / 24000.0 << " seconds" << std::endl;

  AudioResult result;
  result.sampleRate = SAMPLE_RATE;
  result.channels = 1;
  result.pcm16.reserve(wav.size());
  result.durationMs = wav.size() * 1000 / SAMPLE_RATE;
  result.samples = wav.size();

  std::transform(wav.begin(), wav.end(), std::back_inserter(result.pcm16),
                 [](const float sample) {
                   const float clamped = std::clamp(sample, -1.0f, 1.0f);
                   return static_cast<int16_t>(clamped * 32767.0f);
                 });

  return result;
}

AudioResult ChatterboxEngine::synthesize(const std::string &text) {
  std::vector<int64_t> inputIds = tokenize(text);
  TensorData<int64_t> positionIds;
  TensorData<float> speakerEmbeddings;
  TensorData<float> speakerFeatures;

  if (!isEnglish_) {
    sanitizeTokenIds(inputIds);
    positionIds = buildInitialPositionIds(inputIds);
  }

  ensureSession(embedTokensSession_, config_.embedTokensPath);
  ensureSession(speechEncoderSession_, config_.speechEncoderPath);
  ensureSession(languageModelSession_, config_.languageModelPath);

  std::cout << "Sampling ... " << text << std::endl;

  std::vector<int64_t> speechTokens = generateSpeechTokens(
      inputIds, positionIds, speakerEmbeddings, speakerFeatures);

  std::vector<float> wav = synthesizeWaveform(speechTokens, speakerEmbeddings, speakerFeatures);

  return convertToAudioResult(wav);
}

std::vector<int64_t> ChatterboxEngine::tokenize(const std::string &text) {
  const std::string preparedText = prepareText(text, language_);
  std::cout << "tokenizing text: " << preparedText << std::endl;
  
  TokenizerEncodeResult result;
  tokenizers_encode(tokenizerHandle_, preparedText.data(), preparedText.length(), 1, &result);

  const std::vector<int64_t> tokens(result.token_ids, result.token_ids + result.len);
  tokenizers_free_encode_results(&result, 1);

  return tokens;
}

void ChatterboxEngine::runEmbedTokensInfer(
  const std::vector<int64_t> &inputIds, const std::vector<int64_t> &positionIds) {
  
  std::vector<std::vector<int64_t>> inputShapes = {
      {1, static_cast<int64_t>(inputIds.size())},
  };
  
  if (!isEnglish_) {
    inputShapes.push_back({1, static_cast<int64_t>(positionIds.size())});
    inputShapes.push_back({1});
  }

  embedTokensSession_->initInputTensors(inputShapes);

  // fill inputs
  OrtTensor inputIdsTensor = embedTokensSession_->getInput("input_ids");
  std::memcpy(inputIdsTensor.data, inputIds.data(), inputIds.size() * sizeof(int64_t));
  
  if (!isEnglish_) {
    OrtTensor positionIdsTensor = embedTokensSession_->getInput("position_ids");
    std::memcpy(positionIdsTensor.data, positionIds.data(), positionIds.size() * sizeof(int64_t));

    OrtTensor exaggerationTensor = embedTokensSession_->getInput("exaggeration");
    writeFloatDataToTensor(exaggerationTensor, &EXAGGERATION, 1);
  }

  embedTokensSession_->run();
}

void ChatterboxEngine::runSpeechEncoderInfer() {
  const std::vector<std::vector<int64_t>> inputShapes = {
      {1, static_cast<int64_t>(config_.referenceAudio.size())}
  };
  speechEncoderSession_->initInputTensors(inputShapes);

  // fill inputs
  OrtTensor audioValuesTensor = speechEncoderSession_->getInput("audio_values");
  writeFloatDataToTensor(audioValuesTensor, config_.referenceAudio.data(), config_.referenceAudio.size());

  speechEncoderSession_->run();
}

void ChatterboxEngine::runLanguageModelInfer(
    const TensorData<float> &inputsEmbs, const TensorData<int64_t> &positionIds,
    const TensorData<int64_t> &attentionMask,
    std::unordered_map<std::string, TensorData<float>> &pastKeyValues) {

  std::vector<std::vector<int64_t>> inputShapes = {
    inputsEmbs.shape,
    attentionMask.shape,
  };

  if (isEnglish_) {
    inputShapes.push_back(positionIds.shape);
  }

  for (size_t i = keyValueOffset_; i < languageModelSession_->getInputNames().size(); i++) {
    inputShapes.push_back(pastKeyValues[languageModelSession_->getInputNames()[i]].shape);
  }

  languageModelSession_->initInputTensors(inputShapes);

  // fill inputs
  OrtTensor inputsEmbsTensor = languageModelSession_->getInput("inputs_embeds");
  writeFloatDataToTensor(inputsEmbsTensor, inputsEmbs.data.data(), inputsEmbs.data.size());

  OrtTensor attentionMaskTensor = languageModelSession_->getInput("attention_mask");
  std::memcpy(attentionMaskTensor.data, attentionMask.data.data(), attentionMask.data.size() * sizeof(int64_t));

  if (isEnglish_) {
    OrtTensor positionIdsTensor = languageModelSession_->getInput("position_ids");
    std::memcpy(positionIdsTensor.data, positionIds.data.data(), positionIds.data.size() * sizeof(int64_t));
  }

  for (size_t i = keyValueOffset_; i < languageModelSession_->getInputNames().size(); i++) {
    OrtTensor pastKeyValueTensor = languageModelSession_->getInput(languageModelSession_->getInputNames()[i]);
    const auto &kvData = pastKeyValues[languageModelSession_->getInputNames()[i]].data;
    writeFloatDataToTensor(pastKeyValueTensor, kvData.data(), kvData.size());
  }

  languageModelSession_->run();
}

void ChatterboxEngine::runConditionalDecoderInfer(
    const std::vector<int64_t> &speechTokens,
    const TensorData<float> &speakerEmbeddings,
    const TensorData<float> &speakerFeatures) {

  const std::vector<std::vector<int64_t>> inputShapes = {
      {1, static_cast<int64_t>(speechTokens.size())},
      speakerEmbeddings.shape,
      speakerFeatures.shape,
  };

  conditionalDecoderSession_->initInputTensors(inputShapes);

  // fill inputs
  OrtTensor speechTokensTensor =
      conditionalDecoderSession_->getInput("speech_tokens");
  std::memcpy(speechTokensTensor.data, speechTokens.data(),
              speechTokens.size() * sizeof(int64_t));

  OrtTensor speakerEmbeddingsTensor =
      conditionalDecoderSession_->getInput("speaker_embeddings");
  writeFloatDataToTensor(speakerEmbeddingsTensor, speakerEmbeddings.data.data(), speakerEmbeddings.data.size());

  OrtTensor speakerFeaturesTensor =
      conditionalDecoderSession_->getInput("speaker_features");
  writeFloatDataToTensor(speakerFeaturesTensor, speakerFeatures.data.data(), speakerFeatures.data.size());

  conditionalDecoderSession_->run();
}

} // namespace qvac::ttslib::chatterbox
