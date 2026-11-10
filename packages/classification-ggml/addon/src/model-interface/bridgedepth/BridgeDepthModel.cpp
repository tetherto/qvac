#include "BridgeDepthModel.hpp"

#include <chrono>
#include <cmath>
#include <exception>
#include <span>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>
#include <stb_image.h>

#include "BridgeDepthGraph.hpp"
#include "model-interface/GgmlBackend.hpp"
#include "model-interface/ImagePreprocessor.hpp"

namespace classification_ggml::bridgedepth {
namespace {

using qvac_errors::StatusError;
using qvac_errors::general_error::InternalError;
using qvac_errors::general_error::InvalidArgument;

void check(bool condition, const std::string& message) {
  if (!condition)
    throw StatusError(InvalidArgument, "BridgeDepth: " + message);
}

} // namespace

void checkSize(uint32_t width, uint32_t height) {
  check(
      width >= static_cast<uint32_t>(MIN_SIDE) &&
          height >= static_cast<uint32_t>(MIN_SIDE),
      "image sides must be at least " + std::to_string(MIN_SIDE) + " pixels");
  check(
      width <= MAX_SIDE && height <= MAX_SIDE,
      "image sides must be at most " + std::to_string(MAX_SIDE) + " pixels");
  check(
      gridCells(width, height) <= MAX_GRID_CELLS,
      "image " + std::to_string(width) + "x" + std::to_string(height) +
          " is too large: at most about 2 MP is supported, (height/8) * "
          "(width/8) after padding to a multiple of 16 must be at most " +
          std::to_string(MAX_GRID_CELLS) + " (1920x1080 fits)");
}

int64_t gridCells(uint32_t width, uint32_t height) {
  const Padding pad = computePadding(
      static_cast<int>(height), static_cast<int>(width), PAD_DIVISOR);
  const int64_t gridStride = 8;
  return (static_cast<int64_t>(height) + pad.top) / gridStride *
         ((static_cast<int64_t>(width) + pad.right) / gridStride);
}

std::vector<float>
toPlanarRgb(const ImageInput& input, uint32_t& width, uint32_t& height) {
  std::span<const uint8_t> rgb(input.data);
  std::vector<uint8_t> decoded;
  if (input.rawRgb) {
    width = input.rawRgb->width;
    height = input.rawRgb->height;
    preprocess::validateRawRgb(rgb, width, height, input.rawRgb->channels);
  } else {
    check(
        preprocess::isEncodedImage(rgb),
        "expects JPEG/PNG or raw RGB with dimensions");
    // The shared decoder accepts up to MAX_IMAGE_DIMENSION per side, so check
    // the header against the much smaller BridgeDepth limits before decoding.
    int headerWidth = 0;
    int headerHeight = 0;
    int headerChannels = 0;
    if (stbi_info_from_memory(
            rgb.data(),
            static_cast<int>(rgb.size()),
            &headerWidth,
            &headerHeight,
            &headerChannels) != 0 &&
        headerWidth > 0 && headerHeight > 0) {
      checkSize(
          static_cast<uint32_t>(headerWidth),
          static_cast<uint32_t>(headerHeight));
    }
    decoded = preprocess::decodeToRgb(rgb, width, height);
    rgb = decoded;
  }
  checkSize(width, height);
  const size_t plane = static_cast<size_t>(width) * height;
  std::vector<float> chw(plane * 3);
  for (size_t i = 0; i < plane; ++i) {
    for (size_t c = 0; c < 3; ++c)
      chw[c * plane + i] = static_cast<float>(rgb[i * 3 + c]);
  }
  return chw;
}

struct BridgeDepthModel::Impl {
  // Declared first so the backends outlive the graph's buffers.
  std::unique_ptr<GgmlBackends> backends;
  std::unique_ptr<BridgeDepthGraph> graph;
};

BridgeDepthModel::BridgeDepthModel(Config config)
    : config_(std::move(config)) {}
BridgeDepthModel::~BridgeDepthModel() = default;

std::unique_ptr<BridgeDepthModel::Impl>
BridgeDepthModel::open(const Config& config, bool measureOnly) {
  check(!config.modelPath.empty(), "modelPath is required");
  check(
      config.threads > 0 && config.threads <= 1024,
      "threads must be between 1 and 1024");
  auto state = std::make_unique<Impl>();
  state->backends = std::make_unique<GgmlBackends>(
      config.backend, config.backendsDir, config.threads, "BridgeDepth");
  try {
    state->graph = std::make_unique<BridgeDepthGraph>(
        config.modelPath,
        state->backends->device(),
        state->backends->cpu(),
        measureOnly ? BridgeDepthGraph::Mode::Measure
                    : BridgeDepthGraph::Mode::Infer);
  } catch (const StatusError&) {
    throw;
  } catch (const ResourceError& error) {
    throw StatusError(InternalError, error.what());
  } catch (const std::exception& error) {
    throw StatusError(InvalidArgument, error.what());
  }
  return state;
}

void BridgeDepthModel::load() {
  std::scoped_lock lock(mutex_);
  if (impl_)
    return;
  impl_ = open(config_, false);
}

MeasuredBuffers BridgeDepthModel::measure(
    const Config& config, uint32_t width, uint32_t height) {
  checkSize(width, height);
  const auto state = open(config, true);
  try {
    MeasuredBuffers result = state->graph->measure(
        static_cast<int>(height), static_cast<int>(width));
    result.deviceName = deviceName(state->backends->device());
    result.deviceIsCpu = state->backends->device() == state->backends->cpu();
    return result;
  } catch (const StatusError&) {
    throw;
  } catch (const std::exception& error) {
    throw StatusError(InternalError, error.what());
  }
}

BufferFootprint BridgeDepthModel::allocatedBuffers() const {
  std::scoped_lock lock(mutex_);
  if (!impl_)
    throw StatusError(InternalError, "BridgeDepth is not loaded");
  return impl_->graph->allocatedBuffers();
}

std::string BridgeDepthModel::getName() const { return "bridgedepth-ggml"; }

std::any BridgeDepthModel::process(const std::any& input) {
  std::scoped_lock lock(mutex_);
  const auto* pair = std::any_cast<StereoInput>(&input);
  check(pair != nullptr, "invalid stereo input type");
  if (!impl_)
    throw StatusError(InternalError, "BridgeDepth is not loaded");
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t rightWidth = 0;
  uint32_t rightHeight = 0;
  // Decoding counts, as MegaLoc's total_time_ms includes its preprocess().
  const auto start = std::chrono::steady_clock::now();
  const auto left = toPlanarRgb(pair->left, width, height);
  const auto right = toPlanarRgb(pair->right, rightWidth, rightHeight);
  check(
      width == rightWidth && height == rightHeight,
      "left and right images must have the same size");
  DisparityOutput output{width, height, {}};
  try {
    output.disparity = impl_->graph->infer(
        left.data(),
        right.data(),
        static_cast<int>(height),
        static_cast<int>(width));
  } catch (const StatusError&) {
    throw;
  } catch (const std::exception& error) {
    throw StatusError(InternalError, error.what());
  }
  for (const float value : output.disparity) {
    if (!std::isfinite(value))
      throw StatusError(
          InternalError, "BridgeDepth produced a non-finite disparity");
  }
  lastInferenceMs_ = std::chrono::duration<double, std::milli>(
                         std::chrono::steady_clock::now() - start)
                         .count();
  return std::any(std::move(output));
}

qvac_lib_inference_addon_cpp::RuntimeStats
BridgeDepthModel::runtimeStats() const {
  std::scoped_lock lock(mutex_);
  qvac_lib_inference_addon_cpp::RuntimeStats result{
      {"total_time_ms", lastInferenceMs_}};
  if (impl_) {
    result.emplace_back(
        "backend_id",
        static_cast<int64_t>(
            backendId(ggml_backend_name(impl_->backends->device()))));
    result.emplace_back(
        "cpu_fallback_nodes",
        static_cast<int64_t>(impl_->graph->cpuFallbackNodes()));
    result.emplace_back(
        "weight_bytes", static_cast<int64_t>(impl_->graph->weightBytes()));
  }
  return result;
}

} // namespace classification_ggml::bridgedepth
