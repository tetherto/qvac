#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <initializer_list>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

// Needed for GGUFShards
#include <iomanip>
#include <sstream>

#include <llama-cpp.h>

#include "addon/BertErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "inference-addon-cpp/GGUFShards.hpp"
#include "utils/BorrowablePtr.hpp"

/// @brief Access model metadata without loading weights into memory.
/// @details After parse(), all GGUF key-values are held in-memory and can be
/// queried without further disk or streambuf access.
class ModelMetaData {
  metadata_handle_ptr metadata_;
  using Buf = std::basic_streambuf<char>;
  using SharedBuffer = BorrowablePtr<Buf>;

public:
  ModelMetaData() = default;
  ~ModelMetaData() = default;

  ModelMetaData(const ModelMetaData&) = delete;
  ModelMetaData& operator=(const ModelMetaData&) = delete;
  ModelMetaData(ModelMetaData&&) = delete;
  ModelMetaData& operator=(ModelMetaData&&) = delete;

  /// @param modelPath Model to load (single .gguf).
  /// @param shards Sharded files, if any.
  /// @param isStreaming Whether metadata is loaded from streamed buffers.
  /// @param addonId Identifier for error reporting.
  void parse(
      const std::string& modelPath, const GGUFShards& shards, bool isStreaming,
      const char* addonId);

  /// @brief Returns the u32 value at @p key, or nullopt if absent.
  [[nodiscard]] std::optional<uint32_t> tryGetU32(const char* key) const;

  /// @brief Returns the string value at @p key, or nullopt if absent or not a
  /// string type.
  [[nodiscard]] std::optional<std::string> tryGetString(const char* key) const;

  class FirstFileFromGgufStreamState {
  public:
    /// @brief Blocks until the metadata consumer finishes and releases the
    /// streamed buffer, or throws on timeout.
    template <int64_t TimeoutSeconds> void waitForRelease() {
      std::unique_lock<std::mutex> lock(firstFileFromGgufStreamMutex_);
      if (!firstFileFromGgufStreamCv_.wait_for(
              lock, std::chrono::seconds(TimeoutSeconds), [this]() {
                return hasProvidedFirstFileFromGgufStream_ &&
                       !firstFileFromGgufStream_.has_value();
              })) {
        throw qvac_errors::StatusError(
            qvac_lib_infer_llamacpp_embed::errors::ADDON_ID,
            toString(qvac_lib_infer_llamacpp_embed::errors::UnableToLoadModel),
            "ModelMetaData::waitForRelease: timed out waiting for metadata "
            "consumer to release the streamed GGUF file");
      }
    }

    /// @brief Provides the first streamed GGUF file.
    /// @note To avoid deadlock, if ModelMetaData::parse() is already waiting
    /// for the first streamed file, call this from another thread.
    /// @note Underlying LLM engine should leave the streambuf pointing to the
    /// beginning of the file.
    void provide(SharedBuffer& firstFileFromGgufStream);

  private:
    friend class ModelMetaData;

    template <int64_t TimeoutSeconds, typename Fn>
    void waitConsumeAndClear(const Fn& processingFunction) {
      auto clear = [this]() {
        firstFileFromGgufStream_.reset();
        firstFileFromGgufStreamCv_.notify_all();
      };
      std::unique_lock<std::mutex> lock(firstFileFromGgufStreamMutex_);
      if (!firstFileFromGgufStreamCv_.wait_for(
              lock, std::chrono::seconds(TimeoutSeconds), [this]() {
                return firstFileFromGgufStream_.has_value();
              })) {
        throw qvac_errors::StatusError(
            qvac_lib_infer_llamacpp_embed::errors::ADDON_ID,
            toString(qvac_lib_infer_llamacpp_embed::errors::UnableToLoadModel),
            "ModelMetaData::waitConsumeAndClear: timed out waiting for "
            "first streamed GGUF file to be provided");
      }
      try {
        processingFunction(firstFileFromGgufStream_->ref());
      } catch (...) {
        clear();
        throw;
      }
      clear();
    }

    std::optional<SharedBuffer::Borrowed> firstFileFromGgufStream_;
    std::mutex firstFileFromGgufStreamMutex_;
    std::condition_variable firstFileFromGgufStreamCv_;
    bool hasProvidedFirstFileFromGgufStream_ = false;
  };
  // NOLINTNEXTLINE(cppcoreguidelines-non-private-member-variables-in-classes)
  FirstFileFromGgufStreamState firstFileFromGgufStreamState;
};
