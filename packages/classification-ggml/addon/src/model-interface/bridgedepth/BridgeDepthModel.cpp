#include "BridgeDepthModel.hpp"

#include <algorithm>
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
}

namespace {

// Decodes or validates one view. Returns its packed RGB, held in `storage`
// when it had to be decoded.
std::span<const uint8_t> decodeView(
    const ImageInput& input, std::vector<uint8_t>& storage, ImageSize& size) {
  std::span<const uint8_t> rgb(input.data);
  if (input.rawRgb) {
    size = {input.rawRgb->width, input.rawRgb->height};
    preprocess::validateRawRgb(
        rgb, size.width, size.height, input.rawRgb->channels);
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
    storage = preprocess::decodeToRgb(rgb, size.width, size.height);
    rgb = storage;
  }
  checkSize(size.width, size.height);
  return rgb;
}

// Source taps of one output axis for a bilinear resize with pixel centres
// aligned: out x samples src (x + 0.5) * srcLen / dstLen - 0.5, clamped to the
// edge pixels.
struct Taps {
  std::vector<uint32_t> low;
  std::vector<uint32_t> high;
  std::vector<float> weight;
};

Taps bilinearTaps(uint32_t srcLen, uint32_t dstLen) {
  Taps taps;
  taps.low.resize(dstLen);
  taps.high.resize(dstLen);
  taps.weight.resize(dstLen);
  const double scale = static_cast<double>(srcLen) / dstLen;
  constexpr double pixelCentre = 0.5;
  for (uint32_t i = 0; i < dstLen; ++i) {
    const double pos = std::clamp(
        (i + pixelCentre) * scale - pixelCentre,
        0.0,
        static_cast<double>(srcLen - 1));
    const auto low = static_cast<uint32_t>(pos);
    taps.low[i] = low;
    taps.high[i] = std::min(low + 1, srcLen - 1);
    taps.weight[i] = static_cast<float>(pos - low);
  }
  return taps;
}

// Bilinear resize of `planes` planes of `from`, each read by `at(plane,
// index)`, to `to`; `store(plane, index, value)` writes each output value.
template <typename Load, typename Store>
void resizeBilinear(
    ImageSize from, ImageSize to, size_t planes, const Load& at,
    const Store& store) {
  const Taps xs = bilinearTaps(from.width, to.width);
  const Taps ys = bilinearTaps(from.height, to.height);
  for (size_t c = 0; c < planes; ++c) {
    for (uint32_t y = 0; y < to.height; ++y) {
      const size_t rowLow = static_cast<size_t>(ys.low[y]) * from.width;
      const size_t rowHigh = static_cast<size_t>(ys.high[y]) * from.width;
      const float wy = ys.weight[y];
      for (uint32_t x = 0; x < to.width; ++x) {
        const float wx = xs.weight[x];
        const float top = at(c, rowLow + xs.low[x]) * (1 - wx) +
                          at(c, rowLow + xs.high[x]) * wx;
        const float bottom = at(c, rowHigh + xs.low[x]) * (1 - wx) +
                             at(c, rowHigh + xs.high[x]) * wx;
        store(
            c,
            static_cast<size_t>(y) * to.width + x,
            top * (1 - wy) + bottom * wy);
      }
    }
  }
}

constexpr size_t RGB_CHANNELS = 3;

// The resize helpers are exported, so a caller passing a buffer that does not
// match its stated size gets an error instead of an out-of-bounds read.
void checkLength(size_t actual, size_t expected, const char* what) {
  if (actual != expected)
    throw StatusError(
        InternalError,
        std::string("BridgeDepth: ") + what + " has " + std::to_string(actual) +
            " values, expected " + std::to_string(expected));
}

} // namespace

ImageSize modelInputSize(uint32_t width, uint32_t height) {
  if (width <= MAX_MODEL_WIDTH && height <= MAX_MODEL_HEIGHT)
    return {width, height};
  // Integer arithmetic so the limited side lands exactly on the box edge and
  // the other is rounded to the nearest pixel.
  const uint64_t w = width;
  const uint64_t h = height;
  ImageSize size;
  if (w * MAX_MODEL_HEIGHT >= h * MAX_MODEL_WIDTH) {
    size.width = MAX_MODEL_WIDTH;
    size.height = static_cast<uint32_t>((h * MAX_MODEL_WIDTH + w / 2) / w);
  } else {
    size.height = MAX_MODEL_HEIGHT;
    size.width = static_cast<uint32_t>((w * MAX_MODEL_HEIGHT + h / 2) / h);
  }
  const auto minSide = static_cast<uint32_t>(MIN_SIDE);
  size.width = std::max(size.width, minSide);
  size.height = std::max(size.height, minSide);
  return size;
}

