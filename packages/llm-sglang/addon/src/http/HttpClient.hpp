#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>

namespace qvac_llm_sglang {

struct Endpoint {
  std::string host;
  int port = 0;
};

/// `http://host:port` with no path. Used as the server base URL.
Endpoint parseHttpEndpoint(const std::string& baseUrl);

/// Shared by the worker that reads the socket and cancel(), which may run on
/// another thread. `request` bumps the epoch and shuts the live socket down
/// so a blocking read returns.
class CancelState {
 public:
  [[nodiscard]] std::uint64_t snapshot() const {
    return epoch_.load(std::memory_order_acquire);
  }

  [[nodiscard]] bool stopped(std::uint64_t seen) const {
    return epoch_.load(std::memory_order_acquire) != seen;
  }

  void request() const;

  void arm(int socket, std::uint64_t seen) const;
  void disarm() const;

 private:
  mutable std::atomic<std::uint64_t> epoch_{0};
  mutable std::mutex mutex_;
  mutable int fd_{-1};
};

/// HTTP chunked-body decoder. `feed` appends newly decoded bytes to `out`.
class ChunkedDecoder {
 public:
  void feed(std::string_view raw, std::string& out);
  [[nodiscard]] bool finished() const { return done_; }

 private:
  std::string pending_;
  bool done_ = false;
  bool inData_ = false;
  std::size_t remaining_ = 0;

  void parse(std::string& out);
};

/// POST `path` with a JSON body. On a 2xx response, `onBody` receives the
/// decoded body as it arrives. A non-2xx response throws std::runtime_error
/// with the response body. Returns false when `cancel` stops the read.
bool httpPost(
    const Endpoint& endpoint, const std::string& path, const std::string& body,
    const CancelState& cancel, std::uint64_t seen,
    const std::function<void(std::string_view)>& onBody,
    const std::string& apiKey = {});

} // namespace qvac_llm_sglang
