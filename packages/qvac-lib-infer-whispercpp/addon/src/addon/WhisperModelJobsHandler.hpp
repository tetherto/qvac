#pragma once

#include <atomic>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>

#include "model-interface/WhisperTypes.hpp"
#include "model-interface/whisper.cpp/WhisperModel.hpp"
#include "qvac-lib-inference-addon-cpp/Addon.hpp"

namespace qvac_lib_inference_addon_cpp {

using Model = qvac_lib_inference_addon_whisper::WhisperModel;

class WhisperModelJobsHandler {
public:
  WhisperModelJobsHandler() = default;
  ~WhisperModelJobsHandler() = default;

  void process(
      std::unique_ptr<Job<Model::Input>>& currentJob, Model::Input& input,
      Model& model, PriorityQueue<PriorityNode<Model::Input>>& jobQueue,
      Job<Model::Input>*& lastAppendedJob, AddonStatus& status,
      std::function<void(const Output<typename Model::Output>&)>& queueOutput,
      std::atomic<bool>& running, std::mutex& mtx,
      std::condition_variable& processCv);

  static WhisperModelJobsHandler* getInstance();

private:
  bool shouldExit(AddonStatus status);
  bool shouldWait(AddonStatus status);
  bool getNextJob(
      std::unique_ptr<Job<Model::Input>>& currentJob,
      PriorityQueue<PriorityNode<Model::Input>>& jobQueue,
      Job<Model::Input>*& lastAppendedJob, AddonStatus& status,
      std::function<void(const Output<typename Model::Output>&)>& queueOutput);

  void startJob(
      std::unique_ptr<Job<Model::Input>>& currentJob,
      std::function<void(const Output<typename Model::Output>&)>& queueOutput);

  void processJob(
      std::unique_ptr<Job<Model::Input>>& currentJob, Model::Input& input,
      Model& model,
      std::function<void(const Output<typename Model::Output>&)>& queueOutput);

  void endJob(
      std::unique_ptr<Job<Model::Input>>& currentJob,
      Job<Model::Input>*& lastAppendedJob, Model& model,
      std::function<void(const Output<typename Model::Output>&)>& queueOutput);

  void handleJobInput(
      std::unique_ptr<Job<Model::Input>>& currentJob, Model::Input& input,
      AddonStatus& status);

  static std::unique_ptr<WhisperModelJobsHandler> instance_;
  static std::once_flag initialized_;
};

} // namespace qvac_lib_inference_addon_cpp
