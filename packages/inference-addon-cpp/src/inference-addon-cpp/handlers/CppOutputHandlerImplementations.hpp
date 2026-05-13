// Pure C++ out handlers (no Js dependencies). Can be used on CLI or C++ tests.
#pragma once

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <queue>
#include <sstream>
#include <string>
#include <type_traits>

#include "../Logger.hpp"
#include "../RuntimeStats.hpp"
#include "../queue/OutputQueue.hpp"
#include "OutputHandler.hpp"

namespace qvac_lib_inference_addon_cpp::out_handl {

/// @brief Scoped access object that holds a lock and provides access to a
/// container
/// @tparam ContainerT The container type
template <typename ContainerT> class ScopedAccess {
  std::unique_lock<std::mutex> lock_;
  ContainerT& container_;

public:
  ScopedAccess(std::mutex& mutex, ContainerT& container)
      : lock_(mutex), container_(container) {}

  // Move-only type
  ScopedAccess(const ScopedAccess&) = delete;
  ScopedAccess& operator=(const ScopedAccess&) = delete;
  ScopedAccess(ScopedAccess&&) = default;
  ScopedAccess& operator=(ScopedAccess&&) = default;

  /// @brief Get a reference to the container
  ContainerT& get() { return container_; }
  const ContainerT& get() const { return container_; }

  /// @brief Dereference operator to access the container
  ContainerT& operator*() { return container_; }
  const ContainerT& operator*() const { return container_; }

  /// @brief Arrow operator to access container members
  ContainerT* operator->() { return &container_; }
  const ContainerT* operator->() const { return &container_; }
};

/// @brief Output handler that stores results in a configurable container on
/// callback
/// @tparam ContainerT The container type (e.g., std::set<std::string>,
/// std::vector<int>)
///                    Must support insert() or push_back() method
/// Simplifies tests by providing thread-safe container access with mutex
// Helper template for dependent false - needed for static_assert in if
// constexpr
template <typename T> struct always_false : std::false_type {};

template <typename ContainerT>
class CppContainerOutputHandler
    : public BaseOutputHandler<void, typename ContainerT::value_type> {
  using T = typename ContainerT::value_type;
  mutable mutex mutex_;
  mutable condition_variable cv_;
  mutable ContainerT container_;

  // Helper to insert into container - works with both set and vector
  void insertIntoContainer(const T& value) {
    if constexpr (requires(ContainerT& c, const T& v) { c.insert(v); }) {
      // For containers with insert() like set, unordered_set
      container_.insert(value);
    } else if constexpr (requires(ContainerT& c, const T& v) {
                           c.push_back(v);
                         }) {
      // For containers with push_back() like vector, deque, list
      container_.push_back(value);
    } else {
      static_assert(
          always_false<ContainerT>::value,
          "Container must support insert() or push_back()");
    }
  }

public:
  /// @brief Construct with default container
  CppContainerOutputHandler()
      : BaseOutputHandler<void, T>([this](const T& output) {
          lock_guard<mutex> lock(mutex_);
          insertIntoContainer(output);
          cv_.notify_all();
        }) {}

  /// @brief Construct with a pre-configured container
  explicit CppContainerOutputHandler(ContainerT container)
      : container_(move(container)),
        BaseOutputHandler<void, T>([this](const T& output) {
          lock_guard<mutex> lock(mutex_);
          insertIntoContainer(output);
        }) {}

  /// @brief Get scoped access to the container with lock
  /// @return ScopedAccess object that holds the lock and provides container
  /// access
  ScopedAccess<ContainerT> access() {
    return ScopedAccess<ContainerT>(mutex_, container_);
  }

  /// @brief Get scoped access to the container with lock (const version)
  /// @return ScopedAccess object that holds the lock and provides const
  /// container access
  ScopedAccess<const ContainerT> access() const {
    // container_ is mutable, so we can safely cast away const for the reference
    return ScopedAccess<const ContainerT>(
        mutex_, const_cast<const ContainerT&>(container_));
  }

  /// @brief Get the current size of the container
  /// @return Number of items in the container
  size_t size() const {
    lock_guard<mutex> lock(mutex_);
    return container_.size();
  }

  /// @brief Check if the container is empty
  /// @return true if container is empty, false otherwise
  bool empty() const {
    lock_guard<mutex> lock(mutex_);
    return container_.empty();
  }

  /// @brief Wait until at least the specified number of items are in the
  /// container
  /// @param count Minimum number of items to wait for
  /// @param timeout Maximum time to wait
  /// @return true if count was reached, false if timeout expired
  template <typename Rep, typename Period>
  bool waitForItems(
      size_t count, const chrono::duration<Rep, Period>& timeout) const {
    unique_lock<mutex> lock(mutex_);
    return cv_.wait_for(
        lock, timeout, [this, count] { return container_.size() >= count; });
  }
};

///@brief Output handler that stores results on a queue on callback
/// Simplifies tests by providing thread-safe queue access with mutex and
/// condition variable
template <typename T>
class CppQueuedOutputHandler : public BaseOutputHandler<void, T> {
  mutable mutex mutex_;
  mutable condition_variable cv_;
  mutable queue<T> queue_;

public:
  CppQueuedOutputHandler()
      : BaseOutputHandler<void, T>([this](const T& output) {
          lock_guard<mutex> lock(mutex_);
          queue_.push(output);
          cv_.notify_one();
        }) {}