std::vector<float>
resizeToPlanar(std::span<const uint8_t> rgb, ImageSize from, ImageSize to) {
  checkLength(
      rgb.size(),
      static_cast<size_t>(from.width) * from.height * RGB_CHANNELS,
      "RGB view");
  const size_t plane = static_cast<size_t>(to.width) * to.height;
  std::vector<float> chw(plane * RGB_CHANNELS);
  if (from == to) {
    for (size_t i = 0; i < plane; ++i) {
      for (size_t c = 0; c < RGB_CHANNELS; ++c)
        chw[c * plane + i] = static_cast<float>(rgb[i * RGB_CHANNELS + c]);
    }
    return chw;
  }
  resizeBilinear(
      from,
      to,
      RGB_CHANNELS,
      [&](size_t c, size_t i) {
        return static_cast<float>(rgb[i * RGB_CHANNELS + c]);
      },
      [&](size_t c, size_t i, float value) {
        chw[c * plane + i] = std::round(value);
      });
  return chw;
}

std::vector<float> resizeDisparity(
    const std::vector<float>& disparity, ImageSize from, ImageSize to) {
  checkLength(
      disparity.size(),
      static_cast<size_t>(from.width) * from.height,
      "disparity");
  // Disparity is a horizontal offset, so it scales with the width alone.
  const float scale = static_cast<float>(to.width) / from.width;
  std::vector<float> out(static_cast<size_t>(to.width) * to.height);
  resizeBilinear(
      from,
      to,
      1,
      [&](size_t, size_t i) { return disparity[i]; },
      [&](size_t, size_t i, float value) { out[i] = value * scale; });
  return out;
}

std::vector<float>
toPlanarRgb(const ImageInput& input, uint32_t& width, uint32_t& height) {
  std::vector<uint8_t> storage;
  ImageSize size;
  const auto rgb = decodeView(input, storage, size);
  width = size.width;
  height = size.height;
  return resizeToPlanar(rgb, size, size);
}

namespace {

struct PlanarView {
  ImageSize input;
  ImageSize model;
  std::vector<float> planar;
};

// One view as planar floats at the size the model runs it at. The decoded RGB
// is freed on return, so the two views are never decoded at the same time.
// `expected`, when set, is the size the view must have.
PlanarView
planarAtModelSize(const ImageInput& input, const ImageSize* expected) {
  std::vector<uint8_t> storage;
  PlanarView view;
  const auto rgb = decodeView(input, storage, view.input);
  if (expected != nullptr)
    check(
        view.input == *expected,
        "left and right images must have the same size");
  view.model = modelInputSize(view.input.width, view.input.height);
  view.planar = resizeToPlanar(rgb, view.input, view.model);
  return view;
}

} // namespace

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
  const ImageSize input{width, height};
  const ImageSize model = modelInputSize(width, height);
  // A downsampled run resizes the disparity back to the input after the graph
  // run, while the model-size disparity is still held.
  const uint64_t resizedOutputBytes =
      model == input ? 0
                     : static_cast<uint64_t>(width) * height * sizeof(float);
  const auto state = open(config, true);
  try {
    MeasuredBuffers result = state->graph->measure(
        static_cast<int>(model.height),
        static_cast<int>(model.width),
        resizedOutputBytes);
    result.deviceName = deviceName(state->backends->device());
    result.deviceIsCpu = state->backends->device() == state->backends->cpu();
    return result;
  } catch (const StatusError&) {
    throw;
  } catch (const ResourceError& error) {
    throw StatusError(InternalError, error.what());
  } catch (const std::exception& error) {
    throw StatusError(InvalidArgument, error.what());
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
  // Decoding and resizing count, as MegaLoc's total_time_ms includes its
  // preprocess().
  const auto start = std::chrono::steady_clock::now();
  DisparityOutput output;
  try {
    ImageSize inputSize;
    ImageSize model;
    std::vector<float> disparity;
    {
      // Scoped so the planar views are freed before the disparity is resized
      // back, the phases BridgeDepthGraph::measure sizes.
      const auto left = planarAtModelSize(pair->left, nullptr);
      const auto right = planarAtModelSize(pair->right, &left.input);
      inputSize = left.input;
      model = left.model;
      disparity = impl_->graph->infer(
          left.planar.data(),
          right.planar.data(),
          static_cast<int>(model.height),
          static_cast<int>(model.width));
    }
    // Checked at the model size: a bilinear resize of finite values times a
    // finite scale stays finite.
    for (const float value : disparity) {
      if (!std::isfinite(value))
        throw StatusError(
            InternalError, "BridgeDepth produced a non-finite disparity");
    }
    if (model != inputSize)
      disparity = resizeDisparity(disparity, model, inputSize);
    output = {inputSize.width, inputSize.height, std::move(disparity)};
  } catch (const StatusError&) {
    throw;
  } catch (const std::exception& error) {
    throw StatusError(InternalError, error.what());
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
