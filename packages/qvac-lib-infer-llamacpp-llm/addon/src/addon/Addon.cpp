#include "Addon.hpp"

#include <sstream>
#include <utility>

#include "common/common.h"
#include "model-interface/LlamaModel.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "utils/LoggingMacros.hpp"

namespace qvac_lib_inference_addon_cpp {
// NOLINTNEXTLINE(cppcoreguidelines-pro-type-member-init)
template <>
template <>
Addon<LlamaModel>::Addon(
    js_env_t *env, std::reference_wrapper<const std::string> modelPath,
    std::reference_wrapper<const std::string> projectionPath,
    std::reference_wrapper<std::unordered_map<std::string, std::string>>
      configFilemap,
    js_value_t *jsHandle, js_value_t *outputCb, js_value_t *transitionCb)
    : env_{env}, transitionCb_{transitionCb},
      model_{modelPath, projectionPath, configFilemap} {
  QLOG_IF(
      logger::Priority::INFO,
      "Initializing LlamaModel addon with model path: " +
          std::string(modelPath.get()));
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
  QLOG_IF(logger::Priority::INFO, "LlamaModel addon initialized successfully");
}

// NOLINTNEXTLINE(cppcoreguidelines-pro-type-member-init)
template <>
template <>
Addon<LlamaModel>::Addon(// NOLINTNEXTLINE(cppcoreguidelines-pro-type-member-init)

    js_env_t *env, std::reference_wrapper<const std::string> modelPath,
    std::reference_wrapper<std::unordered_map<std::string, std::string>>
      configFilemap,
    js_value_t *jsHandle, js_value_t *outputCb, js_value_t *transitionCb)
    : env_{env}, transitionCb_{transitionCb},
      model_{modelPath, "", configFilemap} {
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
}

template <>
LlamaModel::Input qvac_lib_inference_addon_llama::Addon::getNextPiece(
    LlamaModel::Input& input, size_t /*lastPieceEnd*/) {
  return input;
}

template <>
uint32_t qvac_lib_inference_addon_llama::Addon::append(
    int priority, LlamaModel::Input input) {
  uint32_t jobId = 0;
  constexpr int kDefaultPriority = 50;
  {
    std::scoped_lock lock{ mtx_ };
    if (lastAppendedJob_ != nullptr) {
      jobId = lastAppendedJob_->id;
      // derive priority_queue so we can add a method to update the priority
    } else {
      auto newJob = std::make_unique<Job<LlamaModel::Input>>(++jobIds_);
      lastAppendedJob_ = newJob.get();
      jobId = lastAppendedJob_->id;
      try {
        jobQueue_.emplace(
            priority == -1 ? kDefaultPriority : priority, std::move(newJob));
      } catch (...) {
        lastAppendedJob_ = nullptr;
        throw;
      }
    }
    auto &chunks = lastAppendedJob_->chunks;
    if (!chunks.empty() && chunks.back().index() == input.index()) {
      std::visit(
          [&](auto& dst, auto&& src) {
            using D = std::decay_t<decltype(dst)>;
            using S = std::decay_t<decltype(src)>;
            if constexpr (
                std::is_same_v<D, std::string> &&
                std::is_same_v<S, std::string>) {
              dst.append(src);
            } else if constexpr (
                std::is_same_v<D, std::vector<uint8_t>> &&
                std::is_same_v<S, std::vector<uint8_t>>) {
              chunks.emplace_back(std::forward<decltype(src)>(src));
            }
          },
          chunks.back(),
          std::move(input));
    } else {
      chunks.emplace_back(std::move(input));
    }
  }
  processCv_.notify_one();
  return jobId;
}

