#pragma once

#include <cstdint>
#include <initializer_list>
#include <memory>
#include <optional>
#include <string>

#include <llama-cpp.h>

#include "addon/BertErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"

/// @brief Access model metadata without loading weights into memory.
/// @details After parse(), all GGUF key-values are held in-memory and can be
/// queried without loading model weights.
class ModelMetaData {
  metadata_handle_ptr metadata_;
  std::string diskPath_;

public:
  ModelMetaData() = default;
  ~ModelMetaData() = default;

  ModelMetaData(const ModelMetaData&) = delete;
  ModelMetaData& operator=(const ModelMetaData&) = delete;
  ModelMetaData(ModelMetaData&&) = delete;
  ModelMetaData& operator=(ModelMetaData&&) = delete;

  /// @param modelPath A GGUF disk path, or the first shard of a split GGUF.
  /// @param addonId Identifier for error reporting.
  void parse(const std::string& modelPath, const char* addonId);

  /// @brief Returns the u32 value at @p key, or nullopt if absent.
  [[nodiscard]] std::optional<uint32_t> tryGetU32(const char* key) const;

  /// @brief Returns the string value at @p key, or nullopt if absent or not a
  /// string type.
  [[nodiscard]] std::optional<std::string> tryGetString(const char* key) const;

  /// @brief The GGUF's default pooling (`<arch>.pooling_type`), or nullopt if
  /// it declares none.
  [[nodiscard]] std::optional<uint32_t> tryGetPoolingType() const;

  /// @brief Whether any tensor named in @p names is in the model's GGUF files,
  /// read from their headers in one pass without loading weights. nullopt for
  /// an unreadable or invalid shard header.
  [[nodiscard]] std::optional<bool>
  hasAnyTensor(std::initializer_list<const char*> names) const;
};
