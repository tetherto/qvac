#pragma once
#include <condition_variable>
#include <exception>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <tuple>
#include <type_traits>
#include <utility>

#include "Logger.hpp"

/// @brief Allows to call the init function of a model with a delayed load or
/// background load.
///
/// @note The intended usage is to allow to construct a C++ Model class during
/// JS addon creation without unexpected throws or immediate model loading into
/// memory. `InitLoader::init(LOADER_TYPE::DELAYED, ...)` will store the init
/// arguments and defer the model init call until `waitForLoadInitialization` or
/// `ensureLoadInBackground` are used. The JS code will be able to reliably
/// obtain `this.addon = this._createAddon(configurationParams)` prior to
/// triggering any download or streaming. The actual model init method can be
/// triggered by calling `waitForLoadInitialization` at `addon.activate()` or
/// `ensureLoadInBackground` at `addon.loadWeights(...)` /
/// `set_weights_for_file(...)` for models that support incremental file loading
/// (sharded).
class InitLoader {
public:
  enum LOADER_TYPE : short { DELAYED, BACKGROUND, IMMEDIATE };

  // @brief wait for init() to complete when delayed load has been used.
  void waitForLoadInitialization() {
    if (loadType_ == LOADER_TYPE::DELAYED) {
      triggerInit();
    }
    std::unique_lock<std::mutex> lock(initMutex_);
    initCv_.wait(lock, [this] { return initComplete_; });
    if (backgroundInit_.has_value()) {
      backgroundInit_->join();
      backgroundInit_.reset();
    }
    checkForErrors();
  }

  /// @brief Defers the model init call.
  /// @note When using LOADER_TYPE::DELAYED, the user needs to make sure the
  /// actual model weights/data is available before calling `addon.activate()`
  /// and triggering `waitForLoadInitialization`. That can be done by awaiting
  /// the model download/streaming completion in the JS code before calling
  /// `addon.activate()`.
  template <typename F, typename... Args>
  void init(LOADER_TYPE loadType, F initFunction, Args&&... args) {
    loadType_ = loadType;

    // Store arguments by value to avoid dangling references
    // Use std::decay_t to remove references and cv-qualifiers for storage
    using ArgsTuple = std::tuple<std::decay_t<Args>...>;
    ArgsTuple argsTuple(std::forward<Args>(args)...);

    auto syncInit = [this, initFunction](ArgsTuple& storedArgs) mutable {
      try {
        // Convert stored lvalues to rvalues when calling initFunction
        // The lambda uses auto&&... so it can accept rvalues and forward them
        // correctly
        std::apply(
            [&](auto&... args) { initFunction(std::move(args)...); },
            storedArgs);
      } catch (...) {
        initError_ = std::current_exception();
        std::string errorMsg = "Initialization failed in InitLoader::init():" +
                               std::to_string(__LINE__);
        if (loadType_ == LOADER_TYPE::DELAYED ||
            loadType_ == LOADER_TYPE::BACKGROUND) {
          errorMsg +=
              ".Hint, expected usage from JS: addon.activate() should be "
              "called only after awaiting model download/streaming completion";
        }
        QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR, errorMsg);
        std::lock_guard<std::mutex> lock(initMutex_);
        initComplete_ = true;
        initCv_.notify_all();
        return;
      }
      {
        std::lock_guard<std::mutex> lock(initMutex_);
        initComplete_ = true;
      }
      initCv_.notify_all();
    };

    // For background or delayed initialization, capture by value to avoid
    // dangling references
    delayedInit_.emplace(
        [syncInit, argsTuple = std::move(argsTuple)]() mutable {
          syncInit(argsTuple);
        });

    if (loadType == LOADER_TYPE::IMMEDIATE) {
      triggerInit();
      return;
    }

    if (loadType == LOADER_TYPE::BACKGROUND) {
      emplaceBackground();
    }
  }

  /// @brief Ensures background thread running on DELAYED and BACKGROUND
  void ensureLoadInBackground() {
    checkForErrors();
    if (loadType_ == LOADER_TYPE::IMMEDIATE) {
      // Already loaded at init call. Nothing to left to do.
      return;
    }
    if (loadType_ == LOADER_TYPE::DELAYED) {
      // Promote to background
      loadType_ = LOADER_TYPE::BACKGROUND;
    }
    if (loadType_ == LOADER_TYPE::BACKGROUND && !backgroundInit_.has_value() &&
        !initComplete_) {
      emplaceBackground();
    }
  }

  static std::string getLoadingContext(const std::string& modelName) {
    static int numInstances = 0;
    int instanceId = numInstances++;
    return modelName + std::to_string(instanceId);
  }

private:
  void triggerInit() {
    if (delayedInit_.has_value()) {
      delayedInit_.value()();
      delayedInit_.reset();
    }
    checkForErrors();
  }

  void emplaceBackground() {
    backgroundInit_.emplace([this]() mutable {
      this->delayedInit_.value()();
      this->delayedInit_.reset();
    });
  }

  void checkForErrors() {
    if (initError_.has_value()) {
      std::rethrow_exception(initError_.value());
    }
  }

  std::optional<std::thread> backgroundInit_ = std::nullopt;
  std::optional<std::function<void()>> delayedInit_ = std::nullopt;
  mutable std::mutex initMutex_;
  mutable std::condition_variable initCv_;
  bool initComplete_ = false;
  LOADER_TYPE loadType_ = LOADER_TYPE::IMMEDIATE;
  std::optional<std::exception_ptr> initError_ = std::nullopt;
};
