// JobCancelRegistry: the parked-cancel machinery that keeps a cancel from
// being lost while a job sits between the scheduler queue and its engine slot
// (announced via jobStarting but not yet armed with a cancel action).

#include <gtest/gtest.h>

#include "utils/JobCancelRegistry.hpp"

namespace {

using JobId = JobCancelRegistry::JobId;

TEST(JobCancelRegistryTest, CancelOnUnarmedJobParksUntilArmed) {
  JobCancelRegistry registry;
  registry.add(JobId{1});

  registry.cancel(JobId{1});

  int fired = 0;
  EXPECT_TRUE(registry.add(JobId{1}, [&fired] { ++fired; }))
      << "arming must hand back the parked cancel";
  EXPECT_EQ(fired, 0) << "arming applies nothing itself; the caller does";
}

TEST(JobCancelRegistryTest, ArmingWithoutParkedCancelReturnsFalse) {
  JobCancelRegistry registry;
  registry.add(JobId{1});

  EXPECT_FALSE(registry.add(JobId{1}, [] {}));
}

TEST(JobCancelRegistryTest, ArmCreatesEntryForUnannouncedJob) {
  JobCancelRegistry registry;

  // Single-job scheduler path: no jobStarting announcement precedes arming.
  EXPECT_FALSE(registry.add(JobId{7}, [] {}));

  int fired = 0;
  (void)registry.add(JobId{7}, [&fired] { ++fired; });
  registry.cancel(JobId{7});
  EXPECT_EQ(fired, 1);
}

TEST(JobCancelRegistryTest, ParkAllReachesUnarmedJobs) {
  JobCancelRegistry registry;
  registry.add(JobId{1});
  registry.add(JobId{2});

  registry.parkAll();

  EXPECT_TRUE(registry.add(JobId{1}, [] {}));
  EXPECT_TRUE(registry.add(JobId{2}, [] {}));
}

TEST(JobCancelRegistryTest, ParkAllDoesNotRunArmedActions) {
  JobCancelRegistry registry;
  int fired = 0;
  (void)registry.add(JobId{1}, [&fired] { ++fired; });

  registry.parkAll();

  EXPECT_EQ(fired, 0)
      << "parkAll must never run actions: the caller may sit inside a "
         "streaming callback on the engine's own worker thread";
}

TEST(JobCancelRegistryTest, ParkAllOnlyAffectsJobsAlreadyLive) {
  JobCancelRegistry registry;
  registry.parkAll();

  registry.add(JobId{3});
  EXPECT_FALSE(registry.add(JobId{3}, [] {}))
      << "a job announced after the cancel must not inherit it";
}

TEST(JobCancelRegistryTest, ConsumeParkedTakesFlagWithoutArming) {
  JobCancelRegistry registry;
  registry.add(JobId{1});
  registry.parkAll();

  EXPECT_TRUE(registry.consumeParked(JobId{1}));
  EXPECT_FALSE(registry.consumeParked(JobId{1})) << "take-once semantics";
  EXPECT_FALSE(registry.consumeParked(JobId{2})) << "unknown ids are a no-op";
}

TEST(JobCancelRegistryTest, RemovedJobIgnoresLateCancels) {
  JobCancelRegistry registry;
  int fired = 0;
  (void)registry.add(JobId{1}, [&fired] { ++fired; });
  registry.remove(JobId{1});

  registry.cancel(JobId{1});
  registry.parkAll();

  EXPECT_EQ(fired, 0);
  EXPECT_FALSE(registry.add(JobId{1}, [] {}))
      << "a fresh registration must not see stale parked state";
}

TEST(JobCancelRegistryTest, BindPicksUpParkedCancel) {
  JobCancelRegistry registry;
  registry.add(JobId{1});
  registry.parkAll();

  EXPECT_TRUE(registry.bind(JobId{1}, [] {}))
      << "bind must hand back a cancel parked before the slot existed";
  EXPECT_FALSE(registry.bind(JobId{2}, [] {}))
      << "bind must not resurrect unknown (finished) ids";
}

} // namespace
