#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <streambuf>
#include <string>
#include <vector>

#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/moss/MossTranscribeConfig.hpp"

namespace parakeet::moss {
class TranscribeEngine;
struct TranscribeOptions;
struct TranscribeRequest;
struct TranscribeResult;
struct TranscriptSegment;
} // namespace parakeet::moss

namespace qvac::asrggml::moss {

inline constexpr int MOSS_TRANSCRIBE_SAMPLE_RATE = 16000;

class MossTranscribeModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using Output = std::vector<parakeet::Transcript>;
  struct Progress {
    int generatedTokens;
    int maxNewTokens;
  };
  using ProgressCallback = std::function<void(const Progress&)>;
  void setOnProgressCallback(ProgressCallback callback) {
    onProgress_ = std::move(callback);
  }

  struct AnyInput {
    std::vector<float> samples;
    MossTranscribeRequest request;
  };

  explicit MossTranscribeModel(MossTranscribeConfig config);
  ~MossTranscribeModel() noexcept override;

  std::string getName() const override { return "MossTranscribeModel"; }
  std::any process(const std::any& input) override;
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;

  void cancel() const override;

  void load();
  void unload();
  bool isLoaded() const {
    std::lock_guard lk(engineMu_);
    return static_cast<bool>(engine_);
  }

  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(
      const std::string&,
      std::unique_ptr<std::basic_streambuf<char>>&&) override {}

  const MossTranscribeConfig& config() const { return cfg_; }
  int getBackendId() const { return backendId_; }
  int getBackendDeviceClass() const { return backendDevice_; }
  const std::string& getBackendName() const { return backendName_; }
  const std::string& getBackendDescription() const {
    return backendDescription_;
  }
  bool getEncoderOnCoreml() const { return encoderOnCoreml_; }
  std::string getEncoderBackend() const {
    return encoderOnCoreml_ ? "coreml" : backendName_;
  }

  static void validateConfig(const MossTranscribeConfig& cfg);
  static ::parakeet::moss::TranscribeOptions
  toEngineOptions(const MossTranscribeConfig& cfg);
  static ::parakeet::moss::TranscribeRequest
  toEngineRequest(const MossTranscribeRequest& request);
  static Output toTranscripts(const ::parakeet::moss::TranscribeResult& result);
  static int speakerIdOf(const std::string& label);

private:
  static const AnyInput& requireAnyInput(const std::any& input);
  void claimJob();
  std::shared_ptr<::parakeet::moss::TranscribeEngine> snapshot() const;
  void requireCompleted(const ::parakeet::moss::TranscribeResult& result) const;
  ::parakeet::moss::TranscribeResult runEngine(
      ::parakeet::moss::TranscribeEngine& engine, const AnyInput& input) const;
  Output transcribe(const AnyInput& input);
  void recordStats(
      double seconds, size_t samples,
      const ::parakeet::moss::TranscribeResult& result);

  MossTranscribeConfig cfg_;

  mutable std::mutex engineMu_;
  std::shared_ptr<::parakeet::moss::TranscribeEngine> engine_;

  std::atomic_bool jobInProgress_{false};
  mutable std::atomic_bool cancelRequested_{false};

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  double realTimeFactor_ = 0.0;
  int64_t segments_ = 0;
  int64_t audioTokens_ = 0;
  int64_t promptTokens_ = 0;
  int64_t generatedTokens_ = 0;
  double encodeMs_ = 0.0;
  double prefillMs_ = 0.0;
  double decodeMs_ = 0.0;
  std::optional<int64_t> encoderUsedCoreml_;
  bool encoderOnCoreml_ = false;
  std::string backendDescription_;
  ProgressCallback onProgress_;

  int backendDevice_ = 0;
  int backendId_ = 0;
  std::string backendName_ = "CPU";
};

} // namespace qvac::asrggml::moss
