#include "model-interface/ModelMetadata.hpp"

#include <stdexcept>

#include <common/common.h>
#include <common/log.h>
#include <llama-cpp.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"

namespace {
void throwSinggleGgufStreamErrorNotFound(
    std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>>&
        singleGgufStreamedFiles,
    const std::string& modelPath, const char* AddonID) {
  std::string availableFiles = " No files available.";
  if (!singleGgufStreamedFiles.empty()) {
    availableFiles = " Available files: ";
    auto it = singleGgufStreamedFiles.begin();
    availableFiles += it->first;
    ++it;
    for (; it != singleGgufStreamedFiles.end(); ++it) {
      availableFiles += ", " + it->first;
    }
  }
  std::string errorMsg = string_format(
      "%s: failed to load model metadata. path=%s%s\n",
      __func__,
      modelPath.c_str(),
      availableFiles.c_str());
  throw qvac_errors::StatusError(
      AddonID,
      toString(qvac_lib_inference_addon_llama::errors::UnableToLoadMetadata),
      errorMsg);
}
} // namespace

void ModelMetaData::FirstFileFromGgufStreamState::wait() {
  std::unique_lock<std::mutex> lock(firstFileFromGgufStreamMutex_);
  firstFileFromGgufStreamCv_.wait(
      lock, [this]() { return hasFirstFileFromGgufStream_; });
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
}

void ModelMetaData::parse(
    const std::string& modelPath,
    std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>>&
        singleGgufStreamedFiles,
    const GGUFShards& shards, bool isStreaming, const char* AddonID) {

  auto loadFromStreambuf = [&modelPath,
                            out_metadata = &this->metadata_,
                            AddonID](std::basic_streambuf<char>& streambuf) {
    MetaResultStatus status =
        llama_model_meta_from_streambuf(streambuf, out_metadata);
    if (status != MetaResultStatus::SUCCESS) {
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
    if (shards.gguf_files.empty()) {
      LOG_INF(
          "%s: load the model metadata from memory (single file).\n", __func__);

      // After waiting for the first file from the gguf stream to be available,
      // It should have been inserted into singleGgufStreamedFiles but we will
      // double check the inserted filename matches.
      auto modelFilename = std::filesystem::path(modelPath).filename().string();
      auto itGgufModelPath = singleGgufStreamedFiles.find(modelFilename);
      if (itGgufModelPath == singleGgufStreamedFiles.end()) {
        throwSinggleGgufStreamErrorNotFound(
            singleGgufStreamedFiles, modelPath, AddonID);
      }
      loadFromStreambuf(*itGgufModelPath->second);
    } else {
      LOG_INF("%s: load the model metadata from memory shards.\n", __func__);
      auto firstFileFromGgufStream = firstFileFromGgufStreamState.get();
      loadFromStreambuf(*firstFileFromGgufStream);
    }
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
