#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>
#include <qvac-fabric-server-context-port.h>
#include <qvac-fabric.h>

#include "model-interface/utils.hpp"

namespace {

const std::unordered_set<std::string> ALLOWED = {"device", "threads"};
const char* const INVALID = "[ Decision :: InvalidConfiguration ]";

/// The code of the StatusError @p config raises, or "no error".
std::string
checkResult(const std::unordered_map<std::string, std::string>& config) {
  try {
    checkLoadOptions(config, ALLOWED, "test", "Test", "device, threads");
  } catch (const qvac_errors::StatusError& error) {
    return error.codeString();
  }
  return "no error";
}

} // namespace

TEST(CheckLoadOptionsTest, AcceptsAllowedKeys) {
  EXPECT_EQ(checkResult({}), "no error");
  EXPECT_EQ(checkResult({{"device", "cpu"}, {"threads", "1"}}), "no error");
}

TEST(CheckLoadOptionsTest, RejectsAnUnknownKeyNamingTheAcceptedOnes) {
  try {
    checkLoadOptions(
        {{"pooling", "mean"}}, ALLOWED, "test", "Test", "device, threads");
    FAIL() << "expected InvalidConfiguration";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_EQ(error.codeString(), INVALID);
    EXPECT_STREQ(
        error.what(),
        "test: 'pooling' is not a Test load option; accepted: device, threads");
  }
}

TEST(CheckLoadOptionsTest, ZeroOrFewerThreadsMeansEveryCpu) {
  EXPECT_EQ(checkResult({{"threads", "0"}}), "no error");
  EXPECT_EQ(checkResult({{"threads", "-1"}}), "no error");
}

TEST(CheckLoadOptionsTest, RejectsThreadsThatAreNotAWholeNumber) {
  for (const char* value : {"", "4k", "1.5", " 2", "99999999999999999999"}) {
    EXPECT_EQ(checkResult({{"threads", value}}), INVALID) << value;
  }
}

TEST(CheckLoadOptionsTest, RejectsMoreThreadsThanCpus) {
  const unsigned cpus = std::thread::hardware_concurrency();
  if (cpus == 0) {
    GTEST_SKIP() << "CPU count unknown";
  }
  // The check takes the larger of the online and the configured CPU count, so
  // a value far above either is rejected on any device.
  EXPECT_EQ(checkResult({{"threads", std::to_string(cpus * 64)}}), INVALID);
}

TEST(IsThreadsKeyTest, NamesTheThreadCountKeys) {
  EXPECT_TRUE(isThreadsKey("threads"));
  EXPECT_TRUE(isThreadsKey("threads-batch"));
  EXPECT_TRUE(isThreadsKey("threads_batch"));
  EXPECT_FALSE(isThreadsKey("parallel"));
}

TEST(FabricPortTest, AcceptsTheSamePort) {
  EXPECT_EQ(fabricPortMismatch("12032.0.0", "12032.0.0"), "");
  EXPECT_EQ(fabricPortMismatch("11739.2.0#1", "11739.2.0#1"), "");
}

TEST(FabricPortTest, RejectsAnotherPortNamingBoth) {
  // A recipe-only bump (#1) counts: it may change how the code is built.
  for (const char* loaded : {"12032.0.1", "12032.0.0#1", "11739.5.0"}) {
    const std::string message = fabricPortMismatch(loaded, "12032.0.0");
    EXPECT_NE(
        message.find("built for qvac-fabric 12032.0.0,"), std::string::npos)
        << message;
    EXPECT_NE(
        message.find(
            "runtime is built from qvac-fabric " + std::string(loaded) + "."),
        std::string::npos)
        << message;
  }
  EXPECT_NE(
      fabricPortMismatch(nullptr, "12032.0.0").find("qvac-fabric (unknown)"),
      std::string::npos);
}

TEST(FabricPortTest, TheLoadedRuntimeIsTheServerContextPort) {
  // What the addon's exports function checks, on the runtime this test loads.
  EXPECT_STREQ(qvac_fabric_port_version(), QVAC_FABRIC_SERVER_CONTEXT_PORT);
  EXPECT_EQ(
      fabricPortMismatch(
          qvac_fabric_port_version(), QVAC_FABRIC_SERVER_CONTEXT_PORT),
      "");
}
