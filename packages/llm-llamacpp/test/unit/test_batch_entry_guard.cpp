// BatchEntryGuard must keep LlamaModel::activeBatchJobs_ balanced even when the
// per-job entry validation throws. A leaked count makes cancel() believe a
// batch is still in flight and makes the next batch entry skip the first-batch
// cache invalidation / KV wipe (comment-3437045353).
#include <atomic>
#include <stdexcept>

#include <gtest/gtest.h>

#include "model-interface/BatchEntryGuard.hpp"

namespace {

using qvac_lib_inference_addon_llama::batching::BatchEntryGuard;

} // namespace

/// A throwing validation must not leak the counter: when validation throws the
/// guard's constructor must unwind with the count restored to its prior value.
TEST(BatchEntryGuardTest, ThrowingValidationDoesNotLeakCounter) {
  std::atomic<unsigned> counter{0};

  EXPECT_THROW(
      {
        BatchEntryGuard guard(counter, [] {
          throw std::runtime_error("entry validation failed");
        });
      },
      std::runtime_error);

  EXPECT_EQ(counter.load(), 0u)
      << "COUNTER LEAK: entry validation threw, but activeBatchJobs_ stayed "
         "positive; cancel() will think a batch is active and the next batch "
         "entry will see a non-zero prior count and skip the KV wipe";
}

/// Happy path: the guard increments on entry, reports the prior count, and
/// decrements on scope exit.
TEST(BatchEntryGuardTest, BalancesCounterAcrossScope) {
  std::atomic<unsigned> counter{0};
  {
    BatchEntryGuard guard(counter, [] {});
    EXPECT_EQ(guard.prior(), 0u);
    EXPECT_EQ(counter.load(), 1u);
  }
  EXPECT_EQ(counter.load(), 0u);
}

/// The prior count reflects an already-active batch job; the first job sees 0,
/// a concurrent second job sees 1.
TEST(BatchEntryGuardTest, PriorCountReflectsActiveJobs) {
  std::atomic<unsigned> counter{0};
  BatchEntryGuard first(counter, [] {});
  EXPECT_EQ(first.prior(), 0u);
  BatchEntryGuard second(counter, [] {});
  EXPECT_EQ(second.prior(), 1u);
  EXPECT_EQ(counter.load(), 2u);
}
