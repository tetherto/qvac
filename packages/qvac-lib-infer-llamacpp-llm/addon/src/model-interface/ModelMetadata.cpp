#include "model-interface/ModelMetadata.hpp"

#include <common/common.h>
#include <common/log.h>
#include <llama-cpp.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"

void ModelMetaData::FirstFileFromGgufStreamState::wait() {
  std::unique_lock<std::mutex> lock(firstFileFromGgufStreamMutex_);
  firstFileFromGgufStreamCv_.wait(
      lock, [this]() { return hasFirstFileFromGgufStream_; });
}

void ModelMetaData::FirstFileFromGgufStreamState::waitForRelease() {
  std::unique_lock<std::mutex> lock(firstFileFromGgufStreamMutex_);
  firstFileFromGgufStreamCv_.wait(
      lock, [this]() { return hasFirstFileFromGgufStream_ && !firstFileFromGgufStream_; });
}

std::shared_ptr<std::basic_streambuf<char>>
ModelMetaData::FirstFileFromGgufStreamState::get() {
  std::lock_guard<std::mutex> lock(firstFileFromGgufStreamMutex_);
  return firstFileFromGgufStream_;
}

void ModelMetaData::FirstFileFromGgufStreamState::provide(
    std::shared_ptr<std::basic_streambuf<char>> firstFileFromGgufStreamIn) {
  if (!firstFileFromGgufStreamIn) {
    throw qvac_errors::StatusError(
        qvac_lib_inference_addon_llama::errors::ADDON_ID,
        toString(qvac_lib_inference_addon_llama::errors::InvalidInputFormat),
        "ModelMetaData::FirstFileFromGgufStreamState::provide: null streambuf");
  }
  std::lock_guard<std::mutex> lock(firstFileFromGgufStreamMutex_);
  firstFileFromGgufStream_ = std::move(firstFileFromGgufStreamIn);
  hasFirstFileFromGgufStream_ = true;
  firstFileFromGgufStreamCv_.notify_all();
}

void ModelMetaData::FirstFileFromGgufStreamState::clear() {
  std::lock_guard<std::mutex> lock(firstFileFromGgufStreamMutex_);
  firstFileFromGgufStream_.reset();
  firstFileFromGgufStreamCv_.notify_all();
}

void ModelMetaData::parse(
    const std::string& modelPath,
    const GGUFShards& shards, bool isStreaming, const char* AddonID) {

  auto loadFromStreambuf = [&modelPath,
                            out_metadata = &this->metadata_,
                            AddonID](std::basic_streambuf<char>& streambuf) {
    MetaResultStatus status =
        llama_model_meta_from_streambuf(streambuf, out_metadata);
    if (status != MetaResultStatus::SUCCESS) {
      // leave object in a consistent uninitialized state, library can leave it in an invalid state
      *out_metadata = nullptr;  
      std::string statusStr = std::to_string(status);
      std::string errorMsg = string_format(
          "ModelMetadata::loadFromStreambuf: failed to load model metadata "
          "while parsing GGUF, path=%s MetaResultStatus=%s\n",
          modelPath.c_str(),
          statusStr.c_str());
      throw qvac_errors::StatusError(
          AddonID,
          toString(
              qvac_lib_inference_addon_llama::errors::UnableToLoadMetadata),
          errorMsg);
    }
  };

  auto loadFromDisk = [&modelPath, out_metadata = &this->metadata_, AddonID](
                          const std::string& diskPath) {
    MetaResultStatus status =
        llama_model_meta_from_file(diskPath.c_str(), out_metadata);
    if (status != MetaResultStatus::SUCCESS) {
      *out_metadata = nullptr;
      std::string statusStr = std::to_string(status);
      std::string errorMsg = string_format(
          "ModelMetadata::loadFromDisk: failed to load model metadata "
          "while parsing GGUF, path=%s MetaResultStatus=%s\n",
          diskPath.c_str(),
          statusStr.c_str());
      throw qvac_errors::StatusError(
          AddonID,
          toString(
              qvac_lib_inference_addon_llama::errors::UnableToLoadMetadata),
          errorMsg);
    }
  };

  if (isStreaming) {
    // Wait for the first file from the gguf stream to be available.
    firstFileFromGgufStreamState.wait();
    LOG_INF("%s: load the model metadata from memory.\n", __func__);
    auto firstFileFromGgufStream = firstFileFromGgufStreamState.get();
    loadFromStreambuf(*firstFileFromGgufStream);
    firstFileFromGgufStreamState.clear();
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

bool ModelMetaData::isU32OneOf(
    const char* key, std::initializer_list<uint32_t> values) const {
  checkInitialized();
  uint32_t value = 0;
  MetaResultStatus status =
      llama_model_meta_get_u32(metadata_, key, &value);
  if (status != MetaResultStatus::SUCCESS) {
    LOG_WRN(
        "ModelMetaData::isU32OneOf: failed to read key '%s', "
        "llama_model_meta_get_u32 returned %s\n",
        key, std::to_string(status).c_str());
    return false;
  }
  for (uint32_t v : values) {
    if (value == v) return true;
  }
  return false;
}

bool ModelMetaData::hasOneBitQuantization() const {
  return isU32OneOf(
      "general.file_type",
      {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ1_0),
       static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ2_0)});
}
