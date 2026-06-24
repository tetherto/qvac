#pragma once

#include <any>
#include <cstdint>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "../Logger.hpp"
#include "../ModelInterfaces.hpp"
#include "../Utils.hpp"
#include "OutputCallbackInterface.hpp"

namespace qvac_lib_inference_addon_cpp {

namespace Output {
struct LogMsg : std::string {
  using std::string::string;
};
struct Error : std::string {
  using std::string::string;
  Error(const std::exception& e) : std::string(e.what()) {}
};
} // namespace Output

class OutputQueue {
  std::mutex mtx_;
  std::vector<std::any> outputQueue_;

  const model::IModel& model_;
  OutputCallBackInterface& outputCallback_;

  void queueOutput(std::any&& output) {
    std::scoped_lock lk{mtx_};
    outputQueue_.emplace_back(std::move(output));
    outputCallback_.notify();
  }

public:
  explicit OutputQueue(
      OutputCallBackInterface& outputCallback, const model::IModel& model)
      : model_(model), outputCallback_(outputCallback) {}

  ~OutputQueue() = default;

  /// @brief Returns the current output queue and clears the internal queue.
  std::vector<std::any> clear() {
    std::scoped_lock lk{mtx_};
    auto result = std::move(outputQueue_);
    outputQueue_ = std::vector<std::any>();
    return result;
  }

  void queueJobEnded() { return queueOutput(model_.runtimeStats()); }

  void queueResult(std::any&& output) {
    QLOG_DEBUG(
        std::string("[OutputQueue] queueResult called with type: ") +
        output.type().name());
    queueOutput(std::move(output));
  }

  void queueException(const std::exception& exception) {
    queueOutput(Output::Error{exception});
  }
};
} // namespace qvac_lib_inference_addon_cpp