  // This is a template specialization of the process() function specifically for LlamaModel
  // Unlike other models, LlamaModel streams its output through callbacks rather than returning
  // complete responses. This specialization handles the streaming nature of LLaMA's output
  // by processing input in pieces and handling the incremental token generation.
template <>
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void Addon<LlamaModel>::process() {

  std::unique_ptr<Job<LlamaModel::Input>> currentJob;
  auto cleanupLastAppended = utils::onError([&currentJob, this]() {
    auto scopedLock = std::scoped_lock{mtx_};
    if (currentJob.get() == lastAppendedJob_) {
      lastAppendedJob_ = nullptr;
    }
  });
  LlamaModel::Input input;
  size_t lastPieceEnd = 0;

  // Helper lambda to check if variant input is empty
  auto isInputEmpty = [](const LlamaModel::Input& inp) {
    return std::visit([](const auto& val) { return val.empty(); }, inp);
  };

  // Helper lambda to clear variant input
  auto clearInput = [](LlamaModel::Input& inp) {
    std::visit([](auto& val) { val.clear(); }, inp);
  };

  // Helper lambda to get size of variant input
  auto getInputSize = [](const LlamaModel::Input& inp) {
    return std::visit([](const auto& val) { return val.size(); }, inp);
  };

  while (running_) {
    std::unique_lock uniqueLock(mtx_);
    constexpr int kProcessWaitMs = 100;
    processCv_.wait_for(uniqueLock, std::chrono::milliseconds{kProcessWaitMs});
    if (signal_ != ProcessSignals::None) {
      switch (signal_) {
      case ProcessSignals::Activate:
        status_ = AddonStatus::Processing;
        break;
      case ProcessSignals::Stop:
        status_ = AddonStatus::Stopped;
        model_.reset();
        if (currentJob && currentJob.get() == lastAppendedJob_) {
          lastAppendedJob_ = nullptr;
        }
        currentJob.reset();
        clearInput(input);
        break;
      case ProcessSignals::Pause:
        status_ = AddonStatus::Paused;
        break;
      case ProcessSignals::Cancel:
        QLOG_IF(
            logger::Priority::INFO,
            string_format(
                "[C++] Addon::process() processing Cancel signal, "
                "cancelJobId_=%u\n",
                cancelJobId_));
        if (currentJob &&
            (cancelJobId_ == 0 || currentJob->id == cancelJobId_)) {
          QLOG_IF(
              logger::Priority::INFO,
              string_format(
                  "[C++] Addon::process() canceling job %u, queuing JobEnded\n",
                  currentJob->id));
          queueOutput(
              ModelOutput{
                  OutputEvent::JobEnded,
                  currentJob->id,
                  model_.runtimeStats()});
          model_.reset();
          if (currentJob.get() == lastAppendedJob_) {
            lastAppendedJob_ = nullptr;
            QLOG_IF(
                logger::Priority::INFO,
                string_format("[C++] Addon::process() cleared lastAppendedJob_ "
                              "during cancel\n"));
          }
          currentJob.reset();
          cancelJobId_ = 0;
          clearInput(input);
          QLOG_IF(
              logger::Priority::INFO,
              string_format(
                  "[C++] Addon::process() cancel processing complete\n"));
        } else {
          QLOG_IF(
              logger::Priority::INFO,
              string_format(
                  "[C++] Addon::process() cancel signal ignored "
                  "(currentJob=%p, cancelJobId_=%u)\n",
                  currentJob.get(),
                  cancelJobId_));
        }
        break;
      default:
        std::cout << '\n';
        break;
      }
      signal_ = ProcessSignals::None;
    }
    if (status_ == AddonStatus::Stopped || status_ == AddonStatus::Paused ||
        status_ == AddonStatus::Loading) {
      continue;
    }
    if (currentJob == nullptr) {
      // get next job
      if (jobQueue_.empty()) {
        status_ = AddonStatus::Idle;
        continue;
      }
      currentJob = std::move(jobQueue_.top().job);
      jobQueue_.pop();
      status_ = AddonStatus::Processing;
      QLOG_IF(
          logger::Priority::INFO,
          string_format(
              "[C++] Addon::process() starting job %u, queuing JobStarted\n",
              currentJob->id));
      queueOutput(ModelOutput{OutputEvent::JobStarted, currentJob->id});
    }
    if (isInputEmpty(input)) {
      // grab next chunk of input
      if (currentJob->chunks.empty()) {
        // no more input, check if end of job
        if (currentJob.get() != lastAppendedJob_) {
          // job ended
          queueOutput(
              ModelOutput{
                  OutputEvent::JobEnded,
                  currentJob->id,
                  model_.runtimeStats()});
          model_.reset();
          currentJob.reset();
          continue;
        }
        // wait for more input
        status_ = AddonStatus::Listening;
        continue;
      }
      input = std::move(currentJob->chunks.front());
      currentJob->chunks.pop_front();
      lastPieceEnd = 0;
      status_ = AddonStatus::Processing;
    }
    uniqueLock.unlock();
    // process input in small pieces
    auto piece = getNextPiece(input, lastPieceEnd);
    lastPieceEnd += getInputSize(piece);
    if (lastPieceEnd == getInputSize(input)) {
      clearInput(input);
    }
    try {
      auto queueOutputCb = [&](const std::string& tokenOut) {
        std::scoped_lock slk{mtx_};
        queueOutput(ModelOutput{OutputEvent::Output, currentJob->id, tokenOut});
      };
      model_.process(piece, queueOutputCb);
    } catch (const std::exception& e) {
      // Error, cancel current job
      auto jobId = currentJob->id;
      QLOG_IF(
          logger::Priority::INFO,
          string_format(
              "[C++] Addon::process() caught exception for job %u: %s\n",
              jobId,
              e.what()));
      uniqueLock.lock();
      QLOG_IF(
          logger::Priority::INFO,
          string_format(
              "[C++] Addon::process() queuing Error event for job %u\n",
              jobId));
      queueOutput(ModelOutput{
          OutputEvent::Error, jobId, typename ModelOutput::Error{e.what()}});
      QLOG_IF(
          logger::Priority::INFO,
          string_format(
              "[C++] Addon::process() Error event queued for job %u\n", jobId));
      QLOG_IF(
          logger::Priority::INFO,
          string_format(
              "[C++] Addon::process() queuing JobEnded event for job %u\n",
              jobId));
      queueOutput(
          ModelOutput{OutputEvent::JobEnded, jobId, model_.runtimeStats()});
      QLOG_IF(
          logger::Priority::INFO,
          string_format(
              "[C++] Addon::process() JobEnded event queued for job %u\n",
              jobId));
      QLOG_IF(
          logger::Priority::INFO,
          string_format(
              "[C++] Addon::process() resetting model and clearing job %u\n",
              jobId));
      model_.reset();
      if (currentJob.get() == lastAppendedJob_) {
        lastAppendedJob_ = nullptr;
        QLOG_IF(
            logger::Priority::INFO,
            string_format(
                "[C++] Addon::process() cleared lastAppendedJob_ for job %u\n",
                jobId));
      }
      currentJob.reset();
      clearInput(input);
      QLOG_IF(
          logger::Priority::INFO,
          string_format(
              "[C++] Addon::process() error handling complete for job %u\n",
              jobId));
    }
  }
}

// Override cancel methods to immediately stop model processing
template <> void Addon<LlamaModel>::cancel(uint32_t jobId) {
  QLOG_IF(
      logger::Priority::INFO,
      string_format("[C++] Addon::cancel() called for job %u\n", jobId));
  {
    std::scoped_lock lock{mtx_};
    cancelJobId_ = jobId;
    signal_ = ProcessSignals::Cancel;
    model_.stop();
    QLOG_IF(
        logger::Priority::INFO,
        string_format(
            "[C++] Addon::cancel() set signal and stopped model for job %u\n",
            jobId));
  }
  processCv_.notify_one();
  QLOG_IF(
      logger::Priority::INFO,
      string_format(
          "[C++] Addon::cancel() notified process loop for job %u\n", jobId));
}

template <> void Addon<LlamaModel>::cancelAll() {
  {
    std::scoped_lock lock{mtx_};
    if (lastAppendedJob_ != nullptr) {
      lastAppendedJob_ = nullptr;
    }
    jobQueue_.clear();
    cancelJobId_ = 0;
    signal_ = ProcessSignals::Cancel;
    // Immediately stop any ongoing model processing
    model_.stop();
  }
  processCv_.notify_one();
}
}
