#include "Addon.hpp"

#include <cstring>
#include <variant>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_cpp {

template <>
js_value_t*
output_handler::createOutputData(js_env_t* env, const BertEmbeddings& data) {
  // Create outer array
  js_value_t* array = nullptr;
  js_create_array(env, &array);

  // Add each inner array
  for (size_t i = 0; i < data.size(); i++) {

    const auto& embedding = data[i];

    js_value_t* arrayBuffer = nullptr;
    void* arrayBufferData = nullptr;
    JS(js_create_arraybuffer(
        env, embedding.size() * sizeof(float), &arrayBufferData, &arrayBuffer));

    std::memcpy(
        arrayBufferData, embedding.data(), embedding.size() * sizeof(float));

    js_value_t* inner = nullptr;
    JS(js_create_typedarray(
        env, js_float32array, embedding.size(), arrayBuffer, 0, &inner));

    js_set_element(env, array, i, inner);
  }

  return array;
}

template <>
template <>
Addon<BertModel>::Addon(
    js_env_t* env, std::reference_wrapper<const std::string> modelPath,
    std::reference_wrapper<const std::string> config,
    std::reference_wrapper<const std::string> backendsDir, js_value_t* jsHandle,
    js_value_t* outputCb, js_value_t* transitionCb)
    : jsHandle_{nullptr}, outputCb_{nullptr},
      jsOutputCallbackAsyncHandle_{nullptr}, threadsafeOutputCb_{nullptr},
      env_{env}, transitionCb_{transitionCb},
      model_{modelPath, config, backendsDir} {
  QLOG(
      logger::Priority::INFO,
      "Initializing BertModel addon with model path: " +
          std::string(modelPath.get()));
  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
  QLOG(logger::Priority::INFO, "BertModel addon initialized successfully");
}

template <>
BertModel::Input Addon<BertModel>::getNextPiece(
    BertModel::Input& input, [[maybe_unused]] size_t lastPieceEnd) {
  return input;
}

template <>
uint32_t
Addon<BertModel>::append(int priority, BertModel::InputView inputView) {
  // Convert InputView (variant) to Input (variant) by copying
  BertModel::Input input = inputView;
  uint32_t jobId = 0;
  constexpr int K_DEFAULT_PRIORITY = 50;
  {
    std::scoped_lock lock{mtx_};
    if (lastAppendedJob_ != nullptr) {
      jobId = lastAppendedJob_->id;
    } else {
      auto newJob = std::make_unique<Job<BertModel::Input>>(++jobIds_);
      lastAppendedJob_ = newJob.get();
      jobId = lastAppendedJob_->id;
      try {
        jobQueue_.emplace(
            priority == -1 ? K_DEFAULT_PRIORITY : priority, std::move(newJob));
      } catch (...) {
        lastAppendedJob_ = nullptr;
        throw;
      }
    }
    auto& jobInput = lastAppendedJob_->input;
    // Merge chunks if same type, otherwise add as new chunk
    // For BertModel, we process one complete input at a time, so we can simply
    // append or merge based on type
    if (jobInput.index() == input.index()) {
      // Same type - merge them
      std::visit(
          [&](auto& dst, auto&& src) {
            using D = std::decay_t<decltype(dst)>;
            using S = std::decay_t<decltype(src)>;
            if constexpr (
                std::is_same_v<D, std::string> &&
                std::is_same_v<S, std::string>) {
              dst.append(src);
            } else if constexpr (
                std::is_same_v<D, std::vector<std::string>> &&
                std::is_same_v<S, std::vector<std::string>>) {
              // For vectors, append all elements
              dst.insert(dst.end(), src.begin(), src.end());
            }
          },
          jobInput,
          std::move(input));
    } else {
      // Different types - replace with new input
      // For BertModel, each job should have one type, so we replace
      jobInput = std::move(input);
    }
  }
  processCv_.notify_one();
  return jobId;
}

