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
  /// Non-null when the model reports per-job observed stats; discovered from
  /// the model itself so no construction site changes.
  const model::IModelJobStats* const jobStats_;
  OutputCallBackInterface& outputCallback_;

  void queueOutput(std::any&& output, JobId id) {
    std::scoped_lock lk{mtx_};
    outputQueue_.emplace_back(id, std::move(output));
    outputCallback_.notify();
  }

public:
  explicit OutputQueue(
      OutputCallBackInterface& outputCallback, const model::IModel& model)
      : model_(model),
        jobStats_(dynamic_cast<const model::IModelJobStats*>(&model)),
        outputCallback_(outputCallback) {}

  ~OutputQueue() = default;

  /// @brief Atomically drains and returns all pending tagged entries.
  std::vector<std::pair<JobId, std::any>> clear() {
    std::scoped_lock lk{mtx_};
    auto result = std::move(outputQueue_);
    outputQueue_ = {};
    return result;
  }

  /// Terminal event for a completed job. @p id routes the event. A tagged job
  /// on a model implementing IModelJobStats gets its own snapshot as the
  /// payload (empty answer -> generic snapshot, the model's way of saying this
  /// job has no per-job figures). A tagged job on a model WITHOUT the
  /// interface falls back to the generic whole-model runtimeStats() snapshot
  /// with a warning. Untagged (kNoJobId) jobs use the generic snapshot by
  /// default, silently.
  void queueJobEnded(JobId id = kNoJobId) {
    if (id != kNoJobId) {
      if (jobStats_ != nullptr) {
        RuntimeStats jobStats = jobStats_->consumeJobStats(id);
        if (!jobStats.empty()) {
          queueOutput(std::move(jobStats), id);
          return;
        }
      } else {
        QLOG(logger::Priority::WARNING,
            "Model has no per-job stats (IModelJobStats); using the "
            "whole-model snapshot for a tagged job");
      }
    }
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
