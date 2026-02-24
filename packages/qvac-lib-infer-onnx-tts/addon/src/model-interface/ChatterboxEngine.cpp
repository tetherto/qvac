#include "ChatterboxEngine.hpp"
#include "FileUtils.hpp"

#include <algorithm>
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

template <typename T>
void copyFromTensor(const qvac::ttslib::chatterbox::OrtTensor &tensor,
                    T *dest) {
  std::memcpy(dest, static_cast<T *>(tensor.data),
              getNumElements(tensor) * sizeof(T));
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

AudioResult ChatterboxEngine::synthesize(const std::string &text) {
  std::vector<int64_t> inputIdsOriginal = tokenize(text);
  std::vector<int64_t> inputIds = inputIdsOriginal;

  TensorData<int64_t> promptToken;
  TensorData<float> speakerEmbeddings;
  TensorData<float> speakerFeatures;

  TensorData<int64_t> positionIds;
  TensorData<int64_t> attentionMask;
  std::unordered_map<std::string, TensorData<float>> pastKeyValues;

  if (!isEnglish_) {
    // Replace out-of-range token IDs with [UH] token
    for (int64_t& id : inputIds) {
      if (id > UNSUPPORTED_TOKEN_RANGE.first && id <= UNSUPPORTED_TOKEN_RANGE.second) {
        id = UNKNOWN_TOKEN_ID;
      }
    }

    positionIds.data.reserve(inputIds.size());
    for (int i = 0; i < static_cast<int>(inputIds.size()); i++) {
      if (inputIds[i] >= START_SPEECH_TOKEN) {
        positionIds.data.push_back(0);
      } else {
        positionIds.data.push_back(i - 1);
      }
    }
    positionIds.shape = {1, static_cast<int64_t>(positionIds.data.size())};
  }

  ensureSession(embedTokensSession_, config_.embedTokensPath);
  ensureSession(speechEncoderSession_, config_.speechEncoderPath);
  ensureSession(languageModelSession_, config_.languageModelPath);

  std::vector<int64_t> generatedTokens{START_SPEECH_TOKEN};

  std::cout << "Sampling ... " << text << std::endl;
  const size_t maxNewTokens = isEnglish_ ? MAX_NEW_TOKENS_ENGLISH : MAX_NEW_TOKENS_MULTILINGUAL;

  for (size_t i = 0; i < maxNewTokens; i++) {
    runEmbedTokensInfer(inputIds, positionIds.data);

    OrtTensor inputsEmbsTensor = embedTokensSession_->getOutput("inputs_embeds");
    TensorData<float> inputsEmbs;
    inputsEmbs.shape = inputsEmbsTensor.shape;
    insertFromOrtTensorToVector(inputsEmbsTensor, inputsEmbs.data, inputsEmbs.data.begin());

    if (i == 0) {
      std::cout << "SpeechEncoderInfer stared ... " << std::endl;
      runSpeechEncoderInfer();
      std::cout << "SpeechEncoderInfer finished" << std::endl;

      OrtTensor condEmbTensor = speechEncoderSession_->getOutput("audio_features");
      OrtTensor promptTokenTensor = speechEncoderSession_->getOutput("audio_tokens");
      OrtTensor speakerEmbeddingsTensor = speechEncoderSession_->getOutput("speaker_embeddings");
      OrtTensor speakerFeaturesTensor = speechEncoderSession_->getOutput("speaker_features");

      insertFromOrtTensorToVector(promptTokenTensor, promptToken.data, promptToken.data.begin());
      insertFromOrtTensorToVector(speakerEmbeddingsTensor, speakerEmbeddings.data, speakerEmbeddings.data.begin());
      insertFromOrtTensorToVector(speakerFeaturesTensor, speakerFeatures.data, speakerFeatures.data.begin());
      insertFromOrtTensorToVector(condEmbTensor, inputsEmbs.data, inputsEmbs.data.begin());

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

        const std::string name = languageModelSession_->getInputNames()[i];
        pastKeyValues[name] = pastKeyValue;
      }
    }

    runLanguageModelInfer(inputsEmbs, positionIds, attentionMask, pastKeyValues);

    OrtTensor logitsTensor = languageModelSession_->getOutput("logits");
    std::vector<float> logits;
    logits.resize(logitsTensor.shape[2]);
    std::memcpy(logits.data(),
                static_cast<float *>(logitsTensor.data) + (logitsTensor.shape[1] - 1) * logitsTensor.shape[2],
                sizeof(float) * logitsTensor.shape[2]);

    penalizeRepetitionLogits(logits, generatedTokens);
    const int64_t nextToken = static_cast<int64_t>(argmax(logits));
    generatedTokens.push_back(nextToken);
    inputIds = {nextToken};

    if (nextToken == STOP_SPEECH_TOKEN) {
      std::cout << "STOP_SPEECH_TOKEN reached: stopping generation" << std::endl;
      break;
    }

    attentionMask.data.push_back(1);
    attentionMask.shape[1]++;

    if (isEnglish_) {
      positionIds.data = {positionIds.data.back() + 1};
      positionIds.shape[1] = 1;
    } else {
      positionIds.data = {static_cast<int64_t>(i + 1)};
      positionIds.shape = {1, 1};
    }

    for (size_t i = keyValueOffset_; i < languageModelSession_->getInputNames().size(); i++) {
      const std::string inputName = languageModelSession_->getInputNames()[i];
      const std::string outputName = languageModelSession_->getOutputNames()[i - keyValueOffset_ + 1];
      OrtTensor outputTensor = languageModelSession_->getOutput(outputName);

      const size_t numElements = getNumElements(outputTensor);
      pastKeyValues[inputName].shape = outputTensor.shape;
      pastKeyValues[inputName].data.resize(numElements);

      std::memcpy(pastKeyValues[inputName].data.data(), outputTensor.data,
                  numElements * sizeof(float));
    }
  }

  releaseSession(embedTokensSession_);
  releaseSession(languageModelSession_);

  std::vector<int64_t> speechTokens(promptToken.data.begin(), promptToken.data.end());
  speechTokens.insert(speechTokens.end(), generatedTokens.begin() + 1, generatedTokens.end() - 1);

  if (isEnglish_) {
    const std::vector<int64_t> silenceTokens(3, SILENCE_TOKEN);
    speechTokens.insert(speechTokens.end(), silenceTokens.begin(), silenceTokens.end());
  }

  ensureSession(conditionalDecoderSession_, config_.conditionalDecoderPath);

  std::cout << "ConditionalDecoderInfer started ... " << std::endl;
  runConditionalDecoderInfer(speechTokens, speakerEmbeddings, speakerFeatures);
  std::cout << "ConditionalDecoderInfer finished" << std::endl;

  OrtTensor wavTensor = conditionalDecoderSession_->getOutput("waveform");
  std::vector<float> wav;
  insertFromOrtTensorToVector(wavTensor, wav, wav.begin());

  releaseSession(conditionalDecoderSession_);

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
    std::memcpy(exaggerationTensor.data, &EXAGGERATION, sizeof(float));
  }

  embedTokensSession_->run();
}

