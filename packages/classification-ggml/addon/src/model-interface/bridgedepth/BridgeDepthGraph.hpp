#pragma once

// BridgeDepth stereo disparity, rvc_pretrain checkpoint with the Depth Anything
// V2 ViT-S mono branch. Weights come from scripts/convert-bridgedepth.py. The
// graph only depends on ggml; backend selection and input decoding live in
// BridgeDepthModel.

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <ggml-backend.h>

#include "model-interface/ModelFootprint.hpp"

namespace classification_ggml::bridgedepth {

// Inputs are padded to a multiple of this on the top and the right.
inline constexpr int PAD_DIVISOR = 16;
// Smallest side accepted; the mono patch grid is H/16 x W/16 after padding.
inline constexpr int MIN_SIDE = 32;

// InputPadder(mode="nmrf"): replicate padding on the top and the right only.
struct Padding {
  int top = 0;
  int right = 0;
};
Padding computePadding(int h, int w, int divisor);
// `chw` is [3, h, w]; returns [3, h + top, w + right].
std::vector<float> padImage(const float* chw, int h, int w, Padding pad);
// Same, written to `out`, which holds 3 * (h + top) * (w + right) floats.
void padImageInto(const float* chw, int h, int w, Padding pad, float* out);

// DINOv2 interpolate_pos_encoding with bicubic resampling. `table` is
// [1 + grid * grid, D] (class token first); returns [1 + ph * pw, D]. At
// ph == pw == grid it returns `table` unchanged, as DINOv2 does.
std::vector<float>
interpolatePosEmbed(const std::vector<float>& table, int grid, int ph, int pw);

// Device or memory failures, as opposed to a bad file or input.
struct ResourceError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

class BridgeDepthGraph {
public:
  // `device` and `cpu` stay owned by the caller and must outlive the graph;
  // they may be the same backend.
  // Mode::Measure reads only the GGUF metadata and allocates no weight or
  // compute buffer: measure() works, infer() throws.
  enum class Mode { Infer, Measure };
  BridgeDepthGraph(
      const std::string& ggufPath, ggml_backend_t device, ggml_backend_t cpu,
      Mode mode = Mode::Infer);
  ~BridgeDepthGraph();
  BridgeDepthGraph(const BridgeDepthGraph&) = delete;
  BridgeDepthGraph& operator=(const BridgeDepthGraph&) = delete;

  // Images are unpadded [3, h, w] RGB in 0..255. Returns the [h, w] disparity
  // of the left image in input pixels. `seedsOverride` ([H/8 * W/8, N] after
  // padding) replaces the DPN top-k seeds; tests use it to remove top-k tie
  // breaks from a comparison with the reference.
  std::vector<float> infer(
      const float* left, const float* right, int h, int w,
      const std::vector<float>* seedsOverride = nullptr);

  // Mode::Measure only. The buffers the load plus one infer() of an h x w
  // pair on a fresh graph would allocate, sized from the same graph infer()
  // builds. `extraRunHostBytes` is host memory the caller holds during the
  // run on top of the views and the disparity, counted in the inference phase.
  MeasuredBuffers measure(int h, int w, uint64_t extraRunHostBytes = 0);
  // The buffers held after the last infer(). The scheduler buffers only grow,
  // so after several sizes this is the largest need of each buffer.
  [[nodiscard]] BufferFootprint allocatedBuffers() const;

  [[nodiscard]] size_t weightBytes() const;
  // Compute nodes the scheduler put on the CPU in the last run while a non-CPU
  // device was selected.
  [[nodiscard]] int cpuFallbackNodes() const;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace classification_ggml::bridgedepth
