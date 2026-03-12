#pragma once

#include <cassert>
#include <memory>
#include <shared_mutex>

/// @brief Captures a snapshot of a shared_ptr and manages read/write lock
///        promotion on the associated shared_mutex.
///
/// Standard C++ has no atomic read→write lock promotion. This class wraps
/// the unlock-read / lock-write dance and checks whether the source pointer
/// was swapped during the gap (returning false from promoteToWrite).
///
/// When disabled (via disable()), all lock operations become no-ops and
/// promoteToWrite always returns true. Use this when the caller already
/// holds an external lock on the mutex.
///
/// @code
///   SharedSnapshot snap(state_, stateMtx_);
///   if (!callerHoldsLock) snap.disable();
///   snap.lockRead();               // no-op if disabled; always snapshots
///   // ... work via snap-> ...
///   if (!snap.promoteToWrite()) {  // no-op (returns true) if disabled
///     return;                      // source was swapped, work is stale
///   }
///   // ... commit results ...
///   snap.demoteToRead();           // no-op if disabled
/// @endcode
template <typename T> class SharedSnapshot {
public:
  SharedSnapshot(const std::shared_ptr<T>& source, std::shared_mutex& mtx)
      : source_(&source),
        readLock_(mtx, std::defer_lock),
        writeLock_(mtx, std::defer_lock) {
    assert(source_ != nullptr && "source must not be null");
  }

  void enable() { enabled_ = true; }
  void disable() { enabled_ = false; }

  /// Snapshot the source pointer. Acquires the read lock when enabled.
  void lockRead() {
    if (enabled_) {
      readLock_.lock();
    }
    snapshot_ = *source_;
    assert(snapshot_ != nullptr && "source shared_ptr holds null after lock");
  }

  /// Release read lock, acquire write lock.
  /// Returns false if the source pointer was swapped since the snapshot.
  /// Always returns true when disabled.
  bool promoteToWrite() {
    if (!enabled_) {
      return true;
    }
    readLock_.unlock();
    writeLock_.lock();
    return isValid();
  }

  /// Release write lock, re-acquire read lock.
  /// No-op when disabled.
  void demoteToRead() {
    if (!enabled_) {
      return;
    }
    writeLock_.unlock();
    readLock_.lock();
  }

  [[nodiscard]] bool isValid() const { return *source_ == snapshot_; }

  T* operator->() const {
    assert(snapshot_ != nullptr && "snapshot not captured; call lockRead first");
    return snapshot_.get();
  }
  T& operator*() const {
    assert(snapshot_ != nullptr && "snapshot not captured; call lockRead first");
    return *snapshot_;
  }
  const std::shared_ptr<T>& get() const { return snapshot_; }

private:
  const std::shared_ptr<T>* source_;
  std::shared_ptr<T> snapshot_;
  std::shared_lock<std::shared_mutex> readLock_;
  std::unique_lock<std::shared_mutex> writeLock_;
  bool enabled_ = true;
};
