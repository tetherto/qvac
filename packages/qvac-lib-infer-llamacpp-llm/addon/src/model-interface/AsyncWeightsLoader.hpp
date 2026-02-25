#pragma once

#include <filesystem>
#include <map>
#include <memory>
#include <streambuf>
#include <string>
#include <thread>

#include <common/common.h>
#include <llama-cpp.h>

#include "ModelMetadata.hpp"
#include "addon/LlmErrors.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"
#include "qvac-lib-inference-addon-cpp/GGUFShards.hpp"
#include "qvac-lib-inference-addon-cpp/InitLoader.hpp"

using namespace qvac_lib_inference_addon_llama::errors;

/// @brief Encapsulates async/streaming weights loading for sharded and
/// single-GGUF models. Owns the streaming state and the buffered file map,
/// and delegates shard fulfillment to llama.cpp.
class AsyncWeightsLoader {
public:
  using Buf = std::basic_streambuf<char>;

  /// @param modelMetadata Optional. When provided, the first shard received
  /// via setWeightsForFile is lent to modelMetadata so that metadata parsing
  /// can proceed before the shard is handed to the weights engine.
  AsyncWeightsLoader(
      const GGUFShards& shards, InitLoader& initLoader,
      const std::string& loadingContext,
      ModelMetaData* modelMetadata = nullptr)
      : shards_(shards), initLoader_(initLoader),
        loadingContext_(loadingContext), modelMetadata_(modelMetadata) {}

  virtual ~AsyncWeightsLoader() = default;
  AsyncWeightsLoader(const AsyncWeightsLoader&) = delete;
  AsyncWeightsLoader& operator=(const AsyncWeightsLoader&) = delete;
  AsyncWeightsLoader(AsyncWeightsLoader&&) = delete;
  AsyncWeightsLoader& operator=(AsyncWeightsLoader&&) = delete;

  /// @brief Accept a streamed shard. For single-GGUF models the buffer is
  /// stored until init() consumes it; for sharded models the shard is
  /// fulfilled asynchronously via llama_model_load_fulfill_split_future.
  /// If a ModelMetaData was supplied at construction, the shard matching the
  /// first shard filename is lent to it and ownership is recovered before
  /// proceeding.
  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<Buf>&& shard) {
    isStreaming_ = true;

    if (shards_.gguf_files.empty()) {
      SharedBuffer lentShard(std::move(shard));
      if (shouldLendFirstShard(filename)) {
        modelMetadata_->firstFileFromGgufStreamState.provide(lentShard.shared());
      }
      streamedFiles_.emplace(filename, std::move(lentShard));
      return;
    }

    initLoader_.ensureLoadInBackground();
    if (shouldLendFirstShard(filename)) {
      // Spawn a separate thread so the calling (download) thread is not
      // blocked while waiting for metadata to release the shard.
      std::thread([this, filename, shard_ = std::move(shard)]() mutable {
        auto shard = lendFirstShardAndWaitForRelease(std::move(shard_));
        fulfillSplitFuture(filename, std::move(shard));
      }).detach();
    } else {
      fulfillSplitFuture(filename, std::move(shard));
    }
  }

  [[nodiscard]] bool isStreaming() const { return isStreaming_; }

  /// @brief Moves the unsharded files out of the AsyncWeightsLoader
  std::map<std::string, std::unique_ptr<Buf>> extractIndividualStreamedFiles() {
    std::map<std::string, std::unique_ptr<Buf>> extracted;
    for(auto& [filename, shard] : streamedFiles_) {
      extracted[filename] = shard.toUnique();
    }
    return extracted;
  }

  [[nodiscard]] bool
  hasIndividualStreamedFile(const std::string& filename) const {
    return streamedFiles_.contains(filename);
  }

protected:
  /// @brief Hands the shard to llama.cpp's split-future registry.
  /// Override in tests to avoid touching the global promise registry.
  virtual void fulfillSplitFuture(
      const std::string& filename, std::unique_ptr<Buf>&& shard) {
    if (!llama_model_load_fulfill_split_future(
            filename.c_str(), loadingContext_.c_str(), std::move(shard))) {
      std::string errorMsg = string_format(
          "%s: failed to load model from %s\n", __func__, filename.c_str());
      throw qvac_errors::StatusError(
          ADDON_ID, toString(UnableToLoadModel), errorMsg);
    }
  }

private:
  bool shouldLendFirstShard(const std::string& filename) const {
    if (modelMetadata_ == nullptr) {
      return false;
    }
    const std::string firstShard =
        shards_.gguf_files.empty()
            ? filename
            : std::filesystem::path(shards_.gguf_files.front())
                  .filename()
                  .string();
    return filename == firstShard;
  }

  /// @brief Wraps a unique_ptr as a shared_ptr (for lending to metadata) while
  /// keeping a clear path back to unique ownership via toUnique().
  class SharedBuffer {
  public:
    explicit SharedBuffer(std::unique_ptr<Buf>&& shard)
        : ptr_(shard.get(), Deleter{std::move(shard)}) {}

    SharedBuffer(SharedBuffer&& other) noexcept
        : ptr_(std::move(other.ptr_)) {}

    /// The shared_ptr to pass to firstFileFromGgufStreamState.provide().
    std::shared_ptr<Buf> shared() const { return ptr_; }

    /// Assert sole ownership then move the unique_ptr out.
    std::unique_ptr<Buf> toUnique() {
      if (ptr_.use_count() > 1) {
        throw qvac_errors::StatusError(
            ADDON_ID, toString(UnableToLoadModel),
            "First shard is still in use by metadata but should have been released.");
      }
      return std::get_deleter<Deleter>(ptr_)->release();
    }

  private:
    struct Deleter {
      std::unique_ptr<Buf> inner;
      void operator()(Buf*) noexcept { /* inner self-deletes if not released */ }
      std::unique_ptr<Buf> release() { return std::move(inner); }
    };
    std::shared_ptr<Buf> ptr_;
  };

  /// Lends @p shard to modelMetadata_ (sharded path only), blocks until
  /// metadata releases its reference, then returns the unique_ptr to the caller.
  std::unique_ptr<Buf> lendFirstShardAndWaitForRelease(
      std::unique_ptr<Buf>&& shard) {
    SharedBuffer lentShard(std::move(shard));
    modelMetadata_->firstFileFromGgufStreamState.provide(lentShard.shared());
    modelMetadata_->firstFileFromGgufStreamState.waitForRelease();
    return lentShard.toUnique();
  }

  const GGUFShards& shards_;
  InitLoader& initLoader_;
  const std::string& loadingContext_;
  ModelMetaData* modelMetadata_ = nullptr;

  bool isStreaming_ = false;
  std::map<std::string, SharedBuffer> streamedFiles_;
};
