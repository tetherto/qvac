#include "VideoModelCapabilities.hpp"

#include <array>
#include <cstdint>
#include <fstream>
#include <limits>
#include <string>

namespace qvac_lib_inference_addon_sd {
namespace {

constexpr uint32_t K_GGUF_MAGIC = 0x46554747; // "GGUF" in little-endian.
constexpr size_t K_MAX_STRING_BYTES = 1024 * 1024;
constexpr uint32_t K_GGUF_TYPE_UINT8 = 0;
constexpr uint32_t K_GGUF_TYPE_INT8 = 1;
constexpr uint32_t K_GGUF_TYPE_UINT16 = 2;
constexpr uint32_t K_GGUF_TYPE_INT16 = 3;
constexpr uint32_t K_GGUF_TYPE_UINT32 = 4;
constexpr uint32_t K_GGUF_TYPE_INT32 = 5;
constexpr uint32_t K_GGUF_TYPE_FLOAT32 = 6;
constexpr uint32_t K_GGUF_TYPE_BOOL = 7;
constexpr uint32_t K_GGUF_TYPE_STRING = 8;
constexpr uint32_t K_GGUF_TYPE_ARRAY = 9;
constexpr uint32_t K_GGUF_TYPE_UINT64 = 10;
constexpr uint32_t K_GGUF_TYPE_INT64 = 11;
constexpr uint32_t K_GGUF_TYPE_FLOAT64 = 12;

template <typename T> bool read(std::istream& input, T& value) {
  input.read(reinterpret_cast<char*>(&value), sizeof(value));
  return input.good();
}

bool skip(std::istream& input, uint64_t bytes) {
  if (bytes > static_cast<uint64_t>(std::numeric_limits<std::streamoff>::max()))
    return false;
  input.seekg(static_cast<std::streamoff>(bytes), std::ios::cur);
  return input.good();
}

bool skipString(std::istream& input) {
  uint64_t length = 0;
  return read(input, length) && skip(input, length);
}

bool readString(std::istream& input, std::string& value) {
  uint64_t length = 0;
  if (!read(input, length) || length > K_MAX_STRING_BYTES)
    return false;
  value.resize(static_cast<size_t>(length));
  input.read(value.data(), static_cast<std::streamsize>(length));
  return input.good();
}

uint64_t primitiveSize(uint32_t type) {
  switch (type) {
  case K_GGUF_TYPE_UINT8:
  case K_GGUF_TYPE_INT8:
  case K_GGUF_TYPE_BOOL:
    return 1;
  case K_GGUF_TYPE_UINT16:
  case K_GGUF_TYPE_INT16:
    return 2;
  case K_GGUF_TYPE_UINT32:
  case K_GGUF_TYPE_INT32:
  case K_GGUF_TYPE_FLOAT32:
    return 4;
  case K_GGUF_TYPE_UINT64:
  case K_GGUF_TYPE_INT64:
  case K_GGUF_TYPE_FLOAT64:
    return 8;
  default:
    return 0;
  }
}

bool skipValue(std::istream& input, uint32_t type);

bool skipArray(std::istream& input) {
  uint32_t elementType = 0;
  uint64_t count = 0;
  if (!read(input, elementType) || !read(input, count))
    return false;

  if (const uint64_t elementSize = primitiveSize(elementType);
      elementSize > 0) {
    if (count > std::numeric_limits<uint64_t>::max() / elementSize)
      return false;
    return skip(input, count * elementSize);
  }

  for (uint64_t i = 0; i < count; ++i) {
    if (!skipValue(input, elementType))
      return false;
  }
  return true;
}

bool skipValue(std::istream& input, uint32_t type) {
  if (const uint64_t size = primitiveSize(type); size > 0)
    return skip(input, size);
  if (type == K_GGUF_TYPE_STRING)
    return skipString(input);
  if (type == K_GGUF_TYPE_ARRAY)
    return skipArray(input);
  return false;
}

bool isWanTensor(const std::string& name) {
  return name.find("model.diffusion_model.blocks.0.cross_attn.norm_k.weight") !=
         std::string::npos;
}

bool isPatchEmbeddingTensor(const std::string& name) {
  return name.find("model.diffusion_model.patch_embedding.weight") !=
         std::string::npos;
}

bool isImageEmbeddingTensor(const std::string& name) {
  return name.find("model.diffusion_model.img_emb") != std::string::npos;
}

} // namespace

VideoModelCapabilities
inspectVideoModelCapabilities(const std::string& modelPath) {
  VideoModelCapabilities capabilities;
  std::ifstream input(modelPath, std::ios::binary);
  if (!input)
    return capabilities;

  uint32_t magic = 0;
  uint32_t version = 0;
  uint64_t tensorCount = 0;
  uint64_t keyValueCount = 0;
  if (!read(input, magic) || !read(input, version) ||
      !read(input, tensorCount) || !read(input, keyValueCount) ||
      magic != K_GGUF_MAGIC || (version != 2 && version != 3)) {
    return capabilities;
  }

  for (uint64_t i = 0; i < keyValueCount; ++i) {
    uint32_t type = 0;
    if (!skipString(input) || !read(input, type) || !skipValue(input, type))
      return capabilities;
  }

  bool isWan = false;
  bool hasImageEmbedding = false;
  uint64_t patchEmbeddingChannels = 0;

  for (uint64_t i = 0; i < tensorCount; ++i) {
    std::string name;
    uint32_t dimensionCount = 0;
    if (!readString(input, name) || !read(input, dimensionCount) ||
        dimensionCount > 4) {
      return capabilities;
    }

    std::array<uint64_t, 4> dimensions{};
    for (uint32_t dimension = 0; dimension < dimensionCount; ++dimension) {
      if (!read(input, dimensions[dimension]))
        return capabilities;
    }

    uint32_t type = 0;
    uint64_t offset = 0;
    if (!read(input, type) || !read(input, offset))
      return capabilities;

    isWan = isWan || isWanTensor(name);
    hasImageEmbedding = hasImageEmbedding || isImageEmbeddingTensor(name);
    if (isPatchEmbeddingTensor(name) && dimensionCount == 4)
      patchEmbeddingChannels = dimensions[3];
  }

  // Mirrors stable-diffusion.cpp's VERSION_WAN2_2_TI2V detection. Its
  // 16x VAE and 2x diffusion downsampling require a 32-pixel spatial grid.
  if (isWan && patchEmbeddingChannels == 147456 && !hasImageEmbedding)
    capabilities.spatialAlignment = 32;

  return capabilities;
}

} // namespace qvac_lib_inference_addon_sd
