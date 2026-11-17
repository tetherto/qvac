#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <vector>

#include <gtest/gtest.h>

#include "WorkerPool.hpp"

using turbovec_ggml::WorkerPool;

namespace {

// A latch the tests open by hand, so a task can be held mid-run.
class Gate {
public:
  void open() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      open_ = true;
    }
    cv_.notify_all();
  }

  void wait() {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [this]() { return open_; });
  }

private:
  std::mutex mutex_;
  std::condition_variable cv_;
  bool open_ = false;
};

} // namespace

TEST(WorkerPool, StartsNoThreadsUntilTheFirstTask) {
  WorkerPool pool(2);
  EXPECT_EQ(pool.threadCount(), 0U);
}

TEST(WorkerPool, RunsEveryTaskBeforeItIsDestroyed) {
  std::atomic<int> ran{0};
  {
    WorkerPool pool(2);
    for (int i = 0; i < 100; ++i) {
      ASSERT_NE(pool.post([&ran]() { ran.fetch_add(1); }), 0U);
    }
  }
  EXPECT_EQ(ran.load(), 100);
}

TEST(WorkerPool, NeverStartsMoreThreadsThanItsLimit) {
  Gate gate;
  std::atomic<int> running{0};
  std::atomic<int> peak{0};
  {
    WorkerPool pool(2);
    for (int i = 0; i < 8; ++i) {
      ASSERT_NE(
          pool.post([&]() {
            const int now = running.fetch_add(1) + 1;
            int seen = peak.load();
            while (now > seen && !peak.compare_exchange_weak(seen, now)) {
            }
            gate.wait();
            running.fetch_sub(1);
          }),
          0U);
    }
    EXPECT_LE(pool.threadCount(), 2U);
    gate.open();
  }
  EXPECT_LE(peak.load(), 2);
}

TEST(WorkerPool, RunsASecondTaskWhileTheFirstIsBlocked) {
  Gate first;
  Gate secondDone;
  WorkerPool pool(2);
  ASSERT_NE(pool.post([&first]() { first.wait(); }), 0U);
  ASSERT_NE(pool.post([&secondDone]() { secondDone.open(); }), 0U);
  // Hangs here, and the test times out, if the second task waits behind the
  // first one.
  secondDone.wait();
  first.open();
}

TEST(WorkerPool, StartsQueuedTasksInPostOrderOnOneThread) {
  std::mutex mutex;
  std::vector<int> order;
  {
    WorkerPool pool(1);
    for (int i = 0; i < 20; ++i) {
      ASSERT_NE(
          pool.post([&mutex, &order, i]() {
            std::lock_guard<std::mutex> lock(mutex);
            order.push_back(i);
          }),
          0U);
    }
  }
  ASSERT_EQ(order.size(), 20U);
  for (int i = 0; i < 20; ++i) {
    EXPECT_EQ(order[static_cast<size_t>(i)], i);
  }
}

TEST(WorkerPool, TreatsAZeroLimitAsOneThread) {
  std::atomic<bool> ran{false};
  {
    WorkerPool pool(0);
    ASSERT_NE(pool.post([&ran]() { ran.store(true); }), 0U);
  }
  EXPECT_TRUE(ran.load());
}

TEST(WorkerPool, CancelsAQueuedTaskSoItNeverRuns) {
  Gate release;
  std::atomic<bool> ran{false};
  {
    WorkerPool pool(1);
    ASSERT_NE(pool.post([&release]() { release.wait(); }), 0U);
    const std::uint64_t queued = pool.post([&ran]() { ran.store(true); });
    ASSERT_NE(queued, 0U);
    EXPECT_TRUE(pool.cancel(queued));
    EXPECT_FALSE(pool.cancel(queued)) << "a ticket is cancelled once";
    release.open();
  }
  EXPECT_FALSE(ran.load());
}

TEST(WorkerPool, DoesNotCancelAStartedOrFinishedTask) {
  Gate started;
  Gate release;
  Gate finished;
  WorkerPool pool(1);
  const std::uint64_t running = pool.post([&]() {
    started.open();
    release.wait();
  });
  ASSERT_NE(running, 0U);
  started.wait();
  EXPECT_FALSE(pool.cancel(running));
  release.open();

  const std::uint64_t done = pool.post([&finished]() { finished.open(); });
  ASSERT_NE(done, 0U);
  finished.wait();
  EXPECT_FALSE(pool.cancel(done));
  EXPECT_FALSE(pool.cancel(0));
}

TEST(WorkerPool, CancellingOneTaskKeepsTheOthersInOrder) {
  Gate release;
  std::mutex mutex;
  std::vector<int> order;
  {
    WorkerPool pool(1);
    ASSERT_NE(pool.post([&release]() { release.wait(); }), 0U);
    std::vector<std::uint64_t> tickets;
    for (int i = 0; i < 5; ++i) {
      tickets.push_back(pool.post([&mutex, &order, i]() {
        std::lock_guard<std::mutex> lock(mutex);
        order.push_back(i);
      }));
      ASSERT_NE(tickets.back(), 0U);
    }
    EXPECT_TRUE(pool.cancel(tickets[2]));
    release.open();
  }
  EXPECT_EQ(order, (std::vector<int>{0, 1, 3, 4}));
}
