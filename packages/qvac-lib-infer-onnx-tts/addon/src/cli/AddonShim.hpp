#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <queue>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "src/model-interface/PiperEngine.hpp"
#include "src/model-interface/TTSModel.hpp"

namespace qvac::ttslib::cli_shim {

class TTSAddonShim {
public:
  enum class EventType { Output, JobStarted, JobEnded, Error };

  struct Event {
    EventType type;
    uint32_t jobId;
    std::string payload; // output path or error message; runtime stats omitted
  };

  explicit TTSAddonShim(const TTSConfig& config);

  ~TTSAddonShim();

  void activate();

  uint32_t append(std::string_view text);

  bool poll(std::vector<Event>& outEvents);

private:
  struct Job { uint32_t id; std::string text; };

  void processLoop();

  std::atomic_bool running_{true};
  std::thread processingThread_;
  std::mutex mtx_;
  std::condition_variable cv_;
  std::queue<Job> jobs_;
  std::queue<Event> events_;
  uint32_t lastJobId_ = 0;
  qvac::ttslib::addon_model::TTSModel model_;
};

} // namespace qvac::ttslib::cli_shim


