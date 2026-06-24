#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <vector>

namespace classification_ggml::preprocess {

constexpr uint32_t INPUT_SIZE = 224;
constexpr uint32_t CHANNELS = 3;
/// OOM defence — reject inputs larger than this on either axis.
constexpr uint32_t MAX_IMAGE_DIMENSION = 16384;

/// ImageNet per-channel normalization, matching torchvision's MobileNetV3.
constexpr std::array<float, 3> IMAGENET_MEAN = {0.485F, 0.456F, 0.406F};
constexpr std::array<float, 3> IMAGENET_STD = {0.229F, 0.224F, 0.225F};

/// True for JPEG/PNG magic bytes; false routes to the raw-RGB path.
bool isEncodedImage(std::span<const uint8_t> buffer);

/// Decode JPEG/PNG to packed RGB. Throws StatusError on any failure.
std::vector<uint8_t> decodeToRgb(
    std::span<const uint8_t> encodedBuffer, uint32_t& outWidth,
    uint32_t& outHeight);

/// Throws StatusError if the buffer doesn't match the declared shape,
/// channels != 3, or dimensions exceed `MAX_IMAGE_DIMENSION`.
void validateRawRgb(
    std::span<const uint8_t> rawBuffer, uint32_t width, uint32_t height,
    uint32_t channels);

/// Bilinear resize (stb_image_resize2) to `INPUT_SIZE` square.
std::vector<uint8_t> resizeToInput(
    std::span<const uint8_t> srcRgb, uint32_t srcWidth, uint32_t srcHeight);

/// `INPUT_SIZE` × `INPUT_SIZE` RGB → FP32 WHCN tensor, ImageNet-normalized.
std::vector<float> normalizeToWhcn(std::span<const uint8_t> rgb224);

/// Full pipeline: encoded-or-raw buffer → FP32 WHCN tensor.
std::vector<float> preprocessToTensor(
    std::span<const uint8_t> input, uint32_t declaredWidth,
    uint32_t declaredHeight, uint32_t declaredChannels);

} // namespace classification_ggml::preprocess
