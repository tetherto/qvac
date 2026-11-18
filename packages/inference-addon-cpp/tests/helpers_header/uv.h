// Mocked uv.h. Production headers include <uv.h> directly now that libjs no
// longer pulls it in through <js.h>. Unit tests compile against this stub
// instead of libuv: async send and close dispatch their callbacks
// synchronously so the JsAsyncTask completion chain (worker -> uv_async_send
// -> completion -> uv_close -> close callback) is observable without a loop.

#pragma once

#include <atomic>
#include <mutex>
#include <utility>
#include <vector>

struct uv_async_t {
  void* data;
  // Stored by the mocked uv_async_init so uv_async_send can dispatch the
  // completion callback synchronously (stands in for the libuv loop).
  void (*async_cb)(uv_async_t*) = nullptr;
};
struct uv_handle_t {};
struct uv_loop_t {};

inline int
uv_async_init(uv_loop_t* loop, uv_async_t* handle, void (*cb)(uv_async_t*)) {
  handle->async_cb = cb;
  return 0;
}

// Test hooks for async sends and close callbacks. A real loop runs them later,
// on the loop thread, so a test that needs the window between a send or close
// and its callback sets deferAsyncSend or deferClose, then runs the queued
// callbacks with runPendingAsyncSends() or runPendingCloses(). The switches
// are atomic and the queues locked because a detached worker from an earlier
// run() test can still reach uv_async_send or uv_close while a later test
// flips them.
namespace mock_uv {
inline std::atomic<bool> deferAsyncSend{false};
inline std::atomic<bool> deferClose{false};
inline std::mutex pendingMutex;
inline std::vector<uv_async_t*> pendingAsyncSends;
inline std::vector<std::pair<uv_handle_t*, void (*)(uv_handle_t*)>>
    pendingCloses;

inline void runPendingAsyncSends() {
  std::vector<uv_async_t*> sends;
  {
    std::lock_guard<std::mutex> lock(pendingMutex);
    sends.swap(pendingAsyncSends);
  }
  for (uv_async_t* handle : sends) {
    handle->async_cb(handle);
  }
}

inline void runPendingCloses() {
  std::vector<std::pair<uv_handle_t*, void (*)(uv_handle_t*)>> closes;
  {
    std::lock_guard<std::mutex> lock(pendingMutex);
    closes.swap(pendingCloses);
  }
  for (auto& [handle, cb] : closes) {
    cb(handle);
  }
}
} // namespace mock_uv

inline int uv_async_send(uv_async_t* handle) {
  if (handle->async_cb == nullptr) {
    return 0;
  }
  if (mock_uv::deferAsyncSend.load()) {
    std::lock_guard<std::mutex> lock(mock_uv::pendingMutex);
    mock_uv::pendingAsyncSends.push_back(handle);
    return 0;
  }
  handle->async_cb(handle);
  return 0;
}

inline void* uv_handle_get_data(uv_handle_t* handle) { return nullptr; }

inline void uv_handle_set_data(uv_handle_t* handle, void* data) {}

inline void uv_close(uv_handle_t* handle, void (*cb)(uv_handle_t*)) {
  if (cb == nullptr) {
    return;
  }
  if (mock_uv::deferClose.load()) {
    std::lock_guard<std::mutex> lock(mock_uv::pendingMutex);
    mock_uv::pendingCloses.emplace_back(handle, cb);
    return;
  }
  cb(handle);
}
