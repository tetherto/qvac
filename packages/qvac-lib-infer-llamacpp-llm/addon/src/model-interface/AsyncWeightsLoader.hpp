#pragma once

#include <map>
#include <memory>
#include <streambuf>
#include <string>

#include <common/common.h>
#include <llama-cpp.h>

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
      const std::string& loadingContext)
      : shards_(shards), initLoader_(initLoader),
        loadingContext_(loadingContext) {}

  virtual ~AsyncWeightsLoader() = default;
  AsyncWeightsLoader(const AsyncWeightsLoader&) = delete;
  AsyncWeightsLoader& operator=(const AsyncWeightsLoader&) = delete;
  AsyncWeightsLoader(AsyncWeightsLoader&&) = delete;
  AsyncWeightsLoader& operator=(AsyncWeightsLoader&&) = delete;

  /// @brief Accept a streamed shard. For single-GGUF models the buffer is
  /// stored until init() consumes it; for sharded models the shard is
  /// fulfilled asynchronously via llama_model_load_fulfill_split_future.
  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard) {
    isStreaming_ = true;

    if (shards_.gguf_files.empty()) {
      if (shouldLendFirstShard(filename)) {
        shard = lendFirstShard(std::move(shard));
      }
      streamedFiles_[filename] = std::move(shard);
      return;
    }

    initLoader_.ensureLoadInBackground();
    if(shouldLendFirstShard(filename)) {
      // Do operation in a separate thread to avoid blocking calling thread
      // thread that could be handling download operations.
      std::thread([this, filename, shardT= std::move(shard)]() mutable {
        auto shard = lendFirstShard(std::move(shardT));
        fulfillSplitFuture(filename, std::move(shard));
      }).detach();
    } else {
      fulfillSplitFuture(filename, std::move(shard));
    }
  }

  [[nodiscard]] bool isStreaming() const { return isStreaming_; }

  /// Mutable access so that initFromConfig can consume/erase entries.
  auto& streamedFiles() { return streamedFiles_; }

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

  /// Lends @p shard to modelMetadata_, blocks until metadata releases its
  /// reference, then returns the unique_ptr to the caller.
  std::unique_ptr<Buf> lendFirstShard(std::unique_ptr<Buf>&& shard, bool waitForRelease = true) {
    /// Holds a unique_ptr inside a shared_ptr's deleter so ownership can be
    /// recovered via get_deleter<ShardDeleter>()->release() when use_count == 1.
    struct ShardDeleter {
      std::unique_ptr<Buf> inner;
      void operator()(Buf*) noexcept { /* inner self-deletes if not released */ }
      std::unique_ptr<Buf> release() { return std::move(inner); }
    };
    auto lentShard = std::shared_ptr<Buf>(
        shard.get(), ShardDeleter{std::move(shard)});
    modelMetadata_->firstFileFromGgufStreamState.provide(lentShard);
    modelMetadata_->firstFileFromGgufStreamState.waitForRelease();
    if (lentShard.use_count() > 1) {
      throw qvac_errors::StatusError(
          ADDON_ID, toString(UnableToLoadModel),
          "First shard is still in use by metadata but should have been released.");
    }
    return std::get_deleter<ShardDeleter>(lentShard)->release();
  }

  [[nodiscard]] bool isStreaming() const { return isStreaming_; }

  /// Mutable access so that initFromConfig can consume/erase entries.
  auto& streamedFiles() { return streamedFiles_; }

private:
  const GGUFShards& shards_;
  InitLoader& initLoader_;
  const std::string& loadingContext_;

  bool isStreaming_ = false;
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>>
      streamedFiles_;
};
