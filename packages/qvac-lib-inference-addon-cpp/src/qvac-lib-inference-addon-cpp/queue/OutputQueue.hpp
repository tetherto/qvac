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

using JobId = uint64_t;

enum class OutputEventKind {
  Output,
  JobEnded,
  Error
};

struct QueuedOutputEvent {
  JobId jobId;
  OutputEventKind eventKind;
  std::any payload;
};

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
  std::vector<QueuedOutputEvent> outputQueue_;

  const model::IModel& model_;
  OutputCallBackInterface& outputCallback_;

  void queueOutput(JobId jobId, OutputEventKind eventKind, std::any&& output) {
    std::scoped_lock lk{mtx_};
    outputQueue_.emplace_back(QueuedOutputEvent{
        jobId,
        eventKind,
        std::move(output),
    });
    outputCallback_.notify();
  }

public:
  explicit OutputQueue(
      OutputCallBackInterface& outputCallback, const model::IModel& model)
      : model_(model), outputCallback_(outputCallback) {}

  ~OutputQueue() = default;

  /// @brief Returns the current output queue and clears the internal queue.
  std::vector<QueuedOutputEvent> clear() {
    std::scoped_lock lk{mtx_};
    auto result = std::move(outputQueue_);
    outputQueue_ = std::vector<QueuedOutputEvent>();
    return result;
  }

  void queueJobEnded(JobId jobId) {
    return queueOutput(jobId, OutputEventKind::JobEnded, model_.runtimeStats());
  }

  void queueResult(JobId jobId, std::any&& output) {
    QLOG_DEBUG(
        std::string("[OutputQueue] queueResult called with type: ") +
        output.type().name());
    queueOutput(jobId, OutputEventKind::Output, std::move(output));
  }

  void queueException(JobId jobId, const std::exception& exception) {
    queueOutput(jobId, OutputEventKind::Error, Output::Error{exception});
  }
};
} // namespace qvac_lib_inference_addon_cpp
