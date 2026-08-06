#pragma once

#include <memory>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <utility>
#include <vector>

namespace qvac_lib_inference_addon_cpp {
class AddonJs;
} // namespace qvac_lib_inference_addon_cpp

namespace qvac::asrggml {

// Engine-agnostic view of a duplex streaming session
// (whisper::StreamingProcessor / parakeet::ParakeetStreamingProcessor).
// One session per AddonJs instance, keyed by raw AddonJs* because the
// addon framework owns AddonJs lifetime via JsInterface. Lives between
// startStreaming() and endStreaming() / cancel() / destroyInstance().
struct IStreamingSession {
  IStreamingSession() = default;
  virtual ~IStreamingSession() = default;

  IStreamingSession(const IStreamingSession&) = delete;
  IStreamingSession& operator=(const IStreamingSession&) = delete;
  IStreamingSession(IStreamingSession&&) = delete;
  IStreamingSession& operator=(IStreamingSession&&) = delete;

  // Thread-safe; called from the JS-binding thread per audio chunk.
  virtual void appendAudio(std::vector<float>&& samples) = 0;
  // Graceful shutdown: flush trailing audio, then join the worker thread.
  virtual void end() = 0;
  // Forceful shutdown: abort in-flight work, then join the worker thread.
  virtual void cancel() = 0;
  // Cumulative seconds of audio received by the session. Only valid after
  // end()/cancel() returned (both join the worker, so the read is race-free).
  virtual double audioSeconds() const = 0;
  virtual int sampleRate() const = 0;
};

// One registry for both engines. `inline` so every TU shares the single
// map/mutex pair (C++17 inline variables), mirroring what the two
// per-engine inline maps used to do separately.
inline std::mutex g_streamingMtx;
inline std::unordered_map<
    qvac_lib_inference_addon_cpp::AddonJs*, std::unique_ptr<IStreamingSession>>
    g_streamingSessions;

// Registers a session for `instance`, CONSTRUCTING it only after the
// double-start check has passed. `factory` is invoked with the registry lock
// held, so the check and the construction are one atomic step -- exactly the
// ordering both pre-merge bindings had (whisper: `if (count(&instance) != 0)
// throw; ... = make_unique<StreamingProcessor>(...)`; parakeet: identical).
//
// Passing an already-built session instead would mean a duplicate
// startStreaming() spins up a second processor -- and its worker thread --
// against the shared model before the throw: whisper's worker calls
// prepareForStreaming() -> WhisperModel::reset() as its first statement,
// zeroing the live session's counters and clearing the unsynchronized
// output_ vector session #1 is pushing into; parakeet's ctor calls
// stream_start() a second time on an Engine whose graph allocator is
// single-session state. Hence the factory seam: there is no overload that
// takes a constructed session.
//
// The lock is held across construction (VAD-model load / stream_start() plus
// the std::thread spawn), as it was pre-merge, so `factory` must not call
// back into the registry. Both throw paths leave the registry exactly as it
// was: a throwing (or null-returning) factory has its reserved node erased,
// and the session it may have built is destroyed by the returned
// unique_ptr's destructor, which joins the worker thread.
template <typename Factory>
inline void emplaceStreamingSession(
    qvac_lib_inference_addon_cpp::AddonJs* instance, Factory&& factory) {
  std::lock_guard<std::mutex> lock(g_streamingMtx);
  // Reserve the node first: nothing after the factory call may allocate, so a
  // successfully constructed session can never be dropped on the floor.
  auto [it, inserted] = g_streamingSessions.try_emplace(instance);
  if (!inserted) {
    throw std::runtime_error(
        "Streaming session already active for this instance");
  }
  try {
    it->second = std::forward<Factory>(factory)();
    if (!it->second) {
      throw std::runtime_error("Failed to create the streaming session");
    }
  } catch (...) {
    g_streamingSessions.erase(it);
    throw;
  }
}

// Locked lookup returning a raw pointer (nullptr when absent). The caller
// then invokes the session outside the lock -- the same TOCTOU window both
// pre-merge bindings had: teardown paths take ownership out of the map and
// join, so a racing append hits either a live session or a null lookup.
inline IStreamingSession*
findStreamingSession(qvac_lib_inference_addon_cpp::AddonJs* instance) {
  std::lock_guard<std::mutex> lock(g_streamingMtx);
  auto it = g_streamingSessions.find(instance);
  return it == g_streamingSessions.end() ? nullptr : it->second.get();
}

// Removes and returns the session for `instance` (may be null).
inline std::unique_ptr<IStreamingSession>
takeStreamingSession(qvac_lib_inference_addon_cpp::AddonJs* instance) {
  std::lock_guard<std::mutex> lock(g_streamingMtx);
  auto it = g_streamingSessions.find(instance);
  if (it == g_streamingSessions.end()) {
    return nullptr;
  }
  std::unique_ptr<IStreamingSession> session = std::move(it->second);
  g_streamingSessions.erase(it);
  return session;
}

// take + shared_ptr conversion, for async lambdas (JsAsyncTask) that need
// a copyable handle to the removed session.
inline std::shared_ptr<IStreamingSession>
takeStreamingSessionShared(qvac_lib_inference_addon_cpp::AddonJs* instance) {
  return std::shared_ptr<IStreamingSession>(takeStreamingSession(instance));
}

// atexit handler: cancel() (abortive; bounded worker join) every surviving
// session, then destroy it. Residual risk is what whisper shipped before the
// merge: joining worker threads inside atexit during static destruction.
inline void clearAllStreamingSessions() {
  std::unordered_map<
      qvac_lib_inference_addon_cpp::AddonJs*,
      std::unique_ptr<IStreamingSession>>
      taken;
  {
    std::lock_guard<std::mutex> lock(g_streamingMtx);
    taken.swap(g_streamingSessions);
  }
  for (auto& [instance, session] : taken) {
    if (session) {
      try {
        session->cancel();
      } catch (...) {
      }
    }
  }
}

} // namespace qvac::asrggml
