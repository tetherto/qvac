#include "ChatterboxEngine.hpp"
#include "ChatterboxLanguageMode.hpp"
#include "ChatterboxTextPreprocessor.hpp"
#include "FileUtils.hpp"
#include "Fp16Utils.hpp"
#include "OnnxInferSession.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <numeric>
#include <sstream>

using namespace qvac_lib_inference_addon_cpp::logger;

using qvac::ttslib::fp16::getNumElements;
using qvac::ttslib::fp16::readTensorToFloatBuffer;
using qvac::ttslib::fp16::readTensorToFloatVector;
using qvac::ttslib::fp16::writeFloatDataToTensor;

namespace {

const float REPETITION_PENALTY = 1.2;
const int MAX_NEW_TOKENS_SPEECH = 1024;
const float EXAGGERATION = 0.5;

const std::vector<std::string> SUPPORTED_LANGUAGES = {
    "ar", "bg", "cs", "da", "de", "el", "en", "es", "fi", "fr",
    "he", "hi", "hu", "it", "ja", "ko", "ms", "nl", "no", "pl",
    "pt", "ro", "ru", "sk", "sv", "sw", "ta", "tr", "vi", "zh",
};

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
  std::ostringstream ss;
  for (auto el : vector) {
    ss << el << " ";
  }
  QLOG(Priority::DEBUG, ss.str());
}

} // namespace

