#pragma once

#include <any>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <stack>
#include <vector>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>

#include "StepBoundingBox.hpp"
#include "StepDetectionInference.hpp"
#include "StepRecognizeText.hpp"
#include "Steps.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

// add_margin in python
constexpr float ADD_MARGIN = 0.1F;

// Default pipeline timeout for preventing indefinite blocking when no text is detected
// This should be high enough for normal OCR processing but low enough to prevent hanging
// Note: Large models like Thai (215MB) may need longer for first inference due to model loading
constexpr int PIPELINE_TIMEOUT_SECONDS = 300;

constexpr int DEFAULT_PIPELINE_TIMEOUT_SECONDS = 120;

// Default values matching EasyOCR for compatibility
constexpr float DEFAULT_MAG_RATIO = 1.5F;
constexpr float DEFAULT_LOW_CONF_THRESHOLD = 0.4F;

// Default batch size for recognizer inference (tuned for mobile memory constraints)
constexpr int DEFAULT_RECOGNIZER_BATCH_SIZE = 32;

/**
 * Configuration parameters for OCR pipeline
 * These are set at instance creation and apply to all images
 */
struct PipelineConfig {
  float magRatio{DEFAULT_MAG_RATIO};                        // Detection magnification ratio (1.0-2.0)
  std::vector<int> defaultRotationAngles{90, 270};          // Default rotation angles to try
  bool contrastRetry{false};                                // Retry low-confidence with contrast adjustment (disabled by default for mobile memory)
  float lowConfidenceThreshold{DEFAULT_LOW_CONF_THRESHOLD}; // Threshold for contrast retry
  int recognizerBatchSize{DEFAULT_RECOGNIZER_BATCH_SIZE};   // Batch size for recognizer inference
};

struct PipelineInput {
  int imageWidth{};
  int imageHeight{};
  std::vector<uint8_t> data;
  bool isEncoded{false};  // true for JPEG/PNG that need decoding
  bool paragraph{false};
  std::optional<std::vector<int>> rotationAngles;
  float boxMarginMultiplier{ADD_MARGIN};
};

/**
 * Sequential OCR Pipeline
 *
 * Executes detection, bounding box extraction, and text recognition sequentially.
 * This is simpler and more reliable than a multi-threaded approach since each step
 * depends on the previous step's output anyway.
 */
class Pipeline : public qvac_lib_inference_addon_cpp::model::IModel,
                 public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad,
                 public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  using Input = PipelineInput;
  using InputView = PipelineInput;
  using Output = std::vector<InferredText>;
  using Config = PipelineConfig;

  Pipeline(
      const ORTCHAR_T* pathDetector, const ORTCHAR_T* pathRecognizer,
      std::span<const std::string> langList, bool useGPU = true,
      int timeout = DEFAULT_PIPELINE_TIMEOUT_SECONDS,
      const PipelineConfig& config = PipelineConfig{});

  ~Pipeline() override = default;

  std::any process(const std::any& input) final;

  // Direct process method for internal use
  Output process(Input input);

  void initializeBackend();
  bool isLoaded() const;

  void reset();

  [[nodiscard]] std::string getName() const final { return "Pipeline"; }

  void cancel() const final {
    // Pipeline doesn't support cancellation during processing
  }

  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard) final {
    // Pipeline doesn't support streaming weights
    (void)filename;
    (void)shard;
  }

  void waitForLoadInitialization() final {
    // Pipeline loads synchronously
  }

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

  const PipelineConfig& config() const { return config_; }

private:
  PipelineConfig config_;

  // Sequential pipeline steps (no threading)
  std::unique_ptr<StepDetectionInference> stepDetection_;
  std::unique_ptr<StepBoundingBox> stepBoundingBox_;
  std::unique_ptr<StepRecognizeText> stepRecognition_;

  int timeout_;

  mutable std::mutex processingTimeMtx_;
  mutable std::stack<double> processingTime_;
  mutable std::stack<double> detectionTime_;
  mutable std::stack<double> recognitionTime_;
  mutable std::stack<int> textRegionsCount_;
};

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
