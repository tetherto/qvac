#pragma once

#include <atomic>
#include <functional>

namespace qvac_lib_inference_addon_llama::batching {

/// RAII guard for `LlamaModel::activeBatchJobs_`, the counter that tracks how
/// many batch jobs are in flight. The counter must be balanced even when the
/// per-job entry validation throws: a leaked count makes `cancel()` believe a
/// batch is still active (it would call `requestCancelAll()` on an idle
/// engine) and makes the next batch entry observe a non-zero prior count and
/// skip the first-batch cache invalidation / KV wipe.
///
/// The guard runs `validate` and increments the counter in its constructor and
/// decrements it in its destructor, so the counter is always restored on the
/// throwing path.
class BatchEntryGuard {
public:
  /// `validate` is the throwing entry validation (e.g. quantization checks).
  BatchEntryGuard(
      std::atomic<unsigned>& counter, const std::function<void()>& validate)
      : counter_(counter) {
    // Validate before incrementing: a thrown validation leaves the counter
    // untouched, so the count never leaks on the failure path.
    validate();
    prior_ = counter_.fetch_add(1);
  }

  ~BatchEntryGuard() { counter_.fetch_sub(1); }

  BatchEntryGuard(const BatchEntryGuard&) = delete;
  BatchEntryGuard& operator=(const BatchEntryGuard&) = delete;
  BatchEntryGuard(BatchEntryGuard&&) = delete;
  BatchEntryGuard& operator=(BatchEntryGuard&&) = delete;

  /// Number of batch jobs already in flight before this one (0 for the first).
  [[nodiscard]] unsigned prior() const { return prior_; }

private:
  std::atomic<unsigned>& counter_;
  unsigned prior_ = 0;
};

} // namespace qvac_lib_inference_addon_llama::batching
