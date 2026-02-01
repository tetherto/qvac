#pragma once

#include <map>

#include "BlobsStream.hpp"
#include "Errors.hpp"
#include "JsUtils.hpp"
#include "Logger.hpp"

namespace js_blobs {
using namespace qvac_lib_inference_addon_cpp;
using WeightsBlob = js::UniqueJsRef<js::Object>;
using ShardFilename = std::string;
using ShardContents = std::vector<WeightsBlob>;

/// @brief Blob stream taking ownership of all JS handles of a file.
template <typename T> class FinalizedStream : public BlobsStream<T> {
public:
  FinalizedStream(
      js_env_t* env, std::string filename, std::vector<WeightsBlob>&& data)
      : BlobsStream<T>(convert_to_blobs(env, data)),
        filename(std::move(filename)), owned_data(std::move(data)) {}

  FinalizedStream(const FinalizedStream&) = delete;
  FinalizedStream& operator=(const FinalizedStream&) = delete;
  FinalizedStream(FinalizedStream&&) = delete;
  FinalizedStream& operator=(FinalizedStream&&) = delete;

  const std::string filename;

private:
  std::vector<WeightsBlob> owned_data;

  static std::vector<std::pair<T*, std::size_t>>
  convert_to_blobs(js_env_t* env, std::vector<WeightsBlob>& data) {
    std::vector<std::pair<T*, std::size_t>> blobs;
    blobs.reserve(data.size());

    for (auto& weightsDataRef : data) {
      js::Object weightsData = weightsDataRef.get();
      auto contents = weightsData.getOptionalProperty<js::TypedArray<uint8_t>>(
          env, "chunk");

      if (contents.has_value()) {
        auto contents_span = contents->as<std::span<T>>(env);
        blobs.emplace_back(
            static_cast<T*>(contents_span.data()), contents_span.size());
      }
    }
    return blobs;
  }
};

template <typename T> class WeightsLoader {
public:
  WeightsLoader() = default;

  /// @returns A new stream when last blob is appended. Nullptr if not enough
  /// data yet
  std::unique_ptr<FinalizedStream<T>>
  appendBlob(js_env_t* env, WeightsBlob&& weightsDataRef) {
    js::Object weightsData = weightsDataRef.get();

    auto completed =
        weightsData.getOptionalProperty<js::Boolean>(env, "completed");
    auto contents =
        weightsData.getOptionalProperty<js::TypedArray<uint8_t>>(env, "chunk");

    if (!contents.has_value() && !completed.has_value()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "One of contents or completed is required");
    }

    std::string filename = weightsData.getProperty<js::String>(env, "filename")
                               .as<std::string>(env);
    shards_in_progress[filename].emplace_back(std::move(weightsDataRef));

    if (completed->as<bool>(env)) {
      auto it = shards_in_progress.find(filename);
      if (it != shards_in_progress.end()) {
        auto data = std::move(it->second);
        shards_in_progress.erase(it);
        QLOG(logger::Priority::DEBUG, "Finalizing shard " + filename);
        return std::make_unique<FinalizedStream<T>>(
            env, filename, std::move(data));
      }
      std::string error_message = "Finalized shard not found: " + filename;
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError, error_message.c_str());
    }

    return nullptr;
  }

private:
  std::map<ShardFilename, ShardContents> shards_in_progress;
};

} // namespace js_blobs
