#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "addon/AppMemoryBudget.hpp"

using qvac::audiogenggml::addon_js::applyAppMemoryBudget;

namespace {
struct Row {
  bool unified;
  double usedBytes;
  double freeBytes;
};
} // namespace

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