  /// @brief Pop an item from the queue, blocking until one is available
  /// @return The next item from the queue
  T pop() const {
    unique_lock<mutex> lock(mutex_);
    cv_.wait(lock, [this] { return !queue_.empty(); });
    T item = queue_.front();
    queue_.pop();
    return item;
  }

  /// @brief Pop an item from the queue with a timeout
  /// @tparam Rep The representation type of the duration
  /// @tparam Period The period type of the duration
  /// @param timeout Timeout duration. If timeout expires, throws
  /// std::runtime_error
  /// @return The next item from the queue or nullopt if timeout expires
  template <typename Rep, typename Period>
  optional<T> tryPop(const chrono::duration<Rep, Period>&& timeout) const {
    unique_lock<mutex> lock(mutex_);
    bool success =
        cv_.wait_for(lock, timeout, [this] { return !queue_.empty(); });
    if (!success) {
      return nullopt;
    }
    T item = queue_.front();
    queue_.pop();
    return item;
  }

  /// @brief Try to pop an item from the queue without blocking
  /// @param item Reference to store the popped item if available
  /// @return true if an item was popped, false if queue was empty
  bool tryPop(T& item) const {
    lock_guard<mutex> lock(mutex_);
    if (queue_.empty()) {
      return false;
    }
    item = queue_.front();
    queue_.pop();
    return true;
  }

  /// @brief Get the current size of the queue
  /// @return Number of items in the queue
  size_t size() const {
    lock_guard<mutex> lock(mutex_);
    return queue_.size();
  }

  /// @brief Check if the queue is empty
  /// @return true if queue is empty, false otherwise
  bool empty() const {
    lock_guard<mutex> lock(mutex_);
    return queue_.empty();
  }
};

/// @brief Handler for RuntimeStats that outputs to logger
struct CppRuntimeStatsOutputHandler : BaseOutputHandler<void, RuntimeStats> {
  CppRuntimeStatsOutputHandler()
      : BaseOutputHandler<void, RuntimeStats>(
            [this](const RuntimeStats& stats) {
              string statsStr = "RuntimeStats: ";
              for (const auto& p : stats) {
                visit(
                    [&p, &statsStr](auto&& val) {
                      ostringstream oss;
                      oss << p.first << "=" << val << " ";
                      statsStr += oss.str().c_str();
                    },
                    p.second);
              }
              QLOG(Priority::INFO, statsStr);
            }) {}
};

/// @brief Handler for Output::LogMsg that outputs message to logger
struct CppLogMsgOutputHandler : BaseOutputHandler<void, Output::LogMsg> {
  CppLogMsgOutputHandler()
      : BaseOutputHandler<void, Output::LogMsg>(
            [this](const Output::LogMsg& logMsg) {
              QLOG(Priority::INFO, logMsg);
            }) {}
};

/// @brief Handler for Output::Error that outputs error to logger
struct CppErrorOutputHandler : BaseOutputHandler<void, Output::Error> {
  CppErrorOutputHandler()
      : BaseOutputHandler<void, Output::Error>(
            [this](const Output::Error& error) {
              QLOG(Priority::ERROR, error);
            }) {}
};

} // namespace qvac_lib_inference_addon_cpp::out_handl
