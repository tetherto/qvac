#include <algorithm>
#include <cmath>
#include <span>

#include <inference-addon-cpp/Errors.hpp>

#include "MegaLocModel.hpp"
#include "model-interface/ImagePreprocessor.hpp"

namespace classification_ggml::megaloc {
namespace {

struct Filter {
  size_t start;
  std::vector<float> weights;
};

std::vector<Filter> filters(int sourceSize) {
  const float scale = static_cast<float>(sourceSize) / IMAGE_SIZE;
  const float support = std::max(1.0F, scale);
  std::vector<Filter> result;
  result.reserve(IMAGE_SIZE);
  for (int i = 0; i < IMAGE_SIZE; ++i) {
    const float center = (static_cast<float>(i) + 0.5F) * scale;
    const int start = std::max(0, static_cast<int>(center - support + 0.5F));
    const int end =
        std::min(sourceSize, static_cast<int>(center + support + 0.5F));
    Filter filter{static_cast<size_t>(start), {}};
    float sum = 0;
    for (int j = start; j < end; ++j) {
      const float weight = std::max(
          0.0F,
          1.0F - std::abs((static_cast<float>(j) - center + 0.5F) / support));
      filter.weights.push_back(weight);
      sum += weight;
    }
    for (float& weight : filter.weights)
      weight /= sum;
    result.push_back(std::move(filter));
  }
  return result;
}

} // namespace

std::vector<float> preprocess(const ImageInput& input) {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> decoded;
  std::span<const uint8_t> rgb(input.data);
  if (input.rawRgb) {
    width = input.rawRgb->width;
    height = input.rawRgb->height;
    classification_ggml::preprocess::validateRawRgb(
        rgb, width, height, input.rawRgb->channels);
  } else {
    if (!classification_ggml::preprocess::isEncodedImage(rgb)) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "MegaLoc expects JPEG/PNG or raw RGB with dimensions");
    }
    decoded = classification_ggml::preprocess::decodeToRgb(rgb, width, height);
    rgb = decoded;
  }

  const auto horizontal = filters(static_cast<int>(width));
  const auto vertical = filters(static_cast<int>(height));
  std::vector<float> rows(static_cast<size_t>(height) * IMAGE_SIZE * 3);
  std::vector<float> normalized(static_cast<size_t>(width) * 3);
  for (uint32_t y = 0; y < height; ++y) {
    for (size_t i = 0; i < normalized.size(); ++i) {
      const auto channel = i % 3;
      normalized[i] =
          (static_cast<float>(rgb[static_cast<size_t>(y) * width * 3 + i]) /
               255.0F -
           classification_ggml::preprocess::IMAGENET_MEAN[channel]) /
          classification_ggml::preprocess::IMAGENET_STD[channel];
    }
    for (size_t x = 0; x < IMAGE_SIZE; ++x) {
      const auto& filter = horizontal[x];
      for (size_t c = 0; c < 3; ++c) {
        float sum = 0;
        for (size_t k = 0; k < filter.weights.size(); ++k) {
          const size_t source = (filter.start + k) * 3 + c;
          sum += normalized[source] * filter.weights[k];
        }
        rows[(static_cast<size_t>(y) * IMAGE_SIZE + x) * 3 + c] = sum;
      }
    }
  }

  std::vector<float> patches(static_cast<size_t>(PATCH_COUNT) * PATCH_WIDTH);
  for (size_t y = 0; y < IMAGE_SIZE; ++y) {
    const auto& filter = vertical[y];
    for (size_t x = 0; x < IMAGE_SIZE; ++x) {
      const size_t patch =
          (y / PATCH_SIZE) * (IMAGE_SIZE / PATCH_SIZE) + x / PATCH_SIZE;
      for (size_t c = 0; c < 3; ++c) {
        float sum = 0;
        for (size_t k = 0; k < filter.weights.size(); ++k) {
          sum += rows[((filter.start + k) * IMAGE_SIZE + x) * 3 + c] *
                 filter.weights[k];
        }
        const size_t offset =
            (c * PATCH_SIZE + y % PATCH_SIZE) * PATCH_SIZE + x % PATCH_SIZE;
        patches[static_cast<size_t>(patch) * PATCH_WIDTH + offset] = sum;
      }
    }
  }
  return patches;
}

} // namespace classification_ggml::megaloc
