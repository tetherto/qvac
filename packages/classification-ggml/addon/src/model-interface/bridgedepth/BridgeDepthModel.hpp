#pragma once

#include <any>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "model-interface/ImageInput.hpp"
#include "model-interface/ModelFootprint.hpp"

namespace classification_ggml::bridgedepth {

// Largest accepted side. MAX_GRID_CELLS bounds the pixel count; the model
// authors recommend downsampling inputs above 720p.
inline constexpr uint32_t MAX_SIDE = 2048;

// Largest (H/8) * (W/8) after padding to a multiple of 16, about 2 MP. Above
// it ggml aborts the process instead of returning an error: Metal past
// INT16_MAX (2048x1088), CUDA and Vulkan at 65536 (2048x2048). 1920x1088 is
// 32640.
inline constexpr int64_t MAX_GRID_CELLS = 32767;
int64_t gridCells(uint32_t width, uint32_t height);
// Throws InvalidArgument unless the size is one inference accepts.
void checkSize(uint32_t width, uint32_t height);

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

// Decodes or validates one view and returns it as [3, h, w] floats in 0..255.
std::vector<float>
toPlanarRgb(const ImageInput& input, uint32_t& width, uint32_t& height);

class BridgeDepthGraph;
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
  // pair would allocate. Reads only GGUF metadata and allocates none of them.
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