void ChatterboxEngine::runSpeechEncoderInfer() {
  const std::vector<std::vector<int64_t>> inputShapes = {
      {1, static_cast<int64_t>(config_.referenceAudio.size())}
  };
  speechEncoderSession_->initInputTensors(inputShapes);

  // fill inputs
  OrtTensor inputIdsTensor = speechEncoderSession_->getInput("audio_values");
  std::memcpy(inputIdsTensor.data, config_.referenceAudio.data(), config_.referenceAudio.size() * sizeof(float));

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
  std::memcpy(inputsEmbsTensor.data, inputsEmbs.data.data(), inputsEmbs.data.size() * sizeof(float));

  OrtTensor attentionMaskTensor = languageModelSession_->getInput("attention_mask");
  std::memcpy(attentionMaskTensor.data, attentionMask.data.data(), attentionMask.data.size() * sizeof(int64_t));

  if (isEnglish_) {
    OrtTensor positionIdsTensor = languageModelSession_->getInput("position_ids");
    std::memcpy(positionIdsTensor.data, positionIds.data.data(), positionIds.data.size() * sizeof(int64_t));
  }

  for (size_t i = keyValueOffset_; i < languageModelSession_->getInputNames().size(); i++) {
    OrtTensor pastKeyValueTensor = languageModelSession_->getInput(languageModelSession_->getInputNames()[i]);
    std::memcpy(
        pastKeyValueTensor.data,
        pastKeyValues[languageModelSession_->getInputNames()[i]].data.data(),
        pastKeyValues[languageModelSession_->getInputNames()[i]].data.size() * sizeof(float));
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
  std::memcpy(speakerEmbeddingsTensor.data, speakerEmbeddings.data.data(),
              speakerEmbeddings.data.size() * sizeof(float));

  OrtTensor speakerFeaturesTensor =
      conditionalDecoderSession_->getInput("speaker_features");
  std::memcpy(speakerFeaturesTensor.data, speakerFeatures.data.data(),
              speakerFeatures.data.size() * sizeof(float));

  conditionalDecoderSession_->run();
}

} // namespace qvac::ttslib::chatterbox
