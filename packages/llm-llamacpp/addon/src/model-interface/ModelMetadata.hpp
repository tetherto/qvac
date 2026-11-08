#pragma once

#include <cstdint>
#include <initializer_list>
#include <memory>
#include <optional>
#include <string>

#include <llama-cpp.h>

#include "addon/LlmErrors.hpp"

/// @brief Access model metadata without loading weights into memory.
/// @details After parse(), all GGUF key-values are held in-memory and can be
/// queried without loading model weights.
class ModelMetaData {
  void checkInitialized() const;
  metadata_handle_ptr metadata_;

public:
  ModelMetaData() = default;
  virtual ~ModelMetaData() = default;

  /// @param modelPath A GGUF disk path, or the first shard of a split GGUF.
  /// @param addonId Identifier for error reporting.
  void parse(const std::string& modelPath, const char* addonId);

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
};
