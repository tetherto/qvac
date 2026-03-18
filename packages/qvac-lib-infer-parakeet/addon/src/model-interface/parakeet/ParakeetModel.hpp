#pragma once

#include <any>
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <span>
#include <streambuf>
#include <string>
#include <tuple>
#include <type_traits>
#include <vector>

#include "ParakeetConfig.hpp"
#include "model-interface/ParakeetTypes.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

namespace Ort {
class Env;
class Session;
class SessionOptions;
class MemoryInfo;
} // namespace Ort

namespace qvac_lib_infer_parakeet {

class ParakeetModel : public qvac_lib_inference_addon_cpp::model::IModel,
                      public qvac_lib_inference_addon_cpp::model::IModelCancel,
                      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using OutputCallback = std::function<void(const Transcript&)>;
  using ValueType = float;
  using Input = std::vector<ValueType>;
  using InputView = std::span<const ValueType>;
  using Output = std::vector<Transcript>;
  struct AnyInput {
    Input input;
  };

  struct MelFilter {
    int startBin;
    int endBin;
    std::vector<float> weights;
  };

  explicit ParakeetModel(const ParakeetConfig& config);
  ~ParakeetModel();

  ParakeetModel(const ParakeetModel&) = delete;
  ParakeetModel& operator=(const ParakeetModel&) = delete;
  ParakeetModel(ParakeetModel&&) = delete;
  ParakeetModel& operator=(ParakeetModel&&) = delete;

  // ── Lifecycle ──────────────────────────────────────────────────────────
  void initializeBackend();
  void load();
  void unload();
  void unloadWeights() { unload(); }
  void reload();
  void reset();
  void endOfStream() { stream_ended_ = true; }
  bool isStreamEnded() const { return stream_ended_; }
  bool isLoaded() const { return is_loaded_; }
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;
  std::any process(const std::any& input) override;
  std::string getName() const override;
  void cancel() const override;
  void warmup();

  // ── Processing ─────────────────────────────────────────────────────────
  void process(const Input& input);
  Output
  process(const Input& input, std::function<void(const Output&)> callback);

  // ── Configuration ──────────────────────────────────────────────────────
  void setConfig(const ParakeetConfig& config) { cfg_ = config; }
  void setOnSegmentCallback(const OutputCallback& callback) {
    on_segment_ = callback;
  }
  void addTranscription(const Transcript& transcript) {
    output_.push_back(transcript);
  }

  void saveLoadParams(const ParakeetConfig& config) { cfg_ = config; }

  template <typename T, typename... Args>
  typename std::enable_if<
      !std::is_same<typename std::decay<T>::type, ParakeetConfig>::value,
      void>::type
  saveLoadParams(T&&, Args&&...) {}

  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& streambuf) override;
  void waitForLoadInitialization() override { load(); }
  // ── Weight loading ─────────────────────────────────────────────────────
  void set_weights_for_file(
      const std::string& filename, std::span<const uint8_t> contents,
      bool completed);

  void set_weights_for_file(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>> streambuf);

  template <typename T>
  void set_weights_for_file(const std::string& filename, T&& contents) {}

  // ── Queries ────────────────────────────────────────────────────────────
  [[nodiscard]] std::string getDisplayName() const { return getName(); }
  [[nodiscard]] static std::vector<float> preprocessAudioData(
      const std::vector<uint8_t>& audioData,
      const std::string& audioFormat = "s16le");

