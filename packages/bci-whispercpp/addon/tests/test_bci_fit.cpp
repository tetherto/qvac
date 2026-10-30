#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "addon/AppMemoryBudget.hpp"
#include "model-interface/bci/BciFit.hpp"

using qvac_lib_inference_addon_bci::applyAppMemoryBudget;
using qvac_lib_inference_addon_bci::BciFit;

namespace {
constexpr uint64_t MiB = 1024 * 1024;

// A whisper projection that fits on a device sharing host memory: 400 MiB on
// the device and 100 MiB on the host, against 1000 MiB free.
BciFit sharedMemoryFit(uint64_t embedderBytes) {
  BciFit fit;
  fit.whisper.status = WHISPER_FIT_SUCCESS;
  fit.whisper.device_shares_host_memory = true;
  fit.whisper.device.total_bytes = 400 * MiB;
  fit.whisper.host_bytes = 100 * MiB;
  fit.whisper.device_free_bytes = 1000 * MiB;
  fit.marginBytes = 256 * MiB;
  fit.embedderBytes = embedderBytes;
  return fit;
}

struct Row {
  bool unified;
  double usedBytes;
  double freeBytes;
};
} // namespace

TEST(BciFitTest, TheHostHoldsWhisperBuffersAndTheEmbedder) {
  EXPECT_EQ(sharedMemoryFit(30 * MiB).hostBytes(), 130 * MiB);
}

TEST(BciFitTest, TheEmbedderTurnsASharedMemoryFitIntoDoesNotFit) {
  EXPECT_TRUE(sharedMemoryFit(244 * MiB).fits());
  EXPECT_FALSE(sharedMemoryFit(245 * MiB).fits());
}

TEST(BciFitTest, TheEmbedderLeavesADiscreteDeviceVerdictAlone) {
  BciFit fit = sharedMemoryFit(10000 * MiB);
  fit.whisper.device_shares_host_memory = false;
  EXPECT_TRUE(fit.fits());
}

TEST(AppMemoryBudgetTest, KeepsAFitWithinTheBudget) {
  std::vector<Row> rows{{true, 600, 8000}, {true, 300, 8000}};
  EXPECT_EQ(applyAppMemoryBudget("fits", rows, 1000, 0), "fits");
  EXPECT_EQ(rows[0].freeBytes, 1000);
  EXPECT_EQ(rows[1].freeBytes, 1000);
}

TEST(AppMemoryBudgetTest, RefusesAFitTheBackendAllowsButTheBudgetDoesNot) {
  std::vector<Row> rows{{true, 1500, 8000}, {true, 700, 8000}};
  EXPECT_EQ(applyAppMemoryBudget("fits", rows, 1000, 0), "does-not-fit");
}

TEST(AppMemoryBudgetTest, KeepsTheMarginFreeWithinTheBudget) {
  std::vector<Row> rows{{true, 600, 8000}, {true, 300, 8000}};
  EXPECT_EQ(applyAppMemoryBudget("fits", rows, 1000, 100), "fits");
  EXPECT_EQ(applyAppMemoryBudget("fits", rows, 1000, 101), "does-not-fit");
}

TEST(AppMemoryBudgetTest, TreatsAZeroBudgetAsExhausted) {
  std::vector<Row> rows{{true, 1, 8000}};
  EXPECT_EQ(applyAppMemoryBudget("fits", rows, 0, 0), "does-not-fit");
  EXPECT_EQ(rows[0].freeBytes, 0);
}

TEST(AppMemoryBudgetTest, LeavesDiscreteRowsAndOtherStatusesAlone) {
  std::vector<Row> rows{{false, 5000, 8000}, {true, 100, 8000}};
  EXPECT_EQ(applyAppMemoryBudget("fits", rows, 1000, 0), "fits");
  EXPECT_EQ(rows[0].freeBytes, 8000);
  EXPECT_EQ(
      applyAppMemoryBudget("does-not-fit", rows, 1000, 0), "does-not-fit");
}
