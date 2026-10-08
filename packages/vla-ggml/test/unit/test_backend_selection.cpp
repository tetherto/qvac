#include <gtest/gtest.h>

#include "utils/BackendSelection.hpp"

using vla_backend_selection::parseAdrenoModel;

TEST(VlaBackendSelection, ParsesAdrenoTrademarkForm) {
  EXPECT_EQ(parseAdrenoModel("Adreno (TM) 830"), 830);
  EXPECT_EQ(parseAdrenoModel("Adreno (TM) 750"), 750);
  EXPECT_EQ(parseAdrenoModel("Adreno (TM) 660"), 660);
}

TEST(VlaBackendSelection, ParsesAdrenoBareForm) {
  EXPECT_EQ(parseAdrenoModel("Adreno 740"), 740);
  EXPECT_EQ(parseAdrenoModel("adreno 730"), 730);
}

TEST(VlaBackendSelection, IsCaseInsensitive) {
  EXPECT_EQ(parseAdrenoModel("ADRENO 830"), 830);
  EXPECT_EQ(parseAdrenoModel("aDrEnO (tm) 740"), 740);
}

TEST(VlaBackendSelection, ReturnsZeroForNonAdreno) {
  EXPECT_EQ(parseAdrenoModel("Mali-G715"), 0);
  EXPECT_EQ(parseAdrenoModel("NVIDIA RTX 4090"), 0);
  EXPECT_EQ(parseAdrenoModel("Apple M1 Pro"), 0);
  EXPECT_EQ(parseAdrenoModel(""), 0);
}

TEST(VlaBackendSelection, ReturnsZeroWhenAdrenoFollowedByNoDigits) {
  EXPECT_EQ(parseAdrenoModel("Adreno"), 0);
  EXPECT_EQ(parseAdrenoModel("Adreno (TM)"), 0);
}
