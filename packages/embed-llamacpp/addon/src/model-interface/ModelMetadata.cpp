#include "model-interface/ModelMetadata.hpp"

#include <algorithm>
#include <vector>

#include <common/common.h>
#include <gguf.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama-cpp.h>

#include "addon/BertErrors.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;

void ModelMetaData::parse(const std::string& modelPath, const char* addonId) {
  if (metadata_ != nullptr) {
    return;
  }
  const MetaResultStatus status =
      llama_model_meta_from_file(modelPath.c_str(), &metadata_);
  if (status != MetaResultStatus::SUCCESS) {
    throw qvac_errors::StatusError(
        addonId,
        toString(UnableToLoadMetadata),
        string_format(
            "Failed to read GGUF metadata from disk: %s (status %d)",
            modelPath.c_str(),
            static_cast<int>(status)));
  }
  diskPath_ = modelPath;
}

template <typename T, typename F>
static std::optional<T>
tryGet(const metadata_handle_ptr& metadata, const char* key, F&& getter) {
  if (metadata == nullptr) {
    return std::nullopt;
  }
  T value{};
  MetaResultStatus status = getter(metadata, key, &value);
  if (status != MetaResultStatus::SUCCESS) {
    return std::nullopt;
  }
  return value;
}

std::optional<uint32_t> ModelMetaData::tryGetU32(const char* key) const {
  return tryGet<uint32_t>(metadata_, key, llama_model_meta_get_u32);
}

std::optional<std::string> ModelMetaData::tryGetString(const char* key) const {
  return tryGet<std::string>(metadata_, key, llama_model_meta_get_str);
}

std::optional<uint32_t> ModelMetaData::tryGetPoolingType() const {
  const std::optional<std::string> arch = tryGetString("general.architecture");
  if (!arch.has_value()) {
    return std::nullopt;
  }
  const std::string key = *arch + ".pooling_type";
  return tryGetU32(key.c_str());
}

std::optional<bool>
ModelMetaData::hasAnyTensor(std::initializer_list<const char*> names) const {
  using GgufPtr = std::unique_ptr<gguf_context, decltype(&gguf_free)>;
  auto open = [](const std::string& path) {
    return GgufPtr(
        gguf_init_from_file(
            path.c_str(), gguf_init_params{.no_alloc = true, .ctx = nullptr}),
        gguf_free);
  };
  auto hasTensor = [&names](const gguf_context* ctx) {
    return std::ranges::any_of(names, [ctx](const char* name) {
      return gguf_find_tensor(ctx, name) >= 0;
    });
  };
  auto first = open(diskPath_);
  if (!first) {
    return std::nullopt;
  }
  if (hasTensor(first.get())) {
    return true;
  }
  const int64_t key = gguf_find_key(first.get(), "split.count");
  if (key < 0) {
    return false;
  }
  if (gguf_get_kv_type(first.get(), key) != GGUF_TYPE_UINT16) {
    return std::nullopt;
  }
  // The GGUF header bounds the count; never derive it from a filename.
  const uint16_t count = gguf_get_val_u16(first.get(), key);
  if (count <= 1) {
    return false;
  }
  std::vector<char> prefix(diskPath_.size() + 1);
  if (llama_split_prefix(
          prefix.data(), prefix.size(), diskPath_.c_str(), 0, count) <= 0) {
    return std::nullopt;
  }
  std::vector<char> path(diskPath_.size() + 32);
  for (uint16_t i = 1; i < count; ++i) {
    if (llama_split_path(path.data(), path.size(), prefix.data(), i, count) <=
        0) {
      return std::nullopt;
    }
    auto shard = open(path.data());
    if (!shard) {
      return std::nullopt;
    }
    if (hasTensor(shard.get())) {
      return true;
    }
  }
  return false;
}
