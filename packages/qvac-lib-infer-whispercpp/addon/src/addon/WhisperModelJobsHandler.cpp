#include "WhisperModelJobsHandler.hpp"

#include <chrono>
#include <memory>
#include <mutex>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_cpp {

std::unique_ptr<WhisperModelJobsHandler> WhisperModelJobsHandler::instance_ =
    nullptr;
std::once_flag WhisperModelJobsHandler::initialized_;

void WhisperModelJobsHandler::process(
    std::unique_ptr<Job<Model::Input>>& currentJob, Model::Input& input,
    Model& model, PriorityQueue<PriorityNode<Model::Input>>& jobQueue,
    Job<Model::Input>*& lastAppendedJob, AddonStatus& status,
    std::function<void(const Output<typename Model::Output>&)>& queueOutput,
    std::atomic<bool>& running, std::mutex& mtx,
    std::condition_variable& processCv) {

  uint64_t jobId = 0;
  constexpr auto K_WAIT_MS = std::chrono::milliseconds{100};

  while (running) {
    std::unique_lock lk(mtx);
    processCv.wait_for(lk, K_WAIT_MS);
    if (!running)
      break;

    if (!currentJob) {
      if (jobQueue.empty()) {
        if (status != AddonStatus::Idle) {
          status = AddonStatus::Idle;
        }
        continue;
      }

      currentJob = std::move(jobQueue.top().job);
      jobQueue.pop();
      jobId = currentJob->id;

      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "Starting job " + std::to_string(jobId));
      status = AddonStatus::Processing;
      queueOutput(
          Output<typename Model::Output>{
              OutputEvent::JobStarted, static_cast<uint32_t>(jobId)});

      model.setOnSegmentCallback(
          [&, jobId](const qvac_lib_inference_addon_whisper::Transcript& tr) {
            typename Model::Output output;
            output.push_back(tr);
            queueOutput(
                Output<typename Model::Output>{
                    OutputEvent::Output,
                    static_cast<uint32_t>(jobId),
                    std::move(output)});
          });

      try {
        model.load();
      } catch (const std::exception& e) {
        // Note: lk already holds the mutex, don't lock again
        queueOutput(
            Output<typename Model::Output>{
                OutputEvent::Error,
                static_cast<uint32_t>(jobId),
                typename Output<typename Model::Output>::Error{
                    std::string(e.what())}});
        // End the job after error so addon doesn't hang
        queueOutput(
            Output<typename Model::Output>{
                OutputEvent::JobEnded,
                static_cast<uint32_t>(jobId),
                model.runtimeStats()});
        model.reset();
        currentJob = nullptr;
        continue; // Continue the loop, don't exit
      }
    }

    if (currentJob && !currentJob->input.empty()) {
      std::swap(input, currentJob->input);
      lk.unlock();

      try {
        if (!input.empty()) {
          model.process(input);
        }
      } catch (const std::exception& e) {
        std::scoped_lock slk{mtx};
        QLOG(
            qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
            "Error processing job " + std::to_string(jobId) + ": " +
                std::string(e.what()));
        queueOutput(
            Output<typename Model::Output>{
                OutputEvent::Error,
                static_cast<uint32_t>(jobId),
                typename Output<typename Model::Output>::Error{
                    std::string(e.what())}});
      }
      input.clear();
    }

    if (currentJob && model.isStreamEnded() && currentJob->input.empty() &&
        input.empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "Job " + std::to_string(jobId) + " completed");
      queueOutput(
          Output<typename Model::Output>{
              OutputEvent::JobEnded,
              static_cast<uint32_t>(jobId),
              model.runtimeStats()});

      model.reset();

      if (currentJob.get() == lastAppendedJob) {
        lastAppendedJob = nullptr;
      }

      status = AddonStatus::Listening;
      currentJob.reset();
    }

    if (currentJob && currentJob->input.empty() &&
        currentJob.get() != lastAppendedJob) {
      if (status == AddonStatus::Listening || status == AddonStatus::Idle) {
        currentJob.reset();
      }
    }
  }
}

bool WhisperModelJobsHandler::shouldExit(AddonStatus status) {
  return status == AddonStatus::Stopped || status == AddonStatus::Unloaded;
}

bool WhisperModelJobsHandler::shouldWait(AddonStatus status) {
  return status == AddonStatus::Paused || status == AddonStatus::Loading;
}

bool WhisperModelJobsHandler::getNextJob(
    std::unique_ptr<Job<Model::Input>>& currentJob,
    PriorityQueue<PriorityNode<Model::Input>>& jobQueue,
    Job<Model::Input>*& lastAppendedJob, AddonStatus& status,
    std::function<void(const Output<typename Model::Output>&)>& queueOutput) {
  if (currentJob != nullptr) {
    return true;
  }

  if (jobQueue.empty()) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "Job queue is empty, setting status to Idle");
    status = AddonStatus::Idle;
    return false;
  }

  currentJob = std::move(jobQueue.top().job);
  jobQueue.pop();
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Retrieved job " + std::to_string(currentJob->id) + " from queue");
  status = AddonStatus::Processing;

  startJob(currentJob, queueOutput);
  return true;
}

void WhisperModelJobsHandler::startJob(
    std::unique_ptr<Job<Model::Input>>& currentJob,
    std::function<void(const Output<typename Model::Output>&)>& queueOutput) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Starting job " + std::to_string(currentJob->id));
  queueOutput(
      Output<typename Model::Output>{OutputEvent::JobStarted, currentJob->id});
}

void WhisperModelJobsHandler::processJob(
    std::unique_ptr<Job<Model::Input>>& currentJob, Model::Input& input,
    Model& model,
    std::function<void(const Output<typename Model::Output>&)>& queueOutput) {
  try {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "Processing job " + std::to_string(currentJob->id) +
            " with input size: " + std::to_string(input.size()));
    model.load();

    if (!input.empty()) {
      model.process(input);
    }

  } catch (const std::exception& e) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "Error in processJob for job " + std::to_string(currentJob->id) + ": " +
            std::string(e.what()));
    queueOutput(
        Output<typename Model::Output>{
            OutputEvent::Error,
            currentJob->id,
            typename Output<typename Model::Output>::Error{
                std::string(e.what())}});
  }
}

void WhisperModelJobsHandler::endJob(
    std::unique_ptr<Job<Model::Input>>& currentJob,
    Job<Model::Input>*& lastAppendedJob, Model& model,
    std::function<void(const Output<typename Model::Output>&)>& queueOutput) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Ending job " + std::to_string(currentJob->id));
  queueOutput(
      Output<typename Model::Output>{
          OutputEvent::JobEnded, currentJob->id, model.runtimeStats()});

  model.reset();

  if (currentJob.get() == lastAppendedJob) {
    lastAppendedJob = nullptr;
  }
  currentJob.reset();
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Job resources cleaned up");
}

void WhisperModelJobsHandler::handleJobInput(
    std::unique_ptr<Job<Model::Input>>& currentJob, Model::Input& input,
    AddonStatus& status) {
  if (input.empty() && !currentJob->input.empty()) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "Swapping job input, changing status to Processing");
    std::swap(input, currentJob->input);
    status = AddonStatus::Processing;
  } else if (input.empty() && currentJob->input.empty()) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "No input available, changing status to Listening");
    status = AddonStatus::Listening;
  }
}

WhisperModelJobsHandler* WhisperModelJobsHandler::getInstance() {
  std::call_once(initialized_, []() {
    instance_ = std::make_unique<WhisperModelJobsHandler>();
  });

  return instance_.get();
}

} // namespace qvac_lib_inference_addon_cpp