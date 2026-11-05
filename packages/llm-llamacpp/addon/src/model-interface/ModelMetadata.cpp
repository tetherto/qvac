#include "model-interface/ModelMetadata.hpp"

#include <algorithm>

#include <common/common.h>
#include <common/log.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama-cpp.h>

#include "addon/LlmErrors.hpp"

void ModelMetaData::parse(const std::string& modelPath, const char* addonId) {
  if (metadata_ != nullptr) {
    return;
  }
  const MetaResultStatus status =
      llama_model_meta_from_file(modelPath.c_str(), &metadata_);
  if (status != MetaResultStatus::SUCCESS) {
    throw qvac_errors::StatusError(
        addonId,
        toString(qvac_lib_inference_addon_llama::errors::UnableToLoadMetadata),
        string_format(
            "Failed to read GGUF metadata from disk: %s (status %d)",
            modelPath.c_str(),
            static_cast<int>(status)));
  }
}

void ModelMetaData::checkInitialized() const {
  if (metadata_ == nullptr) {
    throw qvac_errors::StatusError(
        qvac_lib_inference_addon_llama::errors::ADDON_ID,
        toString(qvac_lib_inference_addon_llama::errors::InvalidInputFormat),
        "ModelMetaData: not initialized; call parse() before querying "
        "metadata");
  }
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

bool ModelMetaData::isU32OneOf(
    const char* key, std::initializer_list<uint32_t> values) const {
  checkInitialized();
  auto value = tryGetU32(key);
  if (!value.has_value()) {
    LOG_WRN("ModelMetaData::isU32OneOf: failed to read key '%s'\n", key);
    return false;
  }
  return std::ranges::any_of(values, [v = value.value()](uint32_t queryValue) {
    return v == queryValue;
  });
}

bool ModelMetaData::hasOneBitQuantization() const {
  return isU32OneOf(
      "general.file_type",
      {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ1_0),
       static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ2_0)});
}
