#include "model-interface/AsyncWeightsLoader.hpp"

#include <chrono>

#include "model-interface/ModelMetadata.hpp"

using namespace qvac_lib_inference_addon_llama::errors;

AsyncWeightsLoader::AsyncWeightsLoader(
    const GGUFShards& shards, InitLoader& initLoader,
    const std::string& loadingContext, ModelMetaData* modelMetadata)
    : shards_(shards), initLoader_(initLoader), loadingContext_(loadingContext),
      modelMetadata_(modelMetadata) {}

void AsyncWeightsLoader::setWeightsForFile(
    const std::string& filename, std::unique_ptr<Buf>&& shard) {
  const std::filesystem::path filenamePath(filename);
  isStreaming_ = true;

  // Surface first-shard worker errors immediately.
  if (firstShardWorker_.valid() &&
      firstShardWorker_.wait_for(std::chrono::seconds(0)) ==
          std::future_status::ready) {
    firstShardWorker_.get();
  }

  if (shards_.gguf_files.empty()) {
    auto [streamedFilesIt, inserted] =
        streamedFiles_.emplace(filename, SharedBuffer(std::move(shard)));
    if (!inserted) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToLoadModel),
          "Duplicate streamed shard filename: " + filename);
    }
    if (shouldLendFirstShard(filenamePath)) {
      modelMetadata_->firstFileFromGgufStreamState.provide(
          streamedFilesIt->second);
    }
    return;
  }

  if (modelMetadata_ == nullptr || isFirstShard(filenamePath)) {
    // This will trigger the init method of LlamaModel
    //
    // When using metadata, it should only start whent the first
    // shard is available. Because we do not want to time-out at init
    // waiting for the first shard.
    initLoader_.ensureLoadInBackground();
  }

  if (shouldLendFirstShard(filenamePath)) {
    // Launch asynchronously so the calling (download) thread is not blocked
    // while waiting for metadata to release the shard.
    if (firstShardWorker_.valid()) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToLoadModel),
          "First-shard worker already started.");
    }
    firstShardWorker_ = std::async(
        std::launch::async,
        [this, filename, lambdaShard = std::move(shard)]() mutable {
          auto shard = lendFirstShardAndWaitForRelease(std::move(lambdaShard));
          fulfillSplitFuture(filename, std::move(shard));
        });
  } else {
    fulfillSplitFuture(filename, std::move(shard));
  }

  // Make sure that last-shard checks if first-shard did complete successfully.
  //
  // A model is treated as sharded only when it has at least 2 shard files.
  // `gguf_files` may still contain a single-GGUF path for non-sharded loads.
  // In that case `isLastShard()` should evaluate false and this is a no-op.
  if (isLastShard(filenamePath)) {
    joinFirstShardWorker();
  }
}

void AsyncWeightsLoader::joinFirstShardWorker() {
  if (!firstShardWorker_.valid()) {
    return;
  }
  firstShardWorker_.get();
}

std::map<std::string, std::unique_ptr<AsyncWeightsLoader::Buf>>
AsyncWeightsLoader::extractIndividualStreamedFiles() {
  joinFirstShardWorker();
  std::map<std::string, std::unique_ptr<Buf>> extracted;
  for (auto& [filename, shard] : streamedFiles_) {
    extracted[filename] = shard.reclaimUnique();
  }
  return extracted;
}

bool AsyncWeightsLoader::hasIndividualStreamedFile(
    const std::string& filename) const {
  const std::string normalizedFilename =
      std::filesystem::path(filename).filename().string();
  return streamedFiles_.contains(normalizedFilename);
}

bool AsyncWeightsLoader::isFirstShard(
    const std::filesystem::path& filenamePath) const {
  const std::string normalizedFilename = filenamePath.filename().string();
  const std::string firstShard =
      shards_.gguf_files.empty()
          ? normalizedFilename
          : std::filesystem::path(shards_.gguf_files.front())
                .filename()
                .string();
  return normalizedFilename == firstShard;
}

bool AsyncWeightsLoader::shouldLendFirstShard(
    const std::filesystem::path& filenamePath) const {
  return modelMetadata_ != nullptr && isFirstShard(filenamePath);
}

bool AsyncWeightsLoader::isLastShard(
    const std::filesystem::path& filenamePath) const {
  if (shards_.gguf_files.empty()) {
    return false;
  }
  const std::string normalizedFilename = filenamePath.filename().string();
  const std::string lastShard =
      std::filesystem::path(shards_.gguf_files.back()).filename().string();
  return normalizedFilename == lastShard;
}

std::unique_ptr<AsyncWeightsLoader::Buf>
AsyncWeightsLoader::lendFirstShardAndWaitForRelease(
    std::unique_ptr<Buf>&& shard) {
  SharedBuffer lentShard(std::move(shard));
  modelMetadata_->firstFileFromGgufStreamState.provide(lentShard);
  modelMetadata_->firstFileFromGgufStreamState
      .waitForRelease<METADATA_RELEASE_TIMEOUT_SEC>();
  return lentShard.reclaimUnique();
}
