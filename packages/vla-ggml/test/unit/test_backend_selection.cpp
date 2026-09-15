#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "utils/BackendSelection.hpp"

using vla_backend_selection::backendNameMatchesFamily;
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

// Both spellings are accepted and both mean the same family, so the list
// collapses to the "rocm" that ggml's HIP build actually reports.
TEST(VlaBackendSelection, ParseBackendOverrideAcceptsHipAndRocm) {
  EXPECT_EQ(
      parseBackendOverride("rocm,hip"), (std::vector<std::string>{"rocm"}));
}

// BEHAVIOUR CHANGE, QVAC-23763: before this, any value other than "cpu" was
// silently treated as "pick the best device", so a typo went unnoticed.
TEST(VlaBackendSelection, ParseBackendOverrideThrowsOnUnknownName) {
  EXPECT_THROW(parseBackendOverride("cudaa"), qvac_errors::StatusError);
}

// 'cpu' is stripped by the addon layer into forceCpu before parsing, so it is
// not a GPU family name here. This differs from llm and embed, where the CPU
// path is the separate `device` key.
// ggml's HIP build reports its devices as "ROCm%d", so 'hip' has to arrive at
// the matcher as "rocm" or it pins nothing.
TEST(VlaBackendSelection, ParseBackendOverrideCanonicalisesHipToRocm) {
  EXPECT_EQ(parseBackendOverride("hip"), (std::vector<std::string>{"rocm"}));
  EXPECT_EQ(
      parseBackendOverride("HIP,rocm"), (std::vector<std::string>{"rocm"}));
}

// A blank value means the key was not configured, but a value made only of
// separators is a mistake and must be as loud as a misspelled name.
TEST(VlaBackendSelection, ParseBackendOverrideRejectsAValueNamingNothing) {
  EXPECT_THROW(parseBackendOverride(","), qvac_errors::StatusError);
  EXPECT_THROW(parseBackendOverride(" , "), qvac_errors::StatusError);
  EXPECT_TRUE(parseBackendOverride("   ").empty());
}

// 'cpu' is handled by the addon layer before this is reached, in any case.
TEST(VlaBackendSelection, ParseBackendOverrideRejectsCpuInAnyCase) {
  EXPECT_THROW(parseBackendOverride("CPU"), qvac_errors::StatusError);
  EXPECT_THROW(parseBackendOverride("cpu,vulkan"), qvac_errors::StatusError);
}

TEST(VlaBackendSelection, ParseBackendOverrideRejectsCpu) {
  EXPECT_THROW(parseBackendOverride("cpu"), qvac_errors::StatusError);
}

// llm-llamacpp and embed-llamacpp both carry this case; vla ships on Metal
// too, so the same spelling has to match here.
TEST(VlaBackendSelection, MatchesTheMtlSpellingOfMetal) {
  EXPECT_TRUE(backendNameMatchesFamily("metal0", "metal"));
  EXPECT_TRUE(backendNameMatchesFamily("mtl0", "metal"));
  EXPECT_FALSE(backendNameMatchesFamily("vulkan0", "metal"));
  // Only as a prefix: "mtl" inside another name is not a Metal device.
  EXPECT_FALSE(backendNameMatchesFamily("xmtl0", "metal"));
}

TEST(VlaBackendSelection, MatchesFamilyBySubstring) {
  EXPECT_TRUE(backendNameMatchesFamily("cuda0", "cuda"));
  EXPECT_TRUE(backendNameMatchesFamily("gpuopencl", "opencl"));
  EXPECT_FALSE(backendNameMatchesFamily("rocm0", "cuda"));
}

// createInstance maps a bare 'auto' to no preference; inside a list it must be
// dropped rather than rejected as an unknown family.
TEST(VlaBackendSelection, ParseBackendOverrideAcceptsAutoInAList) {
  EXPECT_EQ(
      parseBackendOverride("auto,cuda"), (std::vector<std::string>{"cuda"}));
  EXPECT_TRUE(parseBackendOverride("auto").empty());
  EXPECT_TRUE(parseBackendOverride(" AUTO ").empty());
}

// index.js trims the whole value but not each entry, so a CRLF config file
// would otherwise throw on a value that reads as correct.
TEST(VlaBackendSelection, ParseBackendOverrideTrimsCarriageReturns) {
  EXPECT_EQ(
      parseBackendOverride("cuda\r\n,\tvulkan\r"),
      (std::vector<std::string>{"cuda", "vulkan"}));
}

// Accepting 'auto' must not weaken this: a value naming nothing is still a
// config mistake.
TEST(VlaBackendSelection, ParseBackendOverrideStillRejectsSeparatorsOnly) {
  EXPECT_THROW(parseBackendOverride(","), qvac_errors::StatusError);
  EXPECT_THROW(parseBackendOverride(" , "), qvac_errors::StatusError);
}
