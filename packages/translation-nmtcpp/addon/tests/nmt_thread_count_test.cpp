#include <gtest/gtest.h>

#include "model-interface/nmt_utils.hpp"

namespace {

constexpr int TEST_COMPUTE_THREADS = 1;
constexpr int HARDWARE_DERIVED_THREAD_COUNT = 0;

class ComputeThreadCapEnvironment : public ::testing::Environment {
public:
  void SetUp() override { nmtSetThreadCountForTesting(TEST_COMPUTE_THREADS); }
};

const ::testing::Environment* const COMPUTE_THREAD_CAP_ENV =
    ::testing::AddGlobalTestEnvironment(new ComputeThreadCapEnvironment);

int threadCountWithoutTestCap() {
  nmtSetThreadCountForTesting(HARDWARE_DERIVED_THREAD_COUNT);
  const int threadCount = get_optimal_thread_count();
  nmtSetThreadCountForTesting(TEST_COMPUTE_THREADS);
  return threadCount;
}

} // namespace

TEST(NmtThreadCountTest, TestBuildCapsComputeThreads) {
  EXPECT_EQ(get_optimal_thread_count(), TEST_COMPUTE_THREADS);
}

TEST(NmtThreadCountTest, ClearingTheCapRestoresAPositiveHardwareCount) {
  EXPECT_GT(threadCountWithoutTestCap(), 0);
}
