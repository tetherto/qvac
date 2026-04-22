#include "ChatterboxEngine.hpp"
#include "ChatterboxLanguageMode.hpp"
#include "ChatterboxTextPreprocessor.hpp"
#include "FileUtils.hpp"
#include "Fp16Utils.hpp"
#include "OnnxInferSession.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#include <algorithm>
#include <chrono>
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

const float REPETITION_PENALTY = 1.2f;
const float MULTILINGUAL_REPETITION_PENALTY = 2.0f;
const float CFG_WEIGHT = 0.5f;
const float TEMPERATURE = 0.8f;
const float MIN_P = 0.05f;
const float PEAK_NORMALIZE_TARGET = 0.95f;
const int TOKEN_REPETITION_THRESHOLD = 2;
const int MAX_NEW_TOKENS_SPEECH = 1024;
const int SPEECH_TO_TEXT_MAX_RATIO = 3;
const int MIN_SPEECH_TOKENS = 50;
const int SILENCE_RUN_THRESHOLD = 5;
const int PATTERN_MAX_LENGTH = 8;
const int PATTERN_MIN_REPEATS = 3;
const int PATTERN_MIN_TOKENS = 6;
const float EXAGGERATION = 0.5f;

const float TRIM_THRESHOLD_RATIO = 0.08f;
const int TRIM_WINDOW_DIVISOR = 25;
const int TRIM_MIN_DURATION_DIVISOR = 4;
// 300ms keeps trailing consonants (e.g. the "x" in "Chatterbox") from being
// clipped by trimTrailingSilence; 150ms was too aggressive for the multilingual
// model whose raw output includes longer tail energy.
const int TRIM_TAIL_PADDING_MS = 300;
const int TRIM_FADE_DIVISOR = 50;
const float NEAR_ZERO = 1e-8f;

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
                              const std::vector<int64_t> &inputIds,
                              float penalty) {
  for (auto id : inputIds) {
    if (logits[id] < 0) {
      logits[id] *= penalty;
    } else {
      logits[id] /= penalty;
    }
  }
}

// Reads last-step logits for a specific batch index from a logits tensor
// shaped [batch, seq, vocab].
std::vector<float> readLastStepLogitsForBatch(
    const qvac::ttslib::chatterbox::OrtTensor &logitsTensor, int64_t batchIdx) {
  const int64_t seqLen = logitsTensor.shape[1];
  const int64_t vocabSize = logitsTensor.shape[2];
  const int64_t perBatchElements = seqLen * vocabSize;
  const int64_t offset = batchIdx * perBatchElements + (seqLen - 1) * vocabSize;
  std::vector<float> logits(vocabSize);
  readTensorToFloatBuffer(logitsTensor, logits.data(), offset, vocabSize);
  return logits;
}

bool detectTokenRepetition(const std::vector<int64_t> &tokens, int threshold) {
  if (static_cast<int>(tokens.size()) < threshold) {
    return false;
  }
  int64_t lastToken = tokens.back();
  int count = 0;
  for (auto it = tokens.rbegin(); it != tokens.rend(); ++it) {
    if (*it == lastToken) {
      count++;
    } else {
      break;
    }
  }
  return count >= threshold;
}

int countPatternRepeats(const std::vector<int64_t> &tokens, int patLen) {
  int n = static_cast<int>(tokens.size());
  int repeats = 1;
  for (int rep = 1; rep * patLen < n; rep++) {
    bool match = true;
    for (int j = 0; j < patLen; j++) {
      if (tokens[n - 1 - j] != tokens[n - 1 - rep * patLen - j]) {
        match = false;
        break;
      }
    }
    if (match) {
      repeats++;
    } else {
      break;
    }
  }
  return repeats;
}

bool detectPatternRepetition(const std::vector<int64_t> &tokens) {
  int n = static_cast<int>(tokens.size());
  if (n < PATTERN_MIN_TOKENS) {
    return false;
  }

  int maxLen = std::min(PATTERN_MAX_LENGTH, n / PATTERN_MIN_REPEATS);
  for (int patLen = 2; patLen <= maxLen; patLen++) {
    if (countPatternRepeats(tokens, patLen) >= PATTERN_MIN_REPEATS) {
      return true;
    }
  }
  return false;
}