// Override process() to handle variant input properly
template <> void Addon<BertModel>::process() {
  typename BertModel::Input input;
  auto cleanupLastAppended = utils::onError([this]() {
    auto l = std::scoped_lock{mtx_};
    if (currentJob_.get() == lastAppendedJob_) {
      lastAppendedJob_ = nullptr;
    }
  });

  size_t lastPieceEnd = 0;

  // Helper lambda to check if variant input is empty
  auto isInputEmpty = [](const BertModel::Input& inp) {
    return std::visit([](const auto& val) { return val.empty(); }, inp);
  };

  // Helper lambda to clear variant input
  auto clearInput = [](BertModel::Input& inp) {
    std::visit([](auto& val) { val.clear(); }, inp);
  };

  while (running_) {
    std::unique_lock lk(mtx_);
    processCv_.wait_for(lk, std::chrono::milliseconds{100});

    // Handle signals directly (like llama addon) instead of calling
    // processState()
    if (signal_ != ProcessSignals::None) {
      switch (signal_) {
      case ProcessSignals::Activate:
        status_ = AddonStatus::Processing;
        break;
      case ProcessSignals::Stop:
        status_ = AddonStatus::Stopped;
        model_.reset();
        if (currentJob_ && currentJob_.get() == lastAppendedJob_) {
          lastAppendedJob_ = nullptr;
        }
        currentJob_.reset();
        clearInput(input);
        break;
      case ProcessSignals::Pause:
        status_ = AddonStatus::Paused;
        break;
      case ProcessSignals::Cancel:
        if (currentJob_ &&
            (cancelJobId_ == 0 || currentJob_->id == cancelJobId_)) {
          queueOutput(ModelOutput{
              OutputEvent::JobEnded, currentJob_->id, model_.runtimeStats()});
          model_.reset();
          if (currentJob_.get() == lastAppendedJob_) {
            lastAppendedJob_ = nullptr;
          }
          currentJob_.reset();
          cancelJobId_ = 0;
          clearInput(input);
        }
        break;
      case ProcessSignals::UnloadWeights:
        status_ = AddonStatus::Loading;
        if (currentJob_ && currentJob_.get() == lastAppendedJob_) {
          lastAppendedJob_ = nullptr;
        }
        currentJob_.reset();
        clearInput(input);
        model_.unloadWeights();
        break;
      case ProcessSignals::Unload:
        status_ = AddonStatus::Unloaded;
        if (currentJob_ && currentJob_.get() == lastAppendedJob_) {
          lastAppendedJob_ = nullptr;
        }
        currentJob_.reset();
        clearInput(input);
        model_.unload();
        break;
      case ProcessSignals::Load:
        status_ = AddonStatus::Loading;
        if (currentJob_ && currentJob_.get() == lastAppendedJob_) {
          lastAppendedJob_ = nullptr;
        }
        currentJob_.reset();
        clearInput(input);
        model_.load();
        break;
      case ProcessSignals::Reload:
        status_ = AddonStatus::Loading;
        if (currentJob_ && currentJob_.get() == lastAppendedJob_) {
          lastAppendedJob_ = nullptr;
        }
        currentJob_.reset();
        clearInput(input);
        model_.reload();
        break;
      case ProcessSignals::Finetune:
        // BertModel doesn't support finetuning
        status_ = AddonStatus::Idle;
        break;
      case ProcessSignals::None:
        break;
      default:
        break;
      }
      signal_ = ProcessSignals::None;
    }

    if (status_ == AddonStatus::Stopped || status_ == AddonStatus::Paused ||
        status_ == AddonStatus::Loading || status_ == AddonStatus::Unloaded)
      continue;

    if (currentJob_ == nullptr) {
      if (jobQueue_.empty()) {
        status_ = AddonStatus::Idle;
        continue;
      }
      currentJob_ = std::move(jobQueue_.top().job);
      jobQueue_.pop();
      status_ = AddonStatus::Processing;
      queueOutput(ModelOutput{OutputEvent::JobStarted, currentJob_->id});
    }

    if (isInputEmpty(input)) {
      if (isInputEmpty(currentJob_->input)) {
        if (currentJob_.get() != lastAppendedJob_) {
          queueOutput(ModelOutput{
              OutputEvent::JobEnded, currentJob_->id, model_.runtimeStats()});
          model_.reset();
          currentJob_.reset();
          continue;
        }
        status_ = AddonStatus::Listening;
        continue;
      }
      std::swap(input, currentJob_->input);
      lastPieceEnd = 0;
      status_ = AddonStatus::Processing;
    }
    lk.unlock();

    // Process the entire input at once (BertModel doesn't stream)
    auto piece = getNextPiece(input, lastPieceEnd);
    clearInput(input); // Clear after processing

    try {
      auto output = model_.process(piece);
      std::scoped_lock slk{mtx_};
      queueOutput(
          ModelOutput{OutputEvent::Output, currentJob_->id, std::move(output)});
    } catch (const std::exception& e) {
      auto jobId = currentJob_->id;
      std::scoped_lock slk{mtx_};
      queueOutput(ModelOutput{
          OutputEvent::Error, jobId, typename ModelOutput::Error{e.what()}});
      queueOutput(
          ModelOutput{OutputEvent::JobEnded, jobId, model_.runtimeStats()});
      model_.reset();
      if (currentJob_.get() == lastAppendedJob_) {
        lastAppendedJob_ = nullptr;
      }
      currentJob_.reset();
      clearInput(input);
    }
  }
}

} // namespace qvac_lib_inference_addon_cpp
