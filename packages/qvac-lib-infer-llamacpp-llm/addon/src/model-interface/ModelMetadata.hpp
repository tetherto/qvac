#pragma once

#include <condition_variable>
#include <initializer_list>
#include <memory>
#include <mutex>
#include <string>

#include <llama-cpp.h>

#include "qvac-lib-inference-addon-cpp/GGUFShards.hpp"

/// @brief Access model metadata without loading weights into memory.
/// @details After parse(), all GGUF key-values are held in-memory and can be
/// queried without further disk or streambuf access.
class ModelMetaData {
  void checkInitialized() const;

  metadata_handle_ptr metadata_;

public:
  ModelMetaData() = default;

  /// @param modelPath Model to load (single .gguf)
  /// @param shards Containing sharded files, if any
  /// @param isStreaming Whether metadata is loaded from streamed buffers
  /// @param AddonID Identifier for error reporting
  void parse(
      const std::string& modelPath,
      const GGUFShards& shards, bool isStreaming, const char* AddonID);

  /// @brief Returns true if the u32 value at @p key matches any of @p values.
  [[nodiscard]] bool
  isU32OneOf(const char* key, std::initializer_list<uint32_t> values) const;

  [[nodiscard]] bool hasOneBitQuantization() const;

  // Code below for streaming support

  class FirstFileFromGgufStreamState {
  public:
    void wait();
    void waitForRelease();
    std::shared_ptr<std::basic_streambuf<char>> get();
    /// @brief Provides the first streamed GGUF file.
    /// @note To avoid deadlock, if ModelMetaData::parse() is already waiting
    /// for the first streamed file, call this from another thread.
    /// @note Underlying LLM engine should leave the streambuf pointing to the
    /// beginning of the file.
    void provide(
        std::shared_ptr<std::basic_streambuf<char>> firstFileFromGgufStream);
    /// @brief Releases the held streambuf reference. Call after metadata has
    /// been parsed and the streambuf is no longer needed.
    void clear();

  private:
    std::shared_ptr<std::basic_streambuf<char>> firstFileFromGgufStream_;
    std::mutex firstFileFromGgufStreamMutex_;
    std::condition_variable firstFileFromGgufStreamCv_;
    bool hasFirstFileFromGgufStream_ = false;
  };
  FirstFileFromGgufStreamState firstFileFromGgufStreamState;
};