bool detectSilenceRun(const std::vector<int64_t> &tokens, int threshold) {
  int n = static_cast<int>(tokens.size());
  if (n < threshold) {
    return false;
  }

  for (int i = n - threshold; i < n; i++) {
    if (tokens[i] != SILENCE_TOKEN) {
      return false;
    }
  }
  return true;
}

void applyCfgCombine(std::vector<float> &condLogits,
                     const std::vector<float> &uncondLogits, float weight) {
  for (size_t i = 0; i < condLogits.size(); i++) {
    condLogits[i] += weight * (condLogits[i] - uncondLogits[i]);
  }
}

void scaleByTemperature(std::vector<float> &logits, float temperature) {
  for (auto &l : logits) {
    l /= temperature;
  }
}

float computeExpAndSum(std::vector<float> &logits) {
  float maxLogit = *std::max_element(logits.begin(), logits.end());
  float sum = 0.0f;
  for (auto &l : logits) {
    l = std::exp(l - maxLogit);
    sum += l;
  }
  return sum;
}

void normalizeVector(std::vector<float> &values, float sum) {
  for (auto &v : values) {
    v /= sum;
  }
}

void applySoftmax(std::vector<float> &logits, float temperature) {
  scaleByTemperature(logits, temperature);
  float sum = computeExpAndSum(logits);
  normalizeVector(logits, sum);
}

float thresholdProbs(std::vector<float> &probs, float threshold) {
  float sum = 0.0f;
  for (auto &p : probs) {
    if (p < threshold) {
      p = 0.0f;
    }
    sum += p;
  }
  return sum;
}

void applyMinPFilter(std::vector<float> &probs, float minP) {
  if (minP <= 0.0f) {
    return;
  }

  float maxProb = *std::max_element(probs.begin(), probs.end());
  float sum = thresholdProbs(probs, maxProb * minP);
  if (sum > 0.0f) {
    normalizeVector(probs, sum);
  }
}

int64_t sampleWithTemperature(std::vector<float> &logits, float temperature,
                              float minP, std::mt19937 &rng) {
  applySoftmax(logits, temperature);
  applyMinPFilter(logits, minP);

  std::discrete_distribution<int> dist(logits.begin(), logits.end());
  return static_cast<int64_t>(dist(rng));
}

float findPeakAmplitude(const std::vector<float> &wav) {
  float peak = 0.0f;
  for (auto s : wav) {
    float absVal = std::abs(s);
    if (absVal > peak) {
      peak = absVal;
    }
  }
  return peak;
}

float computeWindowEnergy(const std::vector<float> &wav, int start, int end) {
  float energy = 0.0f;
  for (int i = start; i < end; i++) {
    energy += std::abs(wav[i]);
  }
  return energy / static_cast<float>(end - start);
}

int findSpeechEnd(const std::vector<float> &wav, int windowSize, int minSamples,
                  float threshold) {
  int end = static_cast<int>(wav.size());
  while (end > minSamples) {
    int windowStart = std::max(0, end - windowSize);
    if (computeWindowEnergy(wav, windowStart, end) > threshold) {
      break;
    }
    end = windowStart;
  }
  return end;
}

void applyFadeOut(std::vector<float> &wav, int trimPoint, int fadeLen) {
  for (int i = 0; i < fadeLen; i++) {
    float gain = static_cast<float>(fadeLen - i) / static_cast<float>(fadeLen);
    wav[trimPoint - fadeLen + i] *= gain;
  }
  wav.resize(trimPoint);
}

