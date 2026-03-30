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

#include "addon/LlmErrors.hpp"
#include "qvac-lib-inference-addon-cpp/GGUFShards.hpp"
#include "utils/BorrowablePtr.hpp"

/// @brief Access model metadata without loading weights into memory.
/// @details After parse(), all GGUF key-values are held in-memory and can be
/// queried without further disk or streambuf access.
class ModelMetaData {
  void checkInitialized() const;
  metadata_handle_ptr metadata_;
  using Buf = std::basic_streambuf<char>;
  using SharedBuffer = BorrowablePtr<Buf>;

public:
  ModelMetaData() = default;
  virtual ~ModelMetaData() = default;

  /// @param modelPath Model to load (single .gguf)
  /// @param shards Containing sharded files, if any
  /// @param isStreaming Whether metadata is loaded from streamed buffers
  /// @param AddonID Identifier for error reporting
  void parse(
      const std::string& modelPath, const GGUFShards& shards, bool isStreaming,
      const char* addonId);

  /// @brief Returns the u32 value at @p key, or nullopt if
  /// absent/uninitialized.
  [[nodiscard]] std::optional<uint32_t> tryGetU32(const char* key) const;

  /// @brief Returns true if the u32 value at @p key matches any of @p values.
  [[nodiscard]] bool
  isU32OneOf(const char* key, std::initializer_list<uint32_t> values) const;

  /// @brief Returns the string value at @p key, or nullopt if
  /// absent/uninitialized or not a string type.
  [[nodiscard]] virtual std::optional<std::string>
  tryGetString(const char* key) const;

  [[nodiscard]] virtual bool hasOneBitQuantization() const;

  // Code below for streaming support

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
            qvac_lib_inference_addon_llama::errors::ADDON_ID,
            toString(qvac_lib_inference_addon_llama::errors::UnableToLoadModel),
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
            qvac_lib_inference_addon_llama::errors::ADDON_ID,
            toString(qvac_lib_inference_addon_llama::errors::UnableToLoadModel),
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
  FirstFileFromGgufStreamState
      firstFileFromGgufStreamState; // NOLINT(cppcoreguidelines-non-private-member-variables-in-classes)
};
