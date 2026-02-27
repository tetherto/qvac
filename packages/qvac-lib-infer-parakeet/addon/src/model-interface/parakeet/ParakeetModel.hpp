#pragma once

#include <functional>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <tuple>
#include <type_traits>
#include <vector>

#include "ParakeetConfig.hpp"
#include "model-interface/ParakeetTypes.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

// Forward declarations for ONNX Runtime
namespace Ort {
class Env;
class Session;
class SessionOptions;
class MemoryInfo;
}  // namespace Ort

namespace qvac_lib_infer_parakeet {

class ParakeetModel {
public:
  using OutputCallback = std::function<void(const Transcript&)>;
  using ValueType = float;
  using Input = std::vector<ValueType>;
  using InputView = std::span<const ValueType>;
  using Output = std::vector<Transcript>;

  explicit ParakeetModel(const ParakeetConfig& config);
  ~ParakeetModel();

  // Disable copy
  ParakeetModel(const ParakeetModel&) = delete;
  ParakeetModel& operator=(const ParakeetModel&) = delete;

  void initializeBackend();
  void setConfig(const ParakeetConfig& config) { cfg_ = config; }
  auto setOnSegmentCallback(const OutputCallback& callback) -> void { on_segment_ = callback; }
  auto addTranscription(const Transcript& transcript) -> void { output_.push_back(transcript); }

  void process(const Input& input);
  Output process(const Input& input, std::function<void(const Output&)> callback);

  void load();
  void unload();
  void unloadWeights() { unload(); }
  void reload() { unload(); load(); }
  void reset() {
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
    eouState_.initialized = false;
  }
  void endOfStream() { stream_ended_ = true; }
  bool isStreamEnded() const { return stream_ended_; }
  bool isLoaded() const { return is_loaded_; }
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats();
  void warmup();

  static std::vector<float> preprocessAudioData(
      const std::vector<uint8_t>& audioData,
      const std::string& audioFormat = "s16le");

  void saveLoadParams(const ParakeetConfig& config) { cfg_ = config; }

  template <typename T, typename... Args>
  typename std::enable_if<
      !std::is_same<typename std::decay<T>::type, ParakeetConfig>::value,
      void>::type
  saveLoadParams(T&&, Args&&...) {}

  void set_weights_for_file(
      const std::string& filename,
      const std::span<const uint8_t>& contents, bool completed);

  // Streambuf version used by base Addon class
  void set_weights_for_file(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>> streambuf);

  template <typename T>
  void set_weights_for_file(const std::string& filename, T&& contents) {}

  std::string getName() const {
    switch (cfg_.modelType) {
      case ModelType::CTC: return "Parakeet-CTC";
      case ModelType::TDT: return "Parakeet-TDT";
      case ModelType::EOU: return "Parakeet-EOU";
      case ModelType::SORTFORMER: return "Parakeet-Sortformer";
      default: return "Parakeet";
    }
  }

private:
  // Audio preprocessing - compute mel-spectrogram features using ONNX preprocessor
  std::pair<std::vector<float>, int64_t> runPreprocessor(const Input& audio);
  
  // Fallback: manual mel-spectrogram computation
  std::vector<float> computeMelSpectrogram(const Input& audio, int numMelBins = MEL_BINS);
  
  // Run encoder inference (alreadyTransposed=true for ONNX preprocessor output)
  std::vector<float> runEncoder(const std::vector<float>& melFeatures, 
                                 int64_t numFrames,
                                 int64_t& encodedLength,
                                 bool alreadyTransposed = false);
  
  // Run greedy transducer decoding (TDT)
  std::string greedyDecode(const std::vector<float>& encoderOutput,
                           int64_t encodedLength);

  // CTC inference pipeline
  std::string runCTCInferencePipeline(const Input& audio);
  std::vector<float> runCTCModel(const std::vector<float>& melFeatures,
                                  int64_t numFrames);
  std::string ctcGreedyDecode(const std::vector<float>& logits,
                               int64_t numFrames);

  // EOU inference pipeline (interleaved streaming encoder+decoder)
  std::string runEOUInferencePipeline(const Input& audio);
  void resetEOUStreamingState();
  std::vector<float> eouEncodeChunk(const std::vector<float>& melChunk,
                                     int64_t chunkFrames,
                                     int64_t& outFrames);
  std::string eouDecodeChunk(const std::vector<float>& encoderOutput,
                              int64_t encodedFrames, int& eouCount);

  // Sortformer speaker diarization pipeline
  std::string runSortformerPipeline(const Input& audio);
  std::vector<float> runSortformerChunked(const std::vector<float>& melFeatures,
                                           int64_t numFrames);
  std::vector<float> medianFilter(const std::vector<float>& preds,
                                   int64_t numFrames, int numSpeakers);
  std::vector<SpeakerSegment> binarizePredictions(const std::vector<float>& preds,
                                                    int64_t numFrames);

