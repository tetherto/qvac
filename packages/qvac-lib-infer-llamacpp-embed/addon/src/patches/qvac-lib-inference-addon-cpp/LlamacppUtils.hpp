#pragma once

#include <filesystem>
#include <iostream>
#include <ranges>
#include <streambuf>

#include <llama-cpp.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include <qvac-lib-inference-addon-cpp/GGUFShards.hpp>
#include "common/common.h"

/// @note async version
inline common_init_result_ptr initFromShards(
    const GGUFShards& shards, common_params& params,
    const std::string& loadingContext) {
  LOG_INF(
      "%s: load the model from async shards and apply lora adapter, if any.\n",
      __func__);
  llama_model_params mparams = common_model_params_to_llama(params);
  auto pathsView =
      shards.gguf_files |
      std::views::transform([](const std::string& str) { return str.c_str(); });
  std::vector<const char*> pathsVec(pathsView.begin(), pathsView.end());
  llama_model* model = llama_model_load_from_split_futures(
      pathsVec.data(),
      pathsVec.size(),
      loadingContext.c_str(),
      shards.tensors_file.c_str(),
      mparams);
  return common_init_from_model_and_params(model, params);
}

/// @note from disk
inline common_init_result_ptr
initFromShards(const GGUFShards& shards, common_params& params) {
  LOG_INF(
      "%s: load the model from disk shards and apply lora adapter, if any.\n",
      __func__);
  llama_model_params mparams = common_model_params_to_llama(params);
  auto pathsView =
      shards.gguf_files |
      std::views::transform([](const std::string& str) { return str.c_str(); });
  std::vector<const char*> pathsVec(pathsView.begin(), pathsView.end());
  llama_model* model =
      llama_model_load_from_splits(pathsVec.data(), pathsVec.size(), mparams);
  return common_init_from_model_and_params(model, params);
}

/// @brief Initializes a model from a single gguf stream stored in memory
/// @note For performance reasons `initFromShards` should be preferably used
/// with streams. However, this function is still offered to unify the Js
/// interface of the addon and separate concerns.
inline common_init_result_ptr initFromMemory(
    std::unique_ptr<std::basic_streambuf<char>>&& streambuf,
    common_params& params) {
  LOG_INF(
      "%s: load the model from single GGUF stream and apply lora adapter, if "
      "any.\n",
      __func__);
  llama_model_params mparams = common_model_params_to_llama(params);

  // Transfer the (Js) blobs to a contiguous memory block
  // Potential for optimization here. However for performance reasons,
  // sharded models should be used instead.
  std::vector<uint8_t> contiguousData;
  {
    // Scope streambuf so that it is destroyed after reading, and JS garbage
    // collection triggered.
    std::unique_ptr<std::basic_streambuf<char>> scopedStreambuf =
        std::move(streambuf);

    std::istream stream(scopedStreambuf.get());
    stream.seekg(0, std::ios::end);
    std::streampos size = stream.tellg();
    stream.seekg(0, std::ios::beg);
    contiguousData.resize(static_cast<size_t>(size));
    stream.read(reinterpret_cast<char*>(contiguousData.data()), size);
  }

  llama_model* model =
      llama_model_load_from_buffer(std::move(contiguousData), mparams);
  return common_init_from_model_and_params(model, params);
}

/// @brief Initialize a model handling streaming, not-streaming, sharded or
/// unsharded
/// @param modelPath Model to load (single .gguf)
/// @param singleGgufStreamedFiles Map containing .gguf files that finished
/// streaming
/// @param shards Containing sharded files, if any
/// @param loading_context What context to use when asynchronously loading
/// shards
/// @param isStreaming Should be set to true when `setWeightsForFile` is
/// being used to populate `singleGgufStreamedFiles` or call
/// `llama_model_load_fulfill_split_future`
inline common_init_result_ptr initFromConfig(
    common_params& params, const std::string& modelPath,
    std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>>&
        singleGgufStreamedFiles,
    const GGUFShards& shards, const std::string loading_context,
    const bool isStreaming, const char* AddonID, const std::string& error) {
  common_init_result_ptr llamaInit;
  // Stream should have been awaited by the time activate is called from JS
  // and init is triggered. isStreaming should be (thread) safe to use at this
  // point because `setWeightsForFile` has already finished.
  if (isStreaming) {
    if (shards.gguf_files.empty()) {
      // Not optimal. Shards preferred when streaming.
      LOG_INF(
          "%s: load the model gguf from stream and apply lora adapter, if "
          "any.\n",
          __func__);
      auto modelFilename = std::filesystem::path(modelPath).filename().string();
      auto itGgufModelPath = singleGgufStreamedFiles.find(modelFilename);
      if (itGgufModelPath == singleGgufStreamedFiles.end()) {
        // Build list of available files
        std::string availableFiles;
        if (!singleGgufStreamedFiles.empty()) {
          availableFiles = " Available files: ";
          bool first = true;
          for (const auto& [key, value] : singleGgufStreamedFiles) {
            if (!first)
              availableFiles += ", ";
            availableFiles += key;
            first = false;
          }
        } else {
          availableFiles = " No files available.";
        }

        std::string errorMsg = string_format(
            "%s: failed to load model from %s.%s\n",
            __func__,
            modelPath.c_str(),
            availableFiles.c_str());
        throw qvac_errors::StatusError(AddonID, error, errorMsg);
      }
      llamaInit =
          std::move(initFromMemory(std::move(itGgufModelPath->second), params));
      singleGgufStreamedFiles.erase(itGgufModelPath);
    } else {
      LOG_INF(
          "%s: load the sharded model and apply lora adapter, if any.\n",
          __func__);
      llamaInit = std::move(initFromShards(shards, params, loading_context));
    }
  } else {
    if (shards.gguf_files.empty()) {
      LOG_INF(
          "%s: load the model from disk file and apply lora adapter, if any.\n",
          __func__);
      if (!std::filesystem::exists(modelPath)) {
        throw qvac_errors::StatusError(
            AddonID,
            error,
            string_format(
                "%s: model file not found: %s\n", __func__, modelPath.c_str()));
      }
      llamaInit = std::move(common_init_from_params(params));
    } else {
      LOG_INF(
          "%s: load the model shards from disk file and apply lora adapter, if "
          "any.\n",
          __func__);
      llamaInit = std::move(initFromShards(shards, params));
    }
  }
  return llamaInit;
}
