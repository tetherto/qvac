#include <vector>

#include <gtest/gtest.h>

#include "addon/FitVerdict.hpp"

using qvac_lib_inference_addon_nmt::capToAppLimit;
using qvac_lib_inference_addon_nmt::FitDevice;
using qvac_lib_inference_addon_nmt::fitVerdict;

namespace {
FitDevice row(bool unified, uint64_t usedBytes, uint64_t freeBytes) {
  return {"id", "name", unified, usedBytes, freeBytes, freeBytes};
}
} // namespace

TEST(NmtFitVerdict, FitsWhenEveryRowHasRoom) {
  const std::vector<FitDevice> rows{row(false, 600, 1000), row(true, 100, 400)};
  EXPECT_EQ(fitVerdict(rows, 100, 200, false), "fits");
}

TEST(NmtFitVerdict, AHostRowWithoutRoomDoesNotYieldAFit) {
  const std::vector<FitDevice> rows{row(false, 600, 1000), row(true, 100, 250)};
  EXPECT_EQ(fitVerdict(rows, 100, 200, false), "unknown");
}

TEST(NmtFitVerdict, TheCpuDoesNotFitWhenTheSourceBytesDoNot) {
  const std::vector<FitDevice> rows{row(true, 600, 400)};
  EXPECT_EQ(fitVerdict(rows, 300, 200, true), "does-not-fit");
  EXPECT_EQ(fitVerdict(rows, 150, 200, true), "unknown");
}

TEST(NmtFitVerdict, AnExhaustedAppLimitIsDoesNotFitOnTheCpu) {
  std::vector<FitDevice> rows{row(true, 600, 8000)};
  capToAppLimit(rows, 0);
  EXPECT_EQ(rows.front().freeBytes, 0U);
  EXPECT_EQ(fitVerdict(rows, 100, 0, true), "does-not-fit");
}

TEST(NmtFitVerdict, TheAppLimitAndTheMarginBindAUnifiedFit) {
  std::vector<FitDevice> rows{row(true, 600, 8000), row(true, 0, 8000)};
  EXPECT_EQ(fitVerdict(rows, 100, 200, false), "fits");
  capToAppLimit(rows, 700);
  EXPECT_EQ(rows[0].freeBytes, 700U);
  EXPECT_EQ(rows[1].freeBytes, 700U);
  EXPECT_EQ(fitVerdict(rows, 100, 200, false), "unknown");
}

TEST(NmtFitVerdict, TheAppLimitLeavesADiscreteRowAlone) {
  std::vector<FitDevice> rows{row(false, 600, 8000), row(true, 600, 8000)};
  capToAppLimit(rows, 700);
  EXPECT_EQ(rows[0].freeBytes, 8000U);
  EXPECT_EQ(rows[1].freeBytes, 700U);
}