private:
  // ── Session loading helpers ─────────────────────────────────────────────
  void loadCTCSessions(Ort::SessionOptions& options);
  void loadEOUSessions(Ort::SessionOptions& options);
  void loadSortformerSessions(Ort::SessionOptions& options);
  void loadTDTSessions(Ort::SessionOptions& options);

  // ── Shared utilities ───────────────────────────────────────────────────
  void dispatchWeightFile(const std::string& filename);
  std::string tokensToString(const std::vector<int64_t>& tokens) const;
  void loadVocabulary(const std::vector<uint8_t>& vocabData);
  void loadTokenizerJson(const std::vector<uint8_t>& data);
  [[nodiscard]] int64_t getLanguageToken(const std::string& langCode) const;

  // ── Feature extraction ─────────────────────────────────────────────────
  std::pair<std::vector<float>, int64_t> runPreprocessor(const Input& audio);
  std::vector<float>
  computeMelSpectrogram(const Input& audio, int numMelBins = MEL_BINS);
  void stftMelEnergies(
      const float* source, size_t sourceLen, size_t numFrames, int numMelBins,
      float logGuard, const std::vector<MelFilter>& melFilterbank,
      std::vector<float>& melSpec);
  static void
  applyCMVN(std::vector<float>& melSpec, size_t numFrames, int numMelBins);

  // ── Per-model-type pipelines ───────────────────────────────────────────
  std::string runInferencePipeline(const Input& audio);
  std::string processTDT(const Input& input);
  std::string processCTC(const Input& input);
  std::string processEOU(const Input& input);
  std::string processSortformer(const Input& input);

  // ── TDT transducer ─────────────────────────────────────────────────────
  std::vector<float> runEncoder(
      const std::vector<float>& melFeatures, int64_t numFrames,
      int64_t& encodedLength, bool alreadyTransposed = false);
  std::string
  greedyDecode(const std::vector<float>& encoderOutput, int64_t encodedLength);

  // ── CTC ────────────────────────────────────────────────────────────────
  std::vector<float>
  runCTCModel(const std::vector<float>& melFeatures, int64_t numFrames);
  std::string
  ctcGreedyDecode(const std::vector<float>& logits, int64_t numFrames);

  // ── EOU streaming ──────────────────────────────────────────────────────
  void resetEOUStreamingState();
  std::vector<float> eouEncodeChunk(
      const std::vector<float>& melChunk, int64_t chunkFrames,
      int64_t& outFrames);
  std::string eouDecodeChunk(
      const std::vector<float>& encoderOutput, int64_t encodedFrames,
      int& eouCount);

  // ── Sortformer diarization ─────────────────────────────────────────────
  std::string runSortformerFromMel(
      const std::vector<float>& melFeatures, int64_t numFrames);
  std::vector<float> runSortformerChunked(
      const std::vector<float>& melFeatures, int64_t numFrames);
  std::vector<float> medianFilter(
      const std::vector<float>& preds, int64_t numFrames,
      int numSpeakers) const;
  std::vector<SpeakerSegment>
  binarizePredictions(const std::vector<float>& preds, int64_t numFrames) const;

  // ── State ──────────────────────────────────────────────────────────────
  ParakeetConfig cfg_;
  OutputCallback on_segment_;
  Output output_;
  bool stream_ended_ = false;
  bool is_loaded_ = false;
  bool is_warmed_up_ = false;

  // ── ONNX Runtime ───────────────────────────────────────────────────────
  std::unique_ptr<Ort::Env> ort_env_;
  std::unique_ptr<Ort::Session> preprocessor_session_;
  std::unique_ptr<Ort::Session> encoder_session_;
  std::unique_ptr<Ort::Session> decoder_session_;
  std::unique_ptr<Ort::Session> ctc_session_;
  std::unique_ptr<Ort::Session> sortformer_session_;
  std::unique_ptr<Ort::MemoryInfo> memory_info_;

  std::map<std::string, std::vector<uint8_t>> model_weights_;

  // ── Vocabulary ─────────────────────────────────────────────────────────
  std::vector<std::string> vocab_;

  // ── Token constants ────────────────────────────────────────────────────
  static constexpr int64_t BLANK_TOKEN = 8192;
  static constexpr int64_t PAD_TOKEN = 2;
  static constexpr int64_t EOS_TOKEN = 3;
  static constexpr int64_t NOSPEECH_TOKEN = 1;
  static constexpr int64_t PREDICT_LANG = 22;
  static constexpr int64_t CTC_BLANK_TOKEN = 1024;
  static constexpr int64_t EOU_FALLBACK_TOKEN = 1024;

  // ── Error return strings (non-exception feedback to callers) ───────────
  static constexpr const char* ERR_NO_SPEECH = "[No speech detected]";
  static constexpr const char* ERR_AUDIO_SHORT = "[Audio too short]";
  static constexpr const char* ERR_MODEL_NOT_READY = "[Model not ready]";
  static constexpr const char* ERR_MODEL_NOT_LOADED = "[Model not loaded]";
  static constexpr const char* ERR_INFERENCE = "[Inference error]";
  static constexpr const char* ERR_NO_SPEAKERS = "[No speakers detected]";

  static bool isSentinel(const std::string& text) {
    return text == ERR_NO_SPEECH || text == ERR_AUDIO_SHORT ||
           text == ERR_MODEL_NOT_READY || text == ERR_MODEL_NOT_LOADED ||
           text == ERR_INFERENCE || text == ERR_NO_SPEAKERS;
  }

  // ── Audio / mel constants ──────────────────────────────────────────────
  static constexpr int MEL_BINS = 128;
  static constexpr int CTC_MEL_BINS = 80;
  static constexpr int FFT_SIZE = 512;
  static constexpr int HOP_LENGTH = 160;
  static constexpr int WIN_LENGTH = 400;
  static constexpr float SAMPLE_RATE = 16000.0f;

  // ── Encoder / decoder dimensions ───────────────────────────────────────
  static constexpr int ENCODER_DIM = 1024;
  static constexpr int DECODER_STATE_DIM = 640;
  static constexpr int TDT_DECODER_LSTM_LAYERS = 2;
  static constexpr int EOU_DECODER_LSTM_LAYERS = 1;

  // ── EOU (FastConformer-RNNT 120M) ─────────────────────────────────────
  static constexpr int EOU_ENCODER_DIM = 512;
  static constexpr int EOU_DECODER_STATE_DIM = 640;
  static constexpr int EOU_NUM_LAYERS = 17;
  static constexpr int EOU_CACHE_LOOKBACK = 70;
  static constexpr int EOU_CACHE_TIME_STEPS = 8;
  static constexpr int EOU_ENCODER_CHUNK_FRAMES = 25;
  static constexpr int EOU_MAX_SYMBOLS_PER_STEP = 5;
  static constexpr int64_t EOU_MIN_ENCODER_FRAMES = 10;

  // ── Sortformer ─────────────────────────────────────────────────────────
  static constexpr int SF_NUM_SPEAKERS = 4;
  static constexpr int SF_EMB_DIM = 512;
  static constexpr int SF_CHUNK_LEN = 124;
  static constexpr int SF_FIFO_LEN = 124;
  static constexpr int SF_SPKCACHE_LEN = 188;
  static constexpr int SF_SUBSAMPLING = 8;
  static constexpr float SF_FRAME_DURATION = 0.08f;

  DiarizationConfig diarConfig_;

  struct EOUStreamState {
    std::vector<float> cacheChan;
    std::vector<float> cacheTime;
    std::vector<int64_t> cacheChanLen;
    std::vector<float> stateH;
    std::vector<float> stateC;
    int32_t lastToken = -1;
    int64_t eouId = -1;
    int64_t blankId = -1;
    bool initialized = false;
  };
  EOUStreamState eouState_;

  float processed_time_ = 0.0f;

  // ── Mel filterbank cache ────────────────────────────────────────────────
  struct FilterbankKey {
    int melBins;
    bool slaney;
    bool operator<(const FilterbankKey& o) const {
      return std::tie(melBins, slaney) < std::tie(o.melBins, o.slaney);
    }
  };
  std::map<FilterbankKey, std::vector<MelFilter>> filterbanks_;

  // ── Runtime stats ──────────────────────────────────────────────────────
  int64_t totalSamples_ = 0;
  int64_t totalTokens_ = 0;
  int64_t totalTranscriptions_ = 0;
  int64_t processCalls_ = 0;
  int64_t totalWallMs_ = 0;
  int64_t modelLoadMs_ = 0;
  int64_t melSpecMs_ = 0;
  int64_t encoderMs_ = 0;
  int64_t decoderMs_ = 0;
  int64_t totalMelFrames_ = 0;
  int64_t totalEncodedFrames_ = 0;
  mutable std::atomic_bool cancelRequested_ = false;
};

} // namespace qvac_lib_infer_parakeet
