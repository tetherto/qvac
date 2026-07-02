#pragma once

#include <any>
#include <cstdint>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../Logger.hpp"
#include "../ModelInterfaces.hpp"
#include "../Utils.hpp"
#include "../job/JobId.hpp"
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
  /// Each entry carries the originating JobId so consumers can correlate events.
  std::vector<std::pair<JobId, std::any>> outputQueue_;

  const model::IModel& model_;
  OutputCallBackInterface& outputCallback_;

  void queueOutput(std::any&& output, JobId id) {
    std::scoped_lock lk{mtx_};
    outputQueue_.emplace_back(id, std::move(output));
    outputCallback_.notify();
  }

public:
  explicit OutputQueue(
      OutputCallBackInterface& outputCallback, const model::IModel& model)
      : model_(model), outputCallback_(outputCallback) {}

  ~OutputQueue() = default;

  /// @brief Atomically drains and returns all pending tagged entries.
  std::vector<std::pair<JobId, std::any>> clear() {
    std::scoped_lock lk{mtx_};
    auto result = std::move(outputQueue_);
    outputQueue_ = {};
    return result;
  }

  /// Terminal event for a completed job. @p id routes the event; the payload is
  /// a whole-model runtimeStats() snapshot (see IModel::runtimeStats), not this
  /// job's private stats — under batching it aggregates across concurrent jobs.
  void queueJobEnded(JobId id = kNoJobId) {
    queueOutput(model_.runtimeStats(), id);
  }

  void queueResult(std::any&& output, JobId id = kNoJobId) {
    QLOG_DEBUG(
        std::string("[OutputQueue] queueResult called with type: ") +
        output.type().name());
    queueOutput(std::move(output), id);
  }

  void queueException(const std::exception& exception, JobId id = kNoJobId) {
    queueOutput(Output::Error{exception}, id);
  }
};
} // namespace qvac_lib_inference_addon_cpp
