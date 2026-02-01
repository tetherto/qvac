#include "cli/AddonShim.hpp"
#include "src/addon/TTSModel.hpp"

using qvac::ttslib::cli_shim::TTSAddonShim;
using qvac::ttslib::addon_model::TTSModel;
using qvac::ttslib::TTSConfig;

TTSAddonShim::TTSAddonShim(const TTSConfig& config)
  : model_(config) {
  processingThread_ = std::thread([this]() { this->processLoop(); });
}

TTSAddonShim::~TTSAddonShim() {
  running_.store(false);
  cv_.notify_all();
  if (processingThread_.joinable()) processingThread_.join();
}

void TTSAddonShim::activate() {
  std::lock_guard<std::mutex> lock(mtx_);
}

uint32_t TTSAddonShim::append(std::string_view text) {
  std::lock_guard<std::mutex> lock(mtx_);
  const uint32_t id = ++lastJobId_;
  jobs_.emplace(Job{ id, std::string(text) });
  cv_.notify_one();
  return id;
}

bool TTSAddonShim::poll(std::vector<Event>& outEvents) {
  std::lock_guard<std::mutex> lock(mtx_);
  if (events_.empty()) return false;
  outEvents.reserve(outEvents.size() + events_.size());
  while (!events_.empty()) {
    outEvents.emplace_back(std::move(events_.front()));
    events_.pop();
  }
  return true;
}

void TTSAddonShim::processLoop() {
  while (running_.load()) {
    Job job{0, {}};
    {
      std::unique_lock<std::mutex> lock(mtx_);
      cv_.wait_for(lock, std::chrono::milliseconds(100), [this]() { return !jobs_.empty() || !running_.load(); });
      if (!running_.load()) break;
      if (jobs_.empty()) continue;
      job = std::move(jobs_.front());
      jobs_.pop();
      events_.push(Event{ EventType::JobStarted, job.id, {} });
    }

    try {
      const std::string outputPath = model_.process(job.text);
      {
        std::lock_guard<std::mutex> lock(mtx_);
        events_.push(Event{ EventType::Output, job.id, outputPath });
        events_.push(Event{ EventType::JobEnded, job.id, {} });
      }
    } catch (const std::exception& e) {
      std::lock_guard<std::mutex> lock(mtx_);
      events_.push(Event{ EventType::Error, job.id, e.what() });
      events_.push(Event{ EventType::JobEnded, job.id, {} });
    }
  }
}