namespace qvac::ttslib::chatterbox {

namespace {

ChatterboxEngine::SessionFactory makeDefaultSessionFactory() {
  return [](const std::string &path) {
    return std::make_unique<OnnxInferSession>(path);
  };
}

} // namespace

ChatterboxEngine::ChatterboxEngine(const ChatterboxConfig &cfg,
                                   SessionFactory factory) {
  sessionFactory_ = factory ? std::move(factory) : makeDefaultSessionFactory();
  load(cfg);
}

ChatterboxEngine::~ChatterboxEngine() { unload(); }

void ChatterboxEngine::load(const ChatterboxConfig &cfg) {
  validateConfigs(cfg);

  config_ = cfg;
  language_ = cfg.language;
  lazySessionLoading_ = cfg.lazySessionLoading;

  const std::string blob = qvac::ttslib::loadFileBytes(cfg.tokenizerPath);
  tokenizerHandle_ = tokenizers_new_from_str(blob.data(), blob.length());

  if (!lazySessionLoading_) {
    speechEncoderSession_ = sessionFactory_(cfg.speechEncoderPath);
    embedTokensSession_ = sessionFactory_(cfg.embedTokensPath);
    conditionalDecoderSession_ = sessionFactory_(cfg.conditionalDecoderPath);
    languageModelSession_ = sessionFactory_(cfg.languageModelPath);
  }

  loadCangjieTableIfNeeded(cfg.tokenizerPath);

  isEnglish_ = language_ == "en";
  if (!isEnglish_ && embedTokensSession_ != nullptr &&
      lang_mode::shouldUseEnglishMode(language_,
                                      embedTokensSession_->getInputNames())) {
    QLOG(Priority::INFO,
         "Requested language '" + language_ +
             "' but model appears monolingual. Falling back to English mode.");
    isEnglish_ = true;
  }
  loaded_ = true;
  QLOG(Priority::INFO, "Language: " + language_);

  keyValueOffset_ = isEnglish_ ? OFFSET : OFFSET_MULTILINGUAL;
}

void ChatterboxEngine::ensureSession(
    std::unique_ptr<IOnnxInferSession> &session, const std::string &modelPath) {
  if (!session) {
    session = sessionFactory_(modelPath);
  }
}

void ChatterboxEngine::releaseSession(
    std::unique_ptr<IOnnxInferSession> &session) {
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

TensorData<int64_t> ChatterboxEngine::buildInitialPositionIds(
    const std::vector<int64_t> &inputIds) {
  TensorData<int64_t> positionIds;
  positionIds.data.reserve(inputIds.size());
  for (int i = 0; i < static_cast<int>(inputIds.size()); i++) {
    positionIds.data.push_back(inputIds[i] >= START_SPEECH_TOKEN ? 0 : i - 1);
  }
  positionIds.shape = {1, static_cast<int64_t>(positionIds.data.size())};
  return positionIds;
}

TensorData<float>
ChatterboxEngine::extractEmbeddings(const std::vector<int64_t> &inputIds,
                                    const std::vector<int64_t> &positionIds) {
  runEmbedTokensInfer(inputIds, positionIds);
  OrtTensor tensor = embedTokensSession_->getOutput("inputs_embeds");
  TensorData<float> embeddings;
  embeddings.shape = tensor.shape;
  readTensorToFloatVector(tensor, embeddings.data, embeddings.data.begin());
  return embeddings;
}

void ChatterboxEngine::processSpeechEncoderOutputs(
    TensorData<float> &inputsEmbs, TensorData<int64_t> &promptToken,
    TensorData<float> &speakerEmbeddings, TensorData<float> &speakerFeatures,
    TensorData<int64_t> &positionIds, TensorData<int64_t> &attentionMask,
    std::unordered_map<std::string, TensorData<float>> &pastKeyValues) {

  QLOG(Priority::INFO, "SpeechEncoderInfer started ...");
  runSpeechEncoderInfer();
  QLOG(Priority::INFO, "SpeechEncoderInfer finished");

  OrtTensor condEmbTensor = speechEncoderSession_->getOutput("audio_features");
  OrtTensor promptTokenTensor =
      speechEncoderSession_->getOutput("audio_tokens");
  OrtTensor speakerEmbeddingsTensor =
      speechEncoderSession_->getOutput("speaker_embeddings");
  OrtTensor speakerFeaturesTensor =
      speechEncoderSession_->getOutput("speaker_features");

  insertFromOrtTensorToVector(promptTokenTensor, promptToken.data,
                              promptToken.data.begin());
  readTensorToFloatVector(speakerEmbeddingsTensor, speakerEmbeddings.data,
                          speakerEmbeddings.data.begin());
  readTensorToFloatVector(speakerFeaturesTensor, speakerFeatures.data,
                          speakerFeatures.data.begin());
  readTensorToFloatVector(condEmbTensor, inputsEmbs.data,
                          inputsEmbs.data.begin());

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

  for (size_t i = keyValueOffset_;
       i < languageModelSession_->getInputNames().size(); i++) {
    TensorData<float> pastKeyValue;
    pastKeyValue.shape = {1, NUM_KV_HEADS, 0, HEAD_DIM};
    pastKeyValues[languageModelSession_->getInputNames()[i]] = pastKeyValue;
  }
}

int64_t
ChatterboxEngine::selectNextToken(const OrtTensor &logitsTensor,
                                  std::vector<int64_t> &generatedTokens) {
  std::vector<float> logits;
  logits.resize(logitsTensor.shape[2]);
  const int64_t logitsOffset =
      (logitsTensor.shape[1] - 1) * logitsTensor.shape[2];
  readTensorToFloatBuffer(logitsTensor, logits.data(), logitsOffset,
                          logitsTensor.shape[2]);

  penalizeRepetitionLogits(logits, generatedTokens);
  return static_cast<int64_t>(argmax(logits));
}

void ChatterboxEngine::advancePositionIds(TensorData<int64_t> &positionIds,
                                          size_t iteration) {
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
  for (size_t i = keyValueOffset_;
       i < languageModelSession_->getInputNames().size(); i++) {
    const std::string inputName = languageModelSession_->getInputNames()[i];
    const std::string outputName =
        languageModelSession_->getOutputNames()[i - keyValueOffset_ + 1];
    OrtTensor outputTensor = languageModelSession_->getOutput(outputName);

    const int64_t numElements = getNumElements(outputTensor);
    pastKeyValues[inputName].shape = outputTensor.shape;
    pastKeyValues[inputName].data.resize(numElements);

    readTensorToFloatBuffer(outputTensor, pastKeyValues[inputName].data.data(),
                            0, numElements);
  }
}

std::vector<int64_t> ChatterboxEngine::generateSpeechTokens(
    std::vector<int64_t> &inputIds, TensorData<int64_t> &positionIds,
    TensorData<float> &speakerEmbeddings, TensorData<float> &speakerFeatures) {

  TensorData<int64_t> promptToken;
  TensorData<int64_t> attentionMask;
  std::unordered_map<std::string, TensorData<float>> pastKeyValues;
  std::vector<int64_t> generatedTokens{START_SPEECH_TOKEN};

  const size_t maxNewTokens = static_cast<size_t>(MAX_NEW_TOKENS_SPEECH);

  for (size_t i = 0; i < maxNewTokens; i++) {
    TensorData<float> inputsEmbs =
        extractEmbeddings(inputIds, positionIds.data);

    if (i == 0) {
      processSpeechEncoderOutputs(inputsEmbs, promptToken, speakerEmbeddings,
                                  speakerFeatures, positionIds, attentionMask,
                                  pastKeyValues);
    }

    runLanguageModelInfer(inputsEmbs, positionIds, attentionMask,
                          pastKeyValues);

    OrtTensor logitsTensor = languageModelSession_->getOutput("logits");
    const int64_t nextToken = selectNextToken(logitsTensor, generatedTokens);
    generatedTokens.push_back(nextToken);
    inputIds = {nextToken};

    if (nextToken == STOP_SPEECH_TOKEN) {
      QLOG(Priority::INFO, "STOP_SPEECH_TOKEN reached: stopping generation");
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
  std::vector<int64_t> speechTokens(promptToken.data.begin(),
                                    promptToken.data.end());
  speechTokens.insert(speechTokens.end(), generatedTokens.begin() + 1,
                      generatedTokens.end() - 1);

  if (isEnglish_) {
    const std::vector<int64_t> silenceTokens(3, SILENCE_TOKEN);
    speechTokens.insert(speechTokens.end(), silenceTokens.begin(),
                        silenceTokens.end());
  }

  return speechTokens;
}

std::vector<float>
ChatterboxEngine::synthesizeWaveform(const std::vector<int64_t> &speechTokens,
                                     const TensorData<float> &speakerEmbeddings,
                                     const TensorData<float> &speakerFeatures) {
  ensureSession(conditionalDecoderSession_, config_.conditionalDecoderPath);

  QLOG(Priority::INFO, "ConditionalDecoderInfer started ...");
  runConditionalDecoderInfer(speechTokens, speakerEmbeddings, speakerFeatures);
  QLOG(Priority::INFO, "ConditionalDecoderInfer finished");

  OrtTensor wavTensor = conditionalDecoderSession_->getOutput("waveform");
  std::vector<float> wav;
  readTensorToFloatVector(wavTensor, wav, wav.begin());

  releaseSession(conditionalDecoderSession_);
  return wav;
}

AudioResult
ChatterboxEngine::convertToAudioResult(const std::vector<float> &wav) {
  std::ostringstream ss;
  ss << "Generated audio size: " << wav.size() / 24000.0 << " seconds";
  QLOG(Priority::INFO, ss.str());

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
  ensureSession(embedTokensSession_, config_.embedTokensPath);
  ensureSession(speechEncoderSession_, config_.speechEncoderPath);
  ensureSession(languageModelSession_, config_.languageModelPath);

  if (!isEnglish_ && lang_mode::shouldUseEnglishMode(
                         language_, embedTokensSession_->getInputNames())) {
    QLOG(Priority::INFO, "Model is monolingual, falling back to English mode");
    isEnglish_ = true;
    keyValueOffset_ = OFFSET;
  }

  std::vector<int64_t> inputIds = tokenize(text);
  TensorData<int64_t> positionIds;
  TensorData<float> speakerEmbeddings;
  TensorData<float> speakerFeatures;

  if (!isEnglish_) {
    positionIds = buildInitialPositionIds(inputIds);
  }

  QLOG(Priority::INFO, "Sampling ... " + text);

  std::vector<int64_t> speechTokens = generateSpeechTokens(
      inputIds, positionIds, speakerEmbeddings, speakerFeatures);

  std::vector<float> wav =
      synthesizeWaveform(speechTokens, speakerEmbeddings, speakerFeatures);

  return convertToAudioResult(wav);
}

std::vector<int64_t> ChatterboxEngine::tokenize(const std::string &text) {
  const std::string preprocessed =
      text_preprocess::preprocessText(text, language_, cangjieTable_);
  const std::string preparedText = lang_mode::prepareTextForTokenization(
      preprocessed, language_, isEnglish_);
  QLOG(Priority::INFO, "tokenizing text: " + preparedText);

  TokenizerEncodeResult result;
  tokenizers_encode(tokenizerHandle_, preparedText.data(),
                    preparedText.length(), 1, &result);

  const std::vector<int64_t> tokens(result.token_ids,
                                    result.token_ids + result.len);
  tokenizers_free_encode_results(&result, 1);

  return tokens;
}

void ChatterboxEngine::loadCangjieTableIfNeeded(
    const std::string &tokenizerPath) {
  if (language_ != "zh") {
    cangjieTable_.clear();
    return;
  }

  std::string dir = tokenizerPath;
  size_t lastSlash = dir.find_last_of("/\\");
  if (lastSlash != std::string::npos) {
    dir = dir.substr(0, lastSlash);
  }
  std::string cangjieTablePath = dir + "/Cangjie5_TC.tsv";

  QLOG(Priority::INFO, "Loading Cangjie table from: " + cangjieTablePath);
  cangjieTable_ = text_preprocess::loadCangjieTable(cangjieTablePath);
  QLOG(Priority::INFO, "Cangjie table loaded: " +
                           std::to_string(cangjieTable_.size()) + " entries");
}

void ChatterboxEngine::runEmbedTokensInfer(
    const std::vector<int64_t> &inputIds,
    const std::vector<int64_t> &positionIds) {

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
  std::memcpy(inputIdsTensor.data, inputIds.data(),
              inputIds.size() * sizeof(int64_t));

  if (!isEnglish_) {
    OrtTensor positionIdsTensor = embedTokensSession_->getInput("position_ids");
    std::memcpy(positionIdsTensor.data, positionIds.data(),
                positionIds.size() * sizeof(int64_t));

    OrtTensor exaggerationTensor =
        embedTokensSession_->getInput("exaggeration");
    writeFloatDataToTensor(exaggerationTensor, &EXAGGERATION, 1);
  }

  embedTokensSession_->run();
}

void ChatterboxEngine::runSpeechEncoderInfer() {
  const std::vector<std::vector<int64_t>> inputShapes = {
      {1, static_cast<int64_t>(config_.referenceAudio.size())}};
  speechEncoderSession_->initInputTensors(inputShapes);

  // fill inputs
  OrtTensor audioValuesTensor = speechEncoderSession_->getInput("audio_values");
  writeFloatDataToTensor(audioValuesTensor, config_.referenceAudio.data(),
                         config_.referenceAudio.size());

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

  for (size_t i = keyValueOffset_;
       i < languageModelSession_->getInputNames().size(); i++) {
    inputShapes.push_back(
        pastKeyValues[languageModelSession_->getInputNames()[i]].shape);
  }

  languageModelSession_->initInputTensors(inputShapes);

  // fill inputs
  OrtTensor inputsEmbsTensor = languageModelSession_->getInput("inputs_embeds");
  writeFloatDataToTensor(inputsEmbsTensor, inputsEmbs.data.data(),
                         inputsEmbs.data.size());

  OrtTensor attentionMaskTensor =
      languageModelSession_->getInput("attention_mask");
  std::memcpy(attentionMaskTensor.data, attentionMask.data.data(),
              attentionMask.data.size() * sizeof(int64_t));

  if (isEnglish_) {
    OrtTensor positionIdsTensor =
        languageModelSession_->getInput("position_ids");
    std::memcpy(positionIdsTensor.data, positionIds.data.data(),
                positionIds.data.size() * sizeof(int64_t));
  }

  for (size_t i = keyValueOffset_;
       i < languageModelSession_->getInputNames().size(); i++) {
    OrtTensor pastKeyValueTensor = languageModelSession_->getInput(
        languageModelSession_->getInputNames()[i]);
    const auto &kvData =
        pastKeyValues[languageModelSession_->getInputNames()[i]].data;
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
  writeFloatDataToTensor(speakerEmbeddingsTensor, speakerEmbeddings.data.data(),
                         speakerEmbeddings.data.size());

  OrtTensor speakerFeaturesTensor =
      conditionalDecoderSession_->getInput("speaker_features");
  writeFloatDataToTensor(speakerFeaturesTensor, speakerFeatures.data.data(),
                         speakerFeatures.data.size());

  conditionalDecoderSession_->run();
}

} // namespace qvac::ttslib::chatterbox
