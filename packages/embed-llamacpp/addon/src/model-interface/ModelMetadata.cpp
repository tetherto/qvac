#include "model-interface/ModelMetadata.hpp"

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama-cpp.h>

#include "addon/BertErrors.hpp"
#include "model-interface/logging.hpp"

using namespace qvac_lib_infer_llamacpp_embed::errors;
using namespace qvac_lib_infer_llamacpp_embed::logging;

void ModelMetaData::FirstFileFromGgufStreamState::provide(
    ModelMetaData::SharedBuffer& firstFileFromGgufStreamIn) {
  std::lock_guard<std::mutex> lock(firstFileFromGgufStreamMutex_);
  auto borrowed = firstFileFromGgufStreamIn.borrow();
  if (!borrowed) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadModel),
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

  if (metadata_ != nullptr) {
    return;
  }

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
          addonId, toString(UnableToLoadMetadata), errorMsg);
    }
  };

  auto loadFromDisk = [&modelPath, outMetadata = &this->metadata_, addonId](
                          const std::string& diskPath) {
    MetaResultStatus status =
        llama_model_meta_from_file(diskPath.c_str(), outMetadata);
    if (status != MetaResultStatus::SUCCESS) {
      std::string statusStr = std::to_string(static_cast<int>(status));
      std::string errorMsg = string_format(
          "ModelMetadata::loadFromDisk: failed to load model metadata while "
          "parsing GGUF, path=%s MetaResultStatus=%s\n",
          diskPath.c_str(),
          statusStr.c_str());
      throw qvac_errors::StatusError(
          addonId, toString(UnableToLoadMetadata), errorMsg);
    }
  };

  if (isStreaming) {
    llamaLogCallback(
        GGML_LOG_LEVEL_INFO,
        "ModelMetaData::parse: load the model metadata from memory.\n",
        nullptr);
    static constexpr int64_t waitFirstFileTimeoutSec = 15;
    firstFileFromGgufStreamState.waitConsumeAndClear<waitFirstFileTimeoutSec>(
        [&](ModelMetaData::Buf& firstFileFromGgufStream) {
          loadFromStreambuf(firstFileFromGgufStream);
        });
  } else if (shards.gguf_files.empty()) {
    llamaLogCallback(
        GGML_LOG_LEVEL_INFO,
        "ModelMetaData::parse: load the model metadata from disk file.\n",
        nullptr);
    loadFromDisk(modelPath);
  } else {
    llamaLogCallback(
        GGML_LOG_LEVEL_INFO,
        "ModelMetaData::parse: load the model metadata from disk shards.\n",
        nullptr);
    loadFromDisk(shards.gguf_files.front());
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