  // Load vocabulary from file
  void loadVocabulary(const std::vector<uint8_t>& vocabData);

  // Load vocabulary from tokenizer.json (CTC/EOU models)
  void loadTokenizerJson(const std::vector<uint8_t>& data);

  std::tuple<std::vector<float>, int64_t, bool>
  computeFeatures(const Input &audio);

  std::string runInferencePipeline(const Input &audio);

  ParakeetConfig cfg_;
  OutputCallback on_segment_;
  Output output_;
  bool stream_ended_ = false;
  bool is_loaded_ = false;
  bool is_warmed_up_ = false;

  // ONNX Runtime members
  std::unique_ptr<Ort::Env> ort_env_;
  std::unique_ptr<Ort::Session> preprocessor_session_;  // ONNX mel spectrogram
  std::unique_ptr<Ort::Session> encoder_session_;        // TDT/EOU encoder
  std::unique_ptr<Ort::Session> decoder_session_;        // TDT/EOU decoder/joiner
  std::unique_ptr<Ort::Session> ctc_session_;            // CTC single model
  std::unique_ptr<Ort::Session> sortformer_session_;    // Sortformer diarization
  std::unique_ptr<Ort::MemoryInfo> memory_info_;
  
  // Model weights storage (before loading)
  std::map<std::string, std::vector<uint8_t>> model_weights_;
  
  // Vocabulary
  std::vector<std::string> vocab_;
  
  // Special token indices (from vocab.txt)
  static constexpr int64_t BLANK_TOKEN = 8192;  // <blk> - last token in vocab
  static constexpr int64_t PAD_TOKEN = 2;       // <pad>
  static constexpr int64_t EOS_TOKEN = 3;       // <|endoftext|>
  static constexpr int64_t NOSPEECH_TOKEN = 1;  // <|nospeech|>
  static constexpr int64_t START_TRANSCRIPT = 4; // <|startoftranscript|>
  static constexpr int64_t PREDICT_LANG = 22;   // <|predict_lang|>
  
  // Language token indices (ISO 639-1 codes)
  int64_t getLanguageToken(const std::string& langCode) const;
  
  // Mel-spectrogram parameters (parakeet-tdt-0.6b-v3 uses 128 mel bins)
  static constexpr int MEL_BINS = 128;         // TDT feature_size
  static constexpr int CTC_MEL_BINS = 80;      // CTC feature_size
  static constexpr int FFT_SIZE = 512;         // n_fft
  static constexpr int HOP_LENGTH = 160;       // hop_length (10ms at 16kHz)
  static constexpr int WIN_LENGTH = 400;       // win_length (25ms at 16kHz)
  static constexpr float SAMPLE_RATE = 16000.0f;

  // CTC-specific constants
  static constexpr int64_t CTC_BLANK_TOKEN = 1024;  // <pad> token in CTC vocab
  
  // Encoder output dimension
  static constexpr int ENCODER_DIM = 1024;          // TDT encoder dim
  
  // Decoder state dimension
  static constexpr int DECODER_STATE_DIM = 640;

  // EOU-specific constants (FastConformer-RNNT 120M)
  static constexpr int EOU_ENCODER_DIM = 512;
  static constexpr int EOU_DECODER_STATE_DIM = 640;
  static constexpr int EOU_NUM_LAYERS = 17;
  static constexpr int EOU_CACHE_LOOKBACK = 70;
  static constexpr int EOU_CACHE_TIME_STEPS = 8;
  static constexpr int EOU_ENCODER_CHUNK_FRAMES = 25;
  static constexpr int EOU_MAX_SYMBOLS_PER_STEP = 5;

  // Sortformer constants (streaming speaker diarization)
  static constexpr int SF_NUM_SPEAKERS = 4;
  static constexpr int SF_EMB_DIM = 512;
  static constexpr int SF_CHUNK_LEN = 124;
  static constexpr int SF_FIFO_LEN = 124;
  static constexpr int SF_SPKCACHE_LEN = 188;
  static constexpr int SF_SUBSAMPLING = 8;
  static constexpr float SF_FRAME_DURATION = 0.08f;

  DiarizationConfig diarConfig_;

  // Persistent EOU streaming state (carried across encoder/decoder chunks)
  struct EOUStreamState {
    std::vector<float> cacheChan;
    std::vector<float> cacheTime;
    std::vector<int64_t> cacheChanLen;
    std::vector<float> stateH;
    std::vector<float> stateC;
    int32_t lastToken = 0;
    int64_t eouId = -1;
    int64_t blankId = -1;
    bool initialized = false;
  };
  EOUStreamState eouState_;
  
  int melBinsForModel() const {
    return cfg_.modelType == ModelType::CTC ? CTC_MEL_BINS : MEL_BINS;
  }

  // Track processed audio time
  float processed_time_ = 0.0f;
  
  // Stats tracking
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
};

} // namespace qvac_lib_infer_parakeet
