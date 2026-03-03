#include "model-interface/AsyncWeightsLoader.hpp"

#include <chrono>

using namespace qvac_lib_inference_addon_llama::errors;

AsyncWeightsLoader::AsyncWeightsLoader(
    const GGUFShards& shards, InitLoader& initLoader,
    const std::string& loadingContext)
    : shards_(shards), initLoader_(initLoader),
      loadingContext_(loadingContext) {}

void AsyncWeightsLoader::setWeightsForFile(
    const std::string& filename, std::unique_ptr<Buf>&& shard) {
  const std::filesystem::path filenamePath(filename);
  isStreaming_ = true;

  if (shards_.gguf_files.empty()) {
    auto [streamedFilesIt, inserted] =
        streamedFiles_.emplace(filename, std::move(shard));
    if (!inserted) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToLoadModel),
          "Duplicate streamed shard filename: " + filename);
    }
    return;
  }

  // This will trigger the init method of LlamaModel
  //
  // When using metadata, it should only start whent the first
  // shard is available. Because we do not want to time-out at init
  // waiting for the first shard.
  initLoader_.ensureLoadInBackground();

  fulfillSplitFuture(filename, std::move(shard));
}

std::map<std::string, std::unique_ptr<AsyncWeightsLoader::Buf>>
AsyncWeightsLoader::extractIndividualStreamedFiles() {
  std::map<std::string, std::unique_ptr<Buf>> extracted;
  for (auto& [filename, shard] : streamedFiles_) {
    extracted[filename] = std::move(shard);
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