void trimTrailingSilence(std::vector<float> &wav, int sampleRate) {
  float peak = findPeakAmplitude(wav);
  if (peak < NEAR_ZERO) {
    return;
  }

  int windowSize = sampleRate / TRIM_WINDOW_DIVISOR;
  int minSamples = sampleRate / TRIM_MIN_DURATION_DIVISOR;
  float threshold = peak * TRIM_THRESHOLD_RATIO;

  int speechEnd = findSpeechEnd(wav, windowSize, minSamples, threshold);
  int tailPadding = sampleRate * TRIM_TAIL_PADDING_MS / 1000;
  int trimPoint =
      std::min(speechEnd + tailPadding, static_cast<int>(wav.size()));

  if (trimPoint < static_cast<int>(wav.size())) {
    int fadeLen = std::min(sampleRate / TRIM_FADE_DIVISOR, trimPoint);
    applyFadeOut(wav, trimPoint, fadeLen);
  }
}

void peakNormalize(std::vector<float> &wav, float target) {
  float peak = findPeakAmplitude(wav);
  if (peak > NEAR_ZERO) {
    float scale = target / peak;
    for (auto &s : wav) {
      s *= scale;
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

ChatterboxEngine::SessionFactory makeDefaultSessionFactory(bool useGPU,
                                                           int numThreads) {
  return [useGPU, numThreads](const std::string &path) {
    return std::make_unique<OnnxInferSession>(path, useGPU, numThreads);
  };
}

} // namespace

ChatterboxEngine::ChatterboxEngine(const ChatterboxConfig &cfg,
                                   SessionFactory factory) {
  sessionFactory_ = factory
                        ? std::move(factory)
                        : makeDefaultSessionFactory(cfg.useGPU, cfg.numThreads);
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
  loadTextEmbWeight(cfg.embedTokensPath);

  if (embedTokensSession_ != nullptr) {
    isEnglish_ = lang_mode::shouldUseEnglishMode(
        language_, embedTokensSession_->getInputNames());
    if (isEnglish_ && language_ != "en") {
      QLOG(
          Priority::INFO,
          "Requested language '" + language_ +
              "' but model appears monolingual. Falling back to English mode.");
    }
  } else {
    isEnglish_ = language_ == "en";
  }
  loaded_ = true;
  QLOG(Priority::INFO, "Language: " + language_);

  keyValueOffset_ = isEnglish_ ? OFFSET : OFFSET_MULTILINGUAL;

  // Speech-encoder output only depends on the reference audio supplied to
  // load(), so we pre-compute it here instead of on first synthesize(). This
  // keeps every synthesize() call at the same cost (no one-off ~2.7s penalty
  // on the first call) and means subsequent calls just reuse the cache.
  runSpeechEncoderAndCache();
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
  textEmbWeight_.clear();
  textEmbRows_ = 0;
  textEmbDim_ = 0;
  speechEncoderCache_ = {};

  if (tokenizerHandle_ != nullptr) {
    tokenizers_free(tokenizerHandle_);
    tokenizerHandle_ = nullptr;
  }
}

bool ChatterboxEngine::hasSpeechEncoderCache() const {
  return speechEncoderCache_.valid;
}

void ChatterboxEngine::clearSpeechEncoderCache() {
  speechEncoderCache_ = {};
  QLOG(Priority::INFO, "Speech encoder cache cleared");
}

void ChatterboxEngine::runSpeechEncoderAndCache() {
  ensureSession(speechEncoderSession_, config_.speechEncoderPath);

  auto start = std::chrono::high_resolution_clock::now();
  QLOG(Priority::INFO, "SpeechEncoderInfer started ...");
  runSpeechEncoderInfer();
  auto elapsed = std::chrono::duration<double>(
      std::chrono::high_resolution_clock::now() - start);
  QLOG(Priority::INFO, "SpeechEncoderInfer finished (" +
                           std::to_string(elapsed.count()) + "s)");

  OrtTensor audioFeatTensor =
      speechEncoderSession_->getOutput("audio_features");
  OrtTensor promptTokenTensor =
      speechEncoderSession_->getOutput("audio_tokens");
  OrtTensor speakerEmbTensor =
      speechEncoderSession_->getOutput("speaker_embeddings");
  OrtTensor speakerFeatTensor =
      speechEncoderSession_->getOutput("speaker_features");

  speechEncoderCache_.audioFeatures.shape = audioFeatTensor.shape;
  speechEncoderCache_.audioFeatures.data.clear();
  readTensorToFloatVector(audioFeatTensor,
                          speechEncoderCache_.audioFeatures.data,
                          speechEncoderCache_.audioFeatures.data.begin());

  speechEncoderCache_.promptToken.shape = promptTokenTensor.shape;
  speechEncoderCache_.promptToken.data.clear();
  insertFromOrtTensorToVector(promptTokenTensor,
                              speechEncoderCache_.promptToken.data,
                              speechEncoderCache_.promptToken.data.begin());

  speechEncoderCache_.speakerEmbeddings.shape = speakerEmbTensor.shape;
  speechEncoderCache_.speakerEmbeddings.data.clear();
  readTensorToFloatVector(speakerEmbTensor,
                          speechEncoderCache_.speakerEmbeddings.data,
                          speechEncoderCache_.speakerEmbeddings.data.begin());

  speechEncoderCache_.speakerFeatures.shape = speakerFeatTensor.shape;
  speechEncoderCache_.speakerFeatures.data.clear();
  readTensorToFloatVector(speakerFeatTensor,
                          speechEncoderCache_.speakerFeatures.data,
                          speechEncoderCache_.speakerFeatures.data.begin());

  speechEncoderCache_.valid = true;

  releaseSession(speechEncoderSession_);
  QLOG(Priority::INFO, "Speech encoder outputs cached for reuse");
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

  QLOG(Priority::INFO, "Using cached speech encoder outputs");

  const auto &cache = speechEncoderCache_;

  promptToken.data.insert(promptToken.data.begin(),
                          cache.promptToken.data.begin(),
                          cache.promptToken.data.end());
  promptToken.shape = cache.promptToken.shape;

  speakerEmbeddings.data.insert(speakerEmbeddings.data.begin(),
                                cache.speakerEmbeddings.data.begin(),
                                cache.speakerEmbeddings.data.end());
  speakerEmbeddings.shape = cache.speakerEmbeddings.shape;

  speakerFeatures.data.insert(speakerFeatures.data.begin(),
                              cache.speakerFeatures.data.begin(),
                              cache.speakerFeatures.data.end());
  speakerFeatures.shape = cache.speakerFeatures.shape;

  inputsEmbs.data.insert(inputsEmbs.data.begin(),
                         cache.audioFeatures.data.begin(),
                         cache.audioFeatures.data.end());
  inputsEmbs.shape[1] += cache.audioFeatures.shape[1];

  const int64_t seqLen = inputsEmbs.shape[1];
  attentionMask.data.resize(seqLen, 1);
  attentionMask.shape = {1, seqLen};

  if (isEnglish_) {
    positionIds.data.resize(seqLen);
    positionIds.shape = {1, seqLen};
    std::iota(positionIds.data.begin(), positionIds.data.end(), 0);
  }

  pastKeyValues = initEmptyKvCache();
}

std::unordered_map<std::string, TensorData<float>>
ChatterboxEngine::initEmptyKvCache(int64_t batchSize) {
  std::unordered_map<std::string, TensorData<float>> kvCache;
  const auto &inputNames = languageModelSession_->getInputNames();
  for (size_t i = keyValueOffset_; i < inputNames.size(); i++) {
    TensorData<float> emptyKv;
    emptyKv.shape = {batchSize, NUM_KV_HEADS, 0, HEAD_DIM};
    kvCache[inputNames[i]] = emptyKv;
  }
  return kvCache;
}

void ChatterboxEngine::collectKvShapes(
    std::vector<std::vector<int64_t>> &inputShapes,
    const std::unordered_map<std::string, TensorData<float>> &pastKeyValues) {
  const auto &inputNames = languageModelSession_->getInputNames();
  for (size_t i = keyValueOffset_; i < inputNames.size(); i++) {
    inputShapes.push_back(pastKeyValues.at(inputNames[i]).shape);
  }
}

void ChatterboxEngine::writeKvToTensors(
    const std::unordered_map<std::string, TensorData<float>> &pastKeyValues) {
  const auto &inputNames = languageModelSession_->getInputNames();
  for (size_t i = keyValueOffset_; i < inputNames.size(); i++) {
    OrtTensor tensor = languageModelSession_->getInput(inputNames[i]);
    const auto &kvData = pastKeyValues.at(inputNames[i]).data;
    writeFloatDataToTensor(tensor, kvData.data(), kvData.size());
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

  penalizeRepetitionLogits(logits, generatedTokens, REPETITION_PENALTY);
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

void ChatterboxEngine::runGenerationLoop(
    std::vector<int64_t> &inputIds, TensorData<int64_t> &positionIds,
    TensorData<int64_t> &attentionMask,
    std::unordered_map<std::string, TensorData<float>> &pastKeyValues,
    TensorData<int64_t> &promptToken, TensorData<float> &speakerEmbeddings,
    TensorData<float> &speakerFeatures, std::vector<int64_t> &generatedTokens) {

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
}

std::vector<int64_t> ChatterboxEngine::generateSpeechTokens(
    std::vector<int64_t> &inputIds, TensorData<int64_t> &positionIds,
    TensorData<float> &speakerEmbeddings, TensorData<float> &speakerFeatures) {

  TensorData<int64_t> promptToken;
  TensorData<int64_t> attentionMask;
  std::unordered_map<std::string, TensorData<float>> pastKeyValues;
  std::vector<int64_t> generatedTokens{START_SPEECH_TOKEN};

  runGenerationLoop(inputIds, positionIds, attentionMask, pastKeyValues,
                    promptToken, speakerEmbeddings, speakerFeatures,
                    generatedTokens);

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
  auto synthStart = std::chrono::high_resolution_clock::now();

  ensureSession(embedTokensSession_, config_.embedTokensPath);
  ensureSession(languageModelSession_, config_.languageModelPath);

  bool shouldBeEnglish = lang_mode::shouldUseEnglishMode(
      language_, embedTokensSession_->getInputNames());
  if (shouldBeEnglish != isEnglish_) {
    isEnglish_ = shouldBeEnglish;
    keyValueOffset_ = isEnglish_ ? OFFSET : OFFSET_MULTILINGUAL;
  }

  std::vector<int64_t> inputIds = tokenize(text);
  TensorData<int64_t> positionIds;
  TensorData<float> speakerEmbeddings;
  TensorData<float> speakerFeatures;

  if (!isEnglish_) {
    positionIds = buildInitialPositionIds(inputIds);
  }

  QLOG(Priority::INFO, "Sampling ... " + text);

  auto lmStart = std::chrono::high_resolution_clock::now();

  bool useCfg = !isEnglish_ && !textEmbWeight_.empty();
  std::vector<int64_t> speechTokens;
  if (useCfg) {
    QLOG(Priority::INFO, "Using CFG pipeline for multilingual");
    speechTokens = generateSpeechTokensWithCfg(
        inputIds, positionIds, speakerEmbeddings, speakerFeatures);
  } else {
    speechTokens = generateSpeechTokens(inputIds, positionIds,
                                        speakerEmbeddings, speakerFeatures);
  }

  auto lmElapsed = std::chrono::duration<double>(
      std::chrono::high_resolution_clock::now() - lmStart);
  QLOG(Priority::INFO, "LM generation: " + std::to_string(speechTokens.size()) +
                           " tokens in " + std::to_string(lmElapsed.count()) +
                           "s");

  auto decoderStart = std::chrono::high_resolution_clock::now();
  std::vector<float> wav =
      synthesizeWaveform(speechTokens, speakerEmbeddings, speakerFeatures);
  auto decoderElapsed = std::chrono::duration<double>(
      std::chrono::high_resolution_clock::now() - decoderStart);
  QLOG(Priority::INFO,
       "Conditional decoder: " + std::to_string(decoderElapsed.count()) + "s");

  if (!isEnglish_) {
    trimTrailingSilence(wav, SAMPLE_RATE);
    peakNormalize(wav, PEAK_NORMALIZE_TARGET);
  }

  auto synthElapsed = std::chrono::duration<double>(
      std::chrono::high_resolution_clock::now() - synthStart);
  QLOG(Priority::INFO,
       "Total synthesize: " + std::to_string(synthElapsed.count()) + "s");

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

  collectKvShapes(inputShapes, pastKeyValues);

  languageModelSession_->initInputTensors(inputShapes);

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

  writeKvToTensors(pastKeyValues);

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

void ChatterboxEngine::loadTextEmbWeight(const std::string &embedTokensPath) {
  std::string dir = embedTokensPath;
  size_t lastSlash = dir.find_last_of("/\\");
  if (lastSlash != std::string::npos) {
    dir = dir.substr(0, lastSlash);
  }
  std::string binPath = dir + "/text_emb_weight.bin";

  std::ifstream file(binPath, std::ios::binary);
  if (!file.is_open()) {
    QLOG(Priority::WARNING,
         "text_emb_weight.bin not found — CFG disabled: " + binPath);
    return;
  }

  int32_t rows = 0;
  int32_t dim = 0;
  file.read(reinterpret_cast<char *>(&rows), sizeof(rows));
  file.read(reinterpret_cast<char *>(&dim), sizeof(dim));

  textEmbRows_ = rows;
  textEmbDim_ = dim;
  textEmbWeight_.resize(static_cast<size_t>(rows) * dim);
  file.read(reinterpret_cast<char *>(textEmbWeight_.data()),
            textEmbWeight_.size() * sizeof(float));

  QLOG(Priority::INFO, "Loaded text_emb_weight: " + std::to_string(rows) + "x" +
                           std::to_string(dim));
}

void subtractTextEmbedding(std::vector<float> &data, size_t offset,
                           const std::vector<float> &weights,
                           size_t weightOffset, int64_t dim) {
  for (int64_t d = 0; d < dim; d++) {
    data[offset + d] -= weights[weightOffset + d];
  }
}

TensorData<float> ChatterboxEngine::createUnconditionalEmbeddings(
    const TensorData<float> &condEmbs, const std::vector<int64_t> &inputIds) {
  TensorData<float> uncond;
  uncond.shape = condEmbs.shape;
  uncond.data = condEmbs.data;

  const int64_t dim = condEmbs.shape[2];

  for (size_t i = 0; i < inputIds.size(); i++) {
    int64_t tid = inputIds[i];
    if (tid < START_SPEECH_TOKEN && tid < textEmbRows_) {
      subtractTextEmbedding(uncond.data, i * dim, textEmbWeight_,
                            tid * textEmbDim_, dim);
    }
  }
  return uncond;
}

void ChatterboxEngine::prepareCfgEmbeddings(
    const std::vector<int64_t> &inputIds,
    const std::vector<int64_t> &positionIds, TensorData<float> &condEmbs,
    TensorData<float> &uncondEmbs, TensorData<int64_t> &promptToken,
    TensorData<float> &speakerEmbeddings, TensorData<float> &speakerFeatures) {

  condEmbs = extractEmbeddings(inputIds, positionIds);
  uncondEmbs = createUnconditionalEmbeddings(condEmbs, inputIds);

  QLOG(Priority::INFO, "Using cached speech encoder outputs (CFG)");

  const auto &cache = speechEncoderCache_;

  promptToken.data.insert(promptToken.data.begin(),
                          cache.promptToken.data.begin(),
                          cache.promptToken.data.end());
  promptToken.shape = cache.promptToken.shape;

  speakerEmbeddings.data.insert(speakerEmbeddings.data.begin(),
                                cache.speakerEmbeddings.data.begin(),
                                cache.speakerEmbeddings.data.end());
  speakerEmbeddings.shape = cache.speakerEmbeddings.shape;

  speakerFeatures.data.insert(speakerFeatures.data.begin(),
                              cache.speakerFeatures.data.begin(),
                              cache.speakerFeatures.data.end());
  speakerFeatures.shape = cache.speakerFeatures.shape;

  const auto &audioFeatData = cache.audioFeatures.data;
  const int64_t audioFeatSeqLen = cache.audioFeatures.shape[1];

  std::vector<float> condCombined;
  condCombined.reserve(audioFeatData.size() + condEmbs.data.size());
  condCombined.insert(condCombined.end(), audioFeatData.begin(),
                      audioFeatData.end());
  condCombined.insert(condCombined.end(), condEmbs.data.begin(),
                      condEmbs.data.end());
  condEmbs.data = std::move(condCombined);
  condEmbs.shape[1] += audioFeatSeqLen;

  std::vector<float> uncondCombined;
  uncondCombined.reserve(audioFeatData.size() + uncondEmbs.data.size());
  uncondCombined.insert(uncondCombined.end(), audioFeatData.begin(),
                        audioFeatData.end());
  uncondCombined.insert(uncondCombined.end(), uncondEmbs.data.begin(),
                        uncondEmbs.data.end());
  uncondEmbs.data = std::move(uncondCombined);
  uncondEmbs.shape[1] += audioFeatSeqLen;
}

int64_t ChatterboxEngine::runInitialCfgStep(
    const TensorData<float> &condEmbs, const TensorData<float> &uncondEmbs,
    TensorData<int64_t> &positionIds, TensorData<int64_t> &attentionMask,
    std::unordered_map<std::string, TensorData<float>> &batchedKv,
    std::vector<int64_t> &generatedTokens) {

  TensorData<float> batchedEmbs = tensor_ops::concatBatch(condEmbs, uncondEmbs);
  TensorData<int64_t> batchedMask = tensor_ops::duplicateBatch(attentionMask);

  runLanguageModelInfer(batchedEmbs, positionIds, batchedMask, batchedKv);

  OrtTensor logitsTensor = languageModelSession_->getOutput("logits");
  std::vector<float> condLogits = readLastStepLogitsForBatch(logitsTensor, 0);
  std::vector<float> uncondLogits = readLastStepLogitsForBatch(logitsTensor, 1);
  cachePastKeyValues(batchedKv);

  applyCfgCombine(condLogits, uncondLogits, CFG_WEIGHT);
  penalizeRepetitionLogits(condLogits, generatedTokens,
                           MULTILINGUAL_REPETITION_PENALTY);

  int64_t firstToken =
      sampleWithTemperature(condLogits, TEMPERATURE, MIN_P, rng_);
  generatedTokens.push_back(firstToken);

  QLOG(Priority::INFO,
       "CFG initial step done, first token: " + std::to_string(firstToken));

  positionIds.data = {1};
  positionIds.shape = {1, 1};

  return firstToken;
}

bool ChatterboxEngine::shouldStopGeneration(const std::vector<int64_t> &tokens,
                                            int step) {
  int64_t lastToken = tokens.back();

  if (lastToken == STOP_SPEECH_TOKEN) {
    QLOG(Priority::INFO,
         "STOP_SPEECH_TOKEN reached at step " + std::to_string(step));
    return true;
  }

  if (detectTokenRepetition(tokens, TOKEN_REPETITION_THRESHOLD)) {
    QLOG(Priority::INFO, "Token repetition detected at step " +
                             std::to_string(step) + ", forcing stop");
    return true;
  }

  if (detectPatternRepetition(tokens)) {
    QLOG(Priority::INFO, "Pattern repetition detected at step " +
                             std::to_string(step) + ", forcing stop");
    return true;
  }

  if (detectSilenceRun(tokens, SILENCE_RUN_THRESHOLD)) {
    QLOG(Priority::INFO, "Silence token run detected at step " +
                             std::to_string(step) + ", forcing stop");
    return true;
  }

  return false;
}

void ChatterboxEngine::runCfgGenerationLoop(
    std::vector<int64_t> &generatedTokens, TensorData<int64_t> &positionIds,
    TensorData<int64_t> &attentionMask,
    std::unordered_map<std::string, TensorData<float>> &batchedKv,
    int maxSpeechTokens) {

  for (int step = 0; step < maxSpeechTokens - 1; step++) {
    if (shouldStopGeneration(generatedTokens, step)) {
      if (generatedTokens.back() != STOP_SPEECH_TOKEN) {
        generatedTokens.push_back(STOP_SPEECH_TOKEN);
      }
      break;
    }

    std::vector<int64_t> stepInputIds = {generatedTokens.back()};
    TensorData<float> nextEmbs =
        extractEmbeddings(stepInputIds, positionIds.data);

    attentionMask.data.push_back(1);
    attentionMask.shape[1]++;

    TensorData<float> batchedEmbs = tensor_ops::duplicateBatch(nextEmbs);
    TensorData<int64_t> batchedMask = tensor_ops::duplicateBatch(attentionMask);

    runLanguageModelInfer(batchedEmbs, positionIds, batchedMask, batchedKv);

    OrtTensor logitsTensor = languageModelSession_->getOutput("logits");
    std::vector<float> condLogits = readLastStepLogitsForBatch(logitsTensor, 0);
    std::vector<float> uncondLogits =
        readLastStepLogitsForBatch(logitsTensor, 1);
    cachePastKeyValues(batchedKv);

    applyCfgCombine(condLogits, uncondLogits, CFG_WEIGHT);
    penalizeRepetitionLogits(condLogits, generatedTokens,
                             MULTILINGUAL_REPETITION_PENALTY);

    int64_t nextToken =
        sampleWithTemperature(condLogits, TEMPERATURE, MIN_P, rng_);
    generatedTokens.push_back(nextToken);

    positionIds.data = {static_cast<int64_t>(step + 2)};
    positionIds.shape = {1, 1};

    if (step == maxSpeechTokens - 2) {
      QLOG(Priority::INFO, "Max speech tokens reached (" +
                               std::to_string(maxSpeechTokens) +
                               "), stopping generation");
    }
  }
}

std::vector<int64_t> ChatterboxEngine::generateSpeechTokensWithCfg(
    std::vector<int64_t> &inputIds, TensorData<int64_t> &positionIds,
    TensorData<float> &speakerEmbeddings, TensorData<float> &speakerFeatures) {

  int textTokenCount = static_cast<int>(inputIds.size());
  int maxSpeechTokens =
      std::max(MIN_SPEECH_TOKENS, textTokenCount * SPEECH_TO_TEXT_MAX_RATIO);
  maxSpeechTokens = std::min(maxSpeechTokens, MAX_NEW_TOKENS_SPEECH);

  QLOG(Priority::INFO,
       "Text tokens: " + std::to_string(textTokenCount) +
           ", max speech tokens: " + std::to_string(maxSpeechTokens));

  TensorData<float> condEmbs;
  TensorData<float> uncondEmbs;
  TensorData<int64_t> promptToken;
  prepareCfgEmbeddings(inputIds, positionIds.data, condEmbs, uncondEmbs,
                       promptToken, speakerEmbeddings, speakerFeatures);

  const int64_t seqLen = condEmbs.shape[1];
  TensorData<int64_t> attentionMask;
  attentionMask.data.resize(seqLen, 1);
  attentionMask.shape = {1, seqLen};

  std::unordered_map<std::string, TensorData<float>> batchedKv =
      initEmptyKvCache(2);

  std::vector<int64_t> generatedTokens{START_SPEECH_TOKEN};
  runInitialCfgStep(condEmbs, uncondEmbs, positionIds, attentionMask, batchedKv,
                    generatedTokens);

  runCfgGenerationLoop(generatedTokens, positionIds, attentionMask, batchedKv,
                       maxSpeechTokens);

  QLOG(Priority::INFO,
       "CFG generated " + std::to_string(generatedTokens.size()) + " tokens");

  releaseSession(embedTokensSession_);
  releaseSession(languageModelSession_);

  return assembleSpeechTokenSequence(promptToken, generatedTokens);
}

} // namespace qvac::ttslib::chatterbox
