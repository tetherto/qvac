#include "model-interface/ModelMetadata.hpp"

#include <algorithm>

#include <common/common.h>
#include <common/log.h>
#include <llama-cpp.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"

void ModelMetaData::FirstFileFromGgufStreamState::provide(
    ModelMetaData::SharedBuffer& firstFileFromGgufStreamIn) {
  std::lock_guard<std::mutex> lock(firstFileFromGgufStreamMutex_);
  auto borrowed = firstFileFromGgufStreamIn.borrow();
  if (!borrowed) {
    throw qvac_errors::StatusError(
        qvac_lib_inference_addon_llama::errors::ADDON_ID,
        toString(qvac_lib_inference_addon_llama::errors::UnableToLoadModel),
        "ModelMetaData::FirstFileFromGgufStreamState::provide: received empty "
        "borrowed stream");
  }
  firstFileFromGgufStream_.emplace(std::move(borrowed));
  hasProvidedFirstFileFromGgufStream_ = true;
  firstFileFromGgufStreamCv_.notify_all();
}

void ModelMetaData::parse(
    const std::string& modelPath, const GGUFShards& shards, bool isStreaming,
    const char* addonId) {

  auto loadFromStreambuf = [&modelPath,
                            outMetadata = &this->metadata_,
                            addonId](std::basic_streambuf<char>& streambuf) {
    MetaResultStatus status =
        llama_model_meta_from_streambuf(streambuf, outMetadata);
    if (status != MetaResultStatus::SUCCESS) {
      std::string statusStr = std::to_string(static_cast<int>(status));
      std::string errorMsg = string_format(
          "ModelMetadata::loadFromStreambuf: failed to load model metadata "
          "while parsing GGUF, path=%s MetaResultStatus=%s\n",
          modelPath.c_str(),
          statusStr.c_str());
      throw qvac_errors::StatusError(
          addonId,
          toString(
              qvac_lib_inference_addon_llama::errors::UnableToLoadMetadata),
          errorMsg);
    }
  };

  auto loadFromDisk = [&modelPath, outMetadata = &this->metadata_, addonId](
                          const std::string& diskPath) {
    MetaResultStatus status =
        llama_model_meta_from_file(diskPath.c_str(), outMetadata);
    if (status != MetaResultStatus::SUCCESS) {
      std::string statusStr = std::to_string(static_cast<int>(status));
      std::string errorMsg = string_format(
          "ModelMetadata::loadFromDisk: failed to load model metadata "
          "while parsing GGUF, path=%s MetaResultStatus=%s\n",
          diskPath.c_str(),
          statusStr.c_str());
      throw qvac_errors::StatusError(
          addonId,
          toString(
              qvac_lib_inference_addon_llama::errors::UnableToLoadMetadata),
          errorMsg);
    }
  };

  if (isStreaming) {
    LOG_INF("%s: load the model metadata from memory.\n", __func__);
    static constexpr int64_t waitFirstFileTimeoutSec = 15;
    firstFileFromGgufStreamState.waitConsumeAndClear<waitFirstFileTimeoutSec>(
        [&](ModelMetaData::Buf& firstFileFromGgufStream) {
          loadFromStreambuf(firstFileFromGgufStream);
        });
  } else {
    if (shards.gguf_files.empty()) {
      LOG_INF("%s: load the model metadata from disk file.\n", __func__);
      loadFromDisk(modelPath);
    } else {
      LOG_INF("%s: load the model metadata from disk shards.\n", __func__);
      loadFromDisk(shards.gguf_files.front());
    }
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

std::optional<uint32_t> ModelMetaData::tryGetU32(const char* key) const {
  if (metadata_ == nullptr) {
    return std::nullopt;
  }
  uint32_t value = 0;
  MetaResultStatus status = llama_model_meta_get_u32(metadata_, key, &value);
  if (status != MetaResultStatus::SUCCESS) {
    return std::nullopt;
  }
  return value;
}

bool ModelMetaData::isU32OneOf(
    const char* key, std::initializer_list<uint32_t> values) const {
  checkInitialized();
  uint32_t value = 0;
  MetaResultStatus status = llama_model_meta_get_u32(metadata_, key, &value);
  if (status != MetaResultStatus::SUCCESS) {
    LOG_WRN(
        "ModelMetaData::isU32OneOf: failed to read key '%s', "
        "llama_model_meta_get_u32 returned %s\n",
        key,
        std::to_string(static_cast<int>(status)).c_str());
    return false;
  }
  return std::ranges::any_of(
      values, [value](uint32_t queryValue) { return value == queryValue; });
}

bool ModelMetaData::hasOneBitQuantization() const {
  return isU32OneOf(
      "general.file_type",
      {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ1_0),
       static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ2_0)});
}
