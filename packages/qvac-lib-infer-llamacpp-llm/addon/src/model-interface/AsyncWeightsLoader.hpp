#pragma once

#include <filesystem>
#include <future>
#include <map>
#include <memory>
#include <streambuf>
#include <string>

#include <common/common.h>
#include <llama-cpp.h>

#include "ModelMetadata.hpp"
#include "addon/LlmErrors.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"
#include "qvac-lib-inference-addon-cpp/GGUFShards.hpp"
#include "qvac-lib-inference-addon-cpp/InitLoader.hpp"
#include "utils/BorrowablePtr.hpp"

/// @brief Encapsulates async/streaming weights loading for sharded and
/// single-GGUF models. Owns the streaming state and the buffered file map,
/// and delegates shard fulfillment to llama.cpp.
class AsyncWeightsLoader {
public:
  using Buf = std::basic_streambuf<char>;
  using SharedBuffer = BorrowablePtr<Buf>;

  /// @param modelMetadata Optional. When provided, the first shard received
  /// via setWeightsForFile is lent to modelMetadata so that metadata parsing
  /// can proceed before the shard is handed to the weights engine.
  AsyncWeightsLoader(
      const GGUFShards& shards, InitLoader& initLoader,
      const std::string& loadingContext,
      ModelMetaData* modelMetadata = nullptr);

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
  /// @note C++ side expectation: calls are externally serialized and come from
  /// the same thread (typically the JS event-loop / download thread). If this
  /// method is invoked concurrently from multiple native threads, additional
  /// synchronization is required by the caller.
  /// @note For sharded models, the caller is responsible for eventually
  /// calling this with the last shard filename. If the last-shard call never
  /// happens, downstream llama.cpp model initialization may block waiting for
  /// shard completion.
  void
  setWeightsForFile(const std::string& filename, std::unique_ptr<Buf>&& shard);

  [[nodiscard]] bool isStreaming() const { return isStreaming_; }

  /// @brief Moves the unsharded files out of the AsyncWeightsLoader
  std::map<std::string, std::unique_ptr<Buf>> extractIndividualStreamedFiles();

  [[nodiscard]] bool
  hasIndividualStreamedFile(const std::string& filename) const;

protected:
  /// @brief Hands the shard to llama.cpp's split-future registry.
  /// Override in tests to avoid touching the global promise registry.
  virtual void fulfillSplitFuture(
      const std::string& filename, std::unique_ptr<Buf>&& shard) {
    using namespace qvac_lib_inference_addon_llama::errors;
    if (!llama_model_load_fulfill_split_future(
            filename.c_str(), loadingContext_.c_str(), std::move(shard))) {
      std::string errorMsg = string_format(
          "%s: failed to load model from %s\n", __func__, filename.c_str());
      throw qvac_errors::StatusError(
          ADDON_ID, toString(UnableToLoadModel), errorMsg);
    }
  }

private:
  /// @brief Waits for the first-shard async worker (if started) and rethrows
  /// any exception raised in that worker.
  void joinFirstShardWorker();

  [[nodiscard]] bool
  isFirstShard(const std::filesystem::path& filenamePath) const;
  [[nodiscard]] bool
  shouldLendFirstShard(const std::filesystem::path& filenamePath) const;
  [[nodiscard]] bool
  isLastShard(const std::filesystem::path& filenamePath) const;

  /// Lends @p shard to modelMetadata_ (sharded path only), blocks until
  /// metadata releases its reference, then returns the unique_ptr to the
  /// caller.
  std::unique_ptr<Buf>
  lendFirstShardAndWaitForRelease(std::unique_ptr<Buf>&& shard);

  // Timeout for waitForRelease (seconds) — fires if the metadata parser
  // gets stuck and never finishes consuming/releasing the streamed buffer.
  static constexpr int64_t METADATA_RELEASE_TIMEOUT_SEC = 60;

  // These references are safe because LlamaModel owns both the referenced
  // objects and this AsyncWeightsLoader in the same struct; C++ guarantees
  // members are destroyed in reverse declaration order, so the loader is
  // destroyed before the objects it references.
  const GGUFShards& shards_;
  InitLoader& initLoader_;
  const std::string& loadingContext_;
  ModelMetaData* modelMetadata_ = nullptr;

  bool isStreaming_ = false;
  std::map<std::string, SharedBuffer> streamedFiles_;
  std::future<void> firstShardWorker_;
};
