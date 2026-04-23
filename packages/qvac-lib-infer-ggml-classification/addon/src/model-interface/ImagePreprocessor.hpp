#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <vector>

namespace qvac_lib_infer_ggml_classification::preprocess {

constexpr uint32_t kInputSize = 224;
constexpr uint32_t kChannels = 3;
/// Reject unreasonably large images to defend against OOM-shaped inputs.
constexpr uint32_t kMaxImageDimension = 16384;

/// ImageNet per-channel normalization parameters used by MobileNetV3.
constexpr std::array<float, 3> kImageNetMean = {0.485F, 0.456F, 0.406F};
constexpr std::array<float, 3> kImageNetStd = {0.229F, 0.224F, 0.225F};

/// Detects common image formats by magic bytes. Returns true for JPEG/PNG.
/// Used to decide whether to run stb_image or treat the buffer as raw RGB.
bool isEncodedImage(std::span<const uint8_t> buffer);

/// Decodes a JPEG or PNG buffer into tightly packed RGB bytes. Throws
/// StatusError with a clear, user-facing message on any failure mode:
/// empty buffer, unsupported format, corrupted stream, or dimension overflow.
std::vector<uint8_t> decodeToRgb(
    std::span<const uint8_t> encodedBuffer, uint32_t& outWidth,
    uint32_t& outHeight);

/// Validates raw-RGB input coming through the `{ width, height, channels }`
/// path. Throws StatusError if channels != 3, dimensions are out of range,
/// or the buffer size is inconsistent with the declared shape.
void validateRawRgb(
    std::span<const uint8_t> rawBuffer, uint32_t width, uint32_t height,
    uint32_t channels);

/// Bilinear resize of a tightly packed RGB image to `kInputSize` square.
/// Implemented with stb_image_resize2 in a single pass.
std::vector<uint8_t> resizeToInput(
    std::span<const uint8_t> srcRgb, uint32_t srcWidth, uint32_t srcHeight);

/// Produces a ready-to-ingest FP32 tensor buffer in WHCN layout (width,
/// height, channels, batch=1) matching ggml's conv2d convention. Pixels are
/// converted to [0, 1], ImageNet-normalized, and channel-interleaved into
/// the WHCN layout in one pass.
/// Output size is `kInputSize * kInputSize * kChannels`.
std::vector<float> normalizeToWhcn(std::span<const uint8_t> rgb224);

/// Convenience: full pipeline from an arbitrary encoded-or-raw buffer down to
/// the FP32 WHCN tensor the model expects.
std::vector<float> preprocessToTensor(
    std::span<const uint8_t> input, uint32_t declaredWidth,
    uint32_t declaredHeight, uint32_t declaredChannels);

} // namespace qvac_lib_infer_ggml_classification::preprocess
