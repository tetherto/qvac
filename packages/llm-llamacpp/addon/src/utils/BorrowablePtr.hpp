#pragma once

#include <cstddef>
#include <memory>
#include <mutex>
#include <stdexcept>

/// @brief Borrow/reclaim wrapper around unique ptr. Allows owner thread
//         to share pointer with other threads but eventually reclaim ownership.
/// @details Borrow leases are thread-safe and can be released from any thread.
/// Owner operations (`borrow()` and `reclaimUnique()`) are synchronized
/// internally and safe to invoke from different threads.
template <typename T> class BorrowablePtr {
  struct State {
    std::mutex mu;
    std::size_t activeBorrows = 0;
  };

  struct Deleter {
    std::unique_ptr<T> inner;
    void operator()(T*) noexcept { /* inner self-deletes if not released */ }
    std::unique_ptr<T> release() { return std::move(inner); }
  };

public:
  class Borrowed {
  public:
    Borrowed() = default;
    ~Borrowed() = default;

    Borrowed(const Borrowed&) = delete;
    Borrowed& operator=(const Borrowed&) = delete;
    Borrowed(Borrowed&& other) noexcept = default;
    Borrowed& operator=(Borrowed&& other) noexcept = default;

    explicit operator bool() const { return static_cast<bool>(ptr_); }
    T& ref() const { return *ptr_; }

  private:
    friend class BorrowablePtr<T>;
    Borrowed(std::shared_ptr<T> ptr, std::shared_ptr<void> lease)
        : ptr_(std::move(ptr)), lease_(std::move(lease)) {}

    std::shared_ptr<T> ptr_;
    std::shared_ptr<void> lease_;
  };

  explicit BorrowablePtr(std::unique_ptr<T>&& value)
      : state_(std::make_shared<State>()) {
    if (!value) {
      throw std::invalid_argument("BorrowablePtr requires non-null value");
    }
    T* raw = value.get();
    ptr_ = std::shared_ptr<T>(raw, Deleter{std::move(value)});
  }

  BorrowablePtr(const BorrowablePtr&) = delete;
  BorrowablePtr& operator=(const BorrowablePtr&) = delete;
  BorrowablePtr(BorrowablePtr&& other) {
    std::lock_guard<std::mutex> otherLock(other.mainOwnerMu_);
    ptr_ = std::move(other.ptr_);
    state_ = std::move(other.state_);
  }
  BorrowablePtr& operator=(BorrowablePtr&& other) {
    if (this == &other) {
      return *this;
    }
    std::scoped_lock lock(mainOwnerMu_, other.mainOwnerMu_);
    ptr_ = std::move(other.ptr_);
    state_ = std::move(other.state_);
    return *this;
  }

  Borrowed borrow() const {
    std::lock_guard<std::mutex> ownerLock(mainOwnerMu_);
    if (!ptr_ || !state_) {
      return {};
    }
    std::shared_ptr<void> lease;
    {
      std::lock_guard<std::mutex> lock(state_->mu);
      ++state_->activeBorrows;
      lease = std::shared_ptr<void>(nullptr, [state = state_](void*) {
        std::lock_guard<std::mutex> releaseLock(state->mu);
        if (state->activeBorrows > 0) {
          --state->activeBorrows;
        }
      });
    }
    return Borrowed(ptr_, std::move(lease));
  }

  std::unique_ptr<T> reclaimUnique() {
    std::lock_guard<std::mutex> ownerLock(mainOwnerMu_);
    if (!state_) {
      return {};
    }
    {
      std::lock_guard<std::mutex> lock(state_->mu);
      if (state_->activeBorrows > 0) {
        throw std::runtime_error(
            "Cannot reclaim unique ownership while borrows are active");
      }
      std::unique_ptr<T> unique = std::get_deleter<Deleter>(ptr_)->release();
      ptr_.reset();
      state_.reset();
      return unique;
    }
  }

private:
  mutable std::mutex mainOwnerMu_;
  std::shared_ptr<T> ptr_;
  std::shared_ptr<State> state_;
};
