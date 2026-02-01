#pragma once

#include <js.h>

#include "../JsBlobsStream.hpp"
#include "../JsUtils.hpp"
#include "../Logger.hpp"
#include "../ModelInterfaces.hpp"
#include "AddonCpp.hpp"

namespace qvac_lib_inference_addon_cpp {

/// @brief Extends pure C++ AddonCpp class with JS specific functionality (e.g.
/// JS blob stream loading for model weights)
class AddonJs {
  std::mutex mtx_;
  js_env_t* env_;
  js_blobs::WeightsLoader<char> weights_loader_;
  js::ThreadQueuedRefDeleter weights_deleter_ = {};

public:
  const std::unique_ptr<AddonCpp> addonCpp;

  AddonJs(
      js_env_t* env, std::unique_ptr<OutputCallBackInterface>&& outputCallback,
      std::unique_ptr<model::IModel>&& model)
      : env_(env), addonCpp(
                       std::make_unique<AddonCpp>(
                           std::move(outputCallback), std::move(model))) {}

  ~AddonJs() = default;

  /**
   * @brief Loads model weights from JavaScript blob data
   * @param env JavaScript environment handle
   * @param weightsData JavaScript value containing weights blob data
   */
  void loadWeights(js_env_t* env, js_value_t* weightsData) {
    {
      model::IModelAsyncLoad* asyncLoad = addonCpp->asyncLoad;
      if (asyncLoad == nullptr) {
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
            "Tried to load weights but model '" +
                addonCpp->model.get().getName() +
                "' does not implement IModelAsyncLoad interface.");
        return;
      }

      std::scoped_lock lock(mtx_);

      js_blobs::WeightsBlob weightsDataBlob(
          this->env_, weightsData, &this->weights_deleter_);

      std::unique_ptr<js_blobs::FinalizedStream<char>> finalized =
          weights_loader_.appendBlob(this->env_, std::move(weightsDataBlob));
      if (finalized) {
        const std::string& filename = finalized->filename;
        std::unique_ptr<std::basic_streambuf<char>> shard_streambuf(
            std::move(finalized));
        // Should block on last weights file to wait for model to be loaded.
        asyncLoad->setWeightsForFile(filename, std::move(shard_streambuf));

        // Clear blobs marked for deletion on same loading thread.
        constexpr bool force_sync = true;
        this->weights_deleter_.template clear<force_sync>();
      } else {
        constexpr bool force_sync = false;
        this->weights_deleter_.template clear<force_sync>();
      }
    }
  }
};

} // namespace qvac_lib_inference_addon_cpp
