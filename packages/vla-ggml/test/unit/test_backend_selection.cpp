#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "utils/BackendSelection.hpp"

using vla_backend_selection::parseAdrenoModel;
using vla_backend_selection::parseBackendOverride;

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

// ---- QVAC-23763: the `backend` override ----
//
// Only the parsing half is covered here. pickBestGpuDevice() calls the ggml
// device API directly rather than through an injectable interface, unlike the
// llm and embed addons, so its preference order has no unit-test seam. That is
// pre-existing and not introduced by this change.

TEST(VlaBackendSelection, ParseBackendOverrideLowercasesAndSplits) {
  EXPECT_EQ(
      parseBackendOverride("CUDA,Vulkan"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST(VlaBackendSelection, ParseBackendOverrideTrimsSpaces) {
  EXPECT_EQ(
      parseBackendOverride(" cuda , vulkan "),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST(VlaBackendSelection, ParseBackendOverrideDropsDuplicates) {
  EXPECT_EQ(
      parseBackendOverride("cuda,cuda,vulkan"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST(VlaBackendSelection, ParseBackendOverrideIgnoresEmptyEntries) {
  EXPECT_EQ(
      parseBackendOverride("cuda,,vulkan,"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

TEST(VlaBackendSelection, ParseBackendOverrideAcceptsHipAndRocm) {
  EXPECT_EQ(
      parseBackendOverride("rocm,hip"),
      (std::vector<std::string>{"rocm", "hip"}));
}

// BEHAVIOUR CHANGE, QVAC-23763: before this, any value other than "cpu" was
// silently treated as "pick the best device", so a typo went unnoticed.
TEST(VlaBackendSelection, ParseBackendOverrideThrowsOnUnknownName) {
  EXPECT_THROW(parseBackendOverride("cudaa"), qvac_errors::StatusError);
}

// 'cpu' is stripped by the addon layer into forceCpu before parsing, so it is
// not a GPU family name here. This differs from llm and embed, where the CPU
// path is the separate `device` key.
TEST(VlaBackendSelection, ParseBackendOverrideRejectsCpu) {
  EXPECT_THROW(parseBackendOverride("cpu"), qvac_errors::StatusError);
}
