#pragma once

#include <any>
#include <cstdint>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "model-interface/ImageInput.hpp"
#include "model-interface/ModelFootprint.hpp"
#include "model-interface/bridgedepth/BridgeDepthGraph.hpp"

namespace classification_ggml::bridgedepth {

// The model runs on at most 1280x720, or 720x1280 for a portrait pair. The
// model authors recommend downsampling inputs above 720p, for speed and for
// accuracy, so a larger pair is downsampled to fit inside this box and the
// disparity is resized back. The graph memory is the same both ways round.
inline constexpr uint32_t MAX_MODEL_WIDTH = 1280;
inline constexpr uint32_t MAX_MODEL_HEIGHT = 720;

// Largest accepted side, enough for 4K (3840x2160) and 12 MP (4000x3000)
// photos. The graph only sees the downsampled pair; the host buffers at the
// input size (the input copies, decoding, the returned disparity) grow with
// it, and BridgeDepthModel::measure counts them.
inline constexpr uint32_t MAX_SIDE = 4096;
// Throws InvalidArgument unless the size is one inference accepts.
void checkSize(uint32_t width, uint32_t height);

struct ImageSize {
  uint32_t width = 0;
  uint32_t height = 0;
  bool operator==(const ImageSize&) const = default;
};

// The size the model runs an accepted width x height pair at: unchanged when
// it fits inside MAX_MODEL_WIDTH x MAX_MODEL_HEIGHT (swapped for a portrait
// pair), otherwise scaled by one factor, rounded, to fit inside it. A side the
// scaling would take below MIN_SIDE stays at MIN_SIDE.
ImageSize modelInputSize(uint32_t width, uint32_t height);

// Host memory a job on an accepted width x height pair holds outside the
// graph, by phase, at the largest input kind: both views copied from JS as raw
// RGB, the stb_image decode peak of one view next to the other planar view,
// the disparity resized back to the input, and its copy to JS.
CallerHostBytes callerHostBytes(uint32_t width, uint32_t height);

// Packed RGB `rgb` of `from` to [3, to.height, to.width] floats in 0..255.
// A size change is bilinear with pixel centres aligned and the result rounded
// to whole values: the sampling of the cv2.resize INTER_LINEAR on 8-bit images
// the upstream demo.py downsamples with, within 1 of it since cv2 uses 11-bit
// fixed-point weights. Not stb_image_resize2, whose default downsample filter
// is Mitchell, not two-tap bilinear.
std::vector<float>
resizeToPlanar(std::span<const uint8_t> rgb, ImageSize from, ImageSize to);

// Bilinear resize of a [from.height, from.width] disparity to `to`, with the
// values multiplied by to.width / from.width so they stay in pixels of `to`.
std::vector<float> resizeDisparity(
    const std::vector<float>& disparity, ImageSize from, ImageSize to);

struct Config {
  std::string modelPath;
  std::string backendsDir;
  std::string backend;
  int threads = DEFAULT_THREADS;
};

// A rectified stereo pair. Both images must have the same size.
struct StereoInput {
  ImageInput left;
  ImageInput right;
};

// Disparity of the left image in input pixels, row-major [height, width].
struct DisparityOutput {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<float> disparity;
};

// Decodes or validates one view and returns it as [3, h, w] floats in 0..255
// at its own size, without the downsample. A test helper: inference goes
// through modelInputSize(), and the graph aborts on a grid above about 2 MP.
std::vector<float>
toPlanarRgb(const ImageInput& input, uint32_t& width, uint32_t& height);

class BridgeDepthModel : public qvac_lib_inference_addon_cpp::model::IModel {
public:
  explicit BridgeDepthModel(Config config);
  ~BridgeDepthModel() override;
  BridgeDepthModel(const BridgeDepthModel&) = delete;
  BridgeDepthModel& operator=(const BridgeDepthModel&) = delete;

  void load();
  [[nodiscard]] std::string getName() const override;
  std::any process(const std::any& input) override;
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const override;

  // The buffers a load with `config` plus one inference of a width x height
  // pair would allocate, the graph sized at modelInputSize(). Reads only GGUF
  // metadata and allocates none of them.
  static MeasuredBuffers
  measure(const Config& config, uint32_t width, uint32_t height);
  // The buffers this loaded model holds, see BridgeDepthGraph.
  [[nodiscard]] BufferFootprint allocatedBuffers() const;

private:
  struct Impl;
  static std::unique_ptr<Impl> open(const Config& config, bool measureOnly);
  std::unique_ptr<Impl> impl_;
  Config config_;
  mutable std::mutex mutex_;
  double lastInferenceMs_ = 0;
};

} // namespace classification_ggml::bridgedepth
