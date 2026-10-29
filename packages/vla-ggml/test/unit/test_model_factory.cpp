#include <cstdio>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>

#include <gguf.h>
#include <gtest/gtest.h>

#include "model-interface/model_factory.hpp"
#include "utils/BackendSelection.hpp"

using qvac_lib_infer_vla_ggml::createVlaModelFromGguf;
using qvac_lib_infer_vla_ggml::sniffGgufArchitecture;

namespace {

// Helper: write a tiny metadata-only GGUF with the given architecture key
// (omit by passing nullptr) to a freshly-generated path. Caller owns the
// file and must delete it. Returns the path on success; aborts the test
// via GTest assertions on failure.
std::string writeTempGguf(const char* archValue) {
  // gtest's TestInfo gives us a per-test unique suffix without colliding
  // when multiple tests run in parallel.
  const ::testing::TestInfo* const info =
      ::testing::UnitTest::GetInstance()->current_test_info();
  std::filesystem::path tmp =
      std::filesystem::temp_directory_path() /
      (std::string("vla_factory_") + info->test_suite_name() + "_" +
       info->name() + ".gguf");

  gguf_context* ctx = gguf_init_empty();
  if (ctx == nullptr) {
    ADD_FAILURE() << "gguf_init_empty returned NULL";
    return {};
  }
  if (archValue != nullptr) {
    gguf_set_val_str(ctx, "general.architecture", archValue);
  }
  // Also stamp a couple of generic keys to make the file look more realistic;
  // these are ignored by the sniffer.
  gguf_set_val_u32(ctx, "vla.factory_test.marker", 0xCAFEBABE);

  const bool ok =
      gguf_write_to_file(ctx, tmp.string().c_str(), /*only_meta=*/true);
  gguf_free(ctx);
  if (!ok) {
    ADD_FAILURE() << "gguf_write_to_file failed for " << tmp;
    return {};
  }
  return tmp.string();
}

void cleanupTempFile(const std::string& path) {
  if (!path.empty()) {
    std::error_code ec;
    std::filesystem::remove(path, ec);
  }
}

} // namespace

// ─── Sniffer ────────────────────────────────────────────────────────────────

TEST(VlaModelFactory, SniffsExplicitPi05Architecture) {
  const std::string path = writeTempGguf("pi05");
  ASSERT_FALSE(path.empty());
  EXPECT_EQ(sniffGgufArchitecture(path), "pi05");
  cleanupTempFile(path);
}

TEST(VlaModelFactory, SniffsExplicitGrootArchitecture) {
  const std::string path = writeTempGguf("groot");
  ASSERT_FALSE(path.empty());
  EXPECT_EQ(sniffGgufArchitecture(path), "groot");
  cleanupTempFile(path);
}

TEST(VlaModelFactory, SniffsExplicitSmolvlaArchitecture) {
  const std::string path = writeTempGguf("smolvla");
  ASSERT_FALSE(path.empty());
  EXPECT_EQ(sniffGgufArchitecture(path), "smolvla");
  cleanupTempFile(path);
}

TEST(VlaModelFactory, DefaultsToSmolvlaWhenArchitectureKeyMissing) {
  // Legacy GGUFs (v0.1.0) did not stamp `general.architecture`. The
  // sniffer must keep loading these as SmolVLA — no behaviour change
  // for the existing release line.
  const std::string path = writeTempGguf(nullptr);
  ASSERT_FALSE(path.empty());
  EXPECT_EQ(sniffGgufArchitecture(path), "smolvla");
  cleanupTempFile(path);
}

TEST(VlaModelFactory, SniffLowerCasesArchitectureValue) {
  const std::string path = writeTempGguf("Pi05");
  ASSERT_FALSE(path.empty());
  EXPECT_EQ(sniffGgufArchitecture(path), "pi05");
  cleanupTempFile(path);
}

TEST(VlaModelFactory, SniffThrowsOnMissingFile) {
  EXPECT_THROW(
      sniffGgufArchitecture("/nonexistent/vla_factory_test_missing.gguf"),
      std::runtime_error);
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

// For the dispatch tests, the metadata-only GGUF is missing every required
// tensor, so the real load path will fail. We observe which subclass the
// factory chose by inspecting the exception message: the SmolVLA adapter
// throws "failed to load SmolVLA model …" while the Pi05Model loader
// throws "pi05LoadModel: tensor missing from GGUF: …".

TEST(VlaModelFactory, DispatchesPi05ArchitectureToPi05Loader) {
  // The metadata-only GGUF doesn't carry any of the 848 tensors pi05
  // needs, so the loader throws "tensor missing from GGUF: …" — that's
  // the signature the factory dispatch picked the Pi05Model branch and
  // got past the architecture check. Bare-metal proof of dispatch
  // without needing a real ~6 GB checkpoint in the unit-test harness.
  const std::string path = writeTempGguf("pi05");
  ASSERT_FALSE(path.empty());
  try {
    (void)createVlaModelFromGguf(path, /*forceCpu=*/true, /*backendsDir=*/"");
    FAIL() << "pi05 factory dispatch should have thrown (no tensors)";
  } catch (const std::runtime_error& e) {
    const std::string what = e.what();
    EXPECT_NE(what.find("pi05LoadModel"), std::string::npos)
        << "exception did not come from Pi05Model: " << what;
    EXPECT_NE(what.find("tensor missing"), std::string::npos) << what;
  }
  cleanupTempFile(path);
}

TEST(VlaModelFactory, DispatchesGrootArchitectureToGrootLoader) {
  // Same trick as the pi05/smolvla dispatch tests: the metadata-only GGUF
  // carries none of GrootModel's ~1032 required tensors (and none of the
  // groot.embodiment_tag/embodiment_cat_id keys grootLoadModel requires),
  // so the loader throws before reaching tensor lookup — that failure
  // message alone proves dispatch picked the GrootModel branch.
  const std::string path = writeTempGguf("groot");
  ASSERT_FALSE(path.empty());
  try {
    (void)createVlaModelFromGguf(path, /*forceCpu=*/true, /*backendsDir=*/"");
    FAIL() << "groot factory dispatch should have thrown (no tensors)";
  } catch (const std::runtime_error& e) {
    const std::string what = e.what();
    EXPECT_NE(what.find("grootLoadModel"), std::string::npos)
        << "exception did not come from GrootModel: " << what;
  }
  cleanupTempFile(path);
}

TEST(VlaModelFactory, DispatchesSmolvlaArchitectureToSmolvlaAdapter) {
  const std::string path = writeTempGguf("smolvla");
  ASSERT_FALSE(path.empty());
  try {
    (void)createVlaModelFromGguf(path, /*forceCpu=*/true, /*backendsDir=*/"");
    FAIL() << "smolvla factory dispatch should have thrown (no tensors)";
  } catch (const std::runtime_error& e) {
    const std::string what = e.what();
    EXPECT_NE(what.find("SmolVLA"), std::string::npos)
        << "exception did not come from SmolvlaModelAdapter: " << what;
  }
  cleanupTempFile(path);
}

TEST(VlaModelFactory, MissingArchKeyDispatchesToSmolvlaAdapter) {
  const std::string path = writeTempGguf(nullptr);
  ASSERT_FALSE(path.empty());
  try {
    (void)createVlaModelFromGguf(path, /*forceCpu=*/true, /*backendsDir=*/"");
    FAIL() << "legacy GGUF should have dispatched to SmolVLA";
  } catch (const std::runtime_error& e) {
    const std::string what = e.what();
    EXPECT_NE(what.find("SmolVLA"), std::string::npos)
        << "exception did not come from SmolvlaModelAdapter: " << what;
  }
  cleanupTempFile(path);
}

TEST(VlaModelFactory, RejectsUnknownArchitecture) {
  const std::string path = writeTempGguf("not_a_real_arch");
  ASSERT_FALSE(path.empty());
  try {
    (void)createVlaModelFromGguf(path, /*forceCpu=*/true, /*backendsDir=*/"");
    FAIL() << "unknown architecture should have been rejected";
  } catch (const std::runtime_error& e) {
    const std::string what = e.what();
    EXPECT_NE(what.find("not_a_real_arch"), std::string::npos) << what;
  }
  cleanupTempFile(path);
}

// ─── Backend override never lands on CPU ────────────────────────────────────

// Backend selection runs before any of the three loaders reads the GGUF, so a
// metadata-only file is enough to see which error comes first. An override
// that matches no family falls back to the default GPU order, so only a host
// with no usable GPU at all must refuse with "matched no usable GPU device"
// instead of quietly taking the CPU path and failing later
// on a missing tensor. On a host that does have a GPU, selection succeeds and
// that message must be absent. pi05 then allocates device buffers before it
// checks the tensor list, and ggml returns no buffer for a context with no
// tensors on every backend, so pi05 must hit the strict "weight load failed"
// refusal. groot stops earlier on its missing embodiment metadata and smolvla
// on a missing tensor, so for them only the absence is asserted. Both
// branches are asserted so the test means something on CPU-only CI runners
// and on GPU dev boxes alike.
namespace {

constexpr const char* NO_DEVICE_MESSAGE = "matched no usable GPU device";
constexpr const char* WEIGHT_LOAD_MESSAGE = "weight load failed on";

void expectOverrideStrictness(const char* arch, bool gpuReachesWeightLoad) {
  const std::vector<std::string> override{"cuda"};
  // The loaders register dynamic backends on first load. Do it here too, or
  // the probe sees no GPU when this test runs first (--gtest_filter, shuffle).
  vla_backend_selection::loadBackendsOnce("");
  const bool hostHasGpu =
      vla_backend_selection::pickBestGpuDevice(override) != nullptr;
  const std::string path = writeTempGguf(arch);
  ASSERT_FALSE(path.empty());
  try {
    (void)createVlaModelFromGguf(
        path, /*forceCpu=*/false, /*backendsDir=*/"", {}, override);
    FAIL() << arch << ": load should have thrown (no tensors)";
  } catch (const std::runtime_error& e) {
    const std::string what = e.what();
    const bool refusedForNoDevice =
        what.find(NO_DEVICE_MESSAGE) != std::string::npos;
    // "backend: " would make index.js report INVALID_CONFIG instead of
    // FAILED_TO_LOAD_WEIGHTS.
    EXPECT_EQ(what.find("backend: "), std::string::npos) << what;
    if (hostHasGpu) {
      EXPECT_FALSE(refusedForNoDevice)
          << arch << ": a usable GPU exists, so the loader must not claim "
          << "there is none: " << what;
      if (gpuReachesWeightLoad) {
        EXPECT_NE(what.find(WEIGHT_LOAD_MESSAGE), std::string::npos)
            << arch << ": the device weight load must refuse the override "
            << "rather than fall back to CPU: " << what;
      }
    } else {
      EXPECT_TRUE(refusedForNoDevice)
          << arch << ": no GPU for 'cuda', so the loader must refuse the "
          << "override rather than fall back to CPU: " << what;
      EXPECT_NE(what.find("not falling back to CPU"), std::string::npos)
          << what;
    }
  }
  cleanupTempFile(path);
}

} // namespace

TEST(VlaModelFactory, Pi05BackendOverrideNeverFallsBackToCpu) {
  expectOverrideStrictness("pi05", /*gpuReachesWeightLoad=*/true);
}

TEST(VlaModelFactory, GrootBackendOverrideNeverFallsBackToCpu) {
  expectOverrideStrictness("groot", /*gpuReachesWeightLoad=*/false);
}

TEST(VlaModelFactory, SmolvlaBackendOverrideNeverFallsBackToCpu) {
  expectOverrideStrictness("smolvla", /*gpuReachesWeightLoad=*/false);
}

TEST(VlaModelFactory, AutoBackendStillFallsBackToCpu) {
  // 'auto' keeps the fallback: with no override the only error is the missing
  // tensor, whatever the host has.
  const std::string path = writeTempGguf("pi05");
  ASSERT_FALSE(path.empty());
  try {
    (void)createVlaModelFromGguf(path, /*forceCpu=*/false, /*backendsDir=*/"");
    FAIL() << "load should have thrown (no tensors)";
  } catch (const std::runtime_error& e) {
    const std::string what = e.what();
    EXPECT_EQ(what.find("backend override"), std::string::npos) << what;
  }
  cleanupTempFile(path);
}

TEST(VlaModelFactory, DescribeOverrideJoinsFamiliesWithCommas) {
  using vla_backend_selection::describeBackendOverride;
  EXPECT_EQ(describeBackendOverride({}), "");
  EXPECT_EQ(describeBackendOverride({"cuda"}), "cuda");
  EXPECT_EQ(describeBackendOverride({"cuda", "vulkan"}), "cuda,vulkan");
}

TEST(VlaModelFactory, StrictGpuRefusalKeepsLoadErrorCode) {
  using vla_backend_selection::StrictGpuFailure;
  using vla_backend_selection::strictGpuRefusal;
  const std::vector<std::string> override{"cuda", "vulkan"};
  for (const StrictGpuFailure failure :
       {StrictGpuFailure::NoDevice,
        StrictGpuFailure::DeviceInitFailed,
        StrictGpuFailure::WeightLoadFailed}) {
    const std::string what = strictGpuRefusal(failure, override, "CUDA0");
    // "backend: " would make index.js report INVALID_CONFIG instead of
    // FAILED_TO_LOAD_WEIGHTS.
    EXPECT_EQ(what.find("backend: "), std::string::npos) << what;
    EXPECT_NE(what.find("'cuda,vulkan'"), std::string::npos) << what;
    EXPECT_NE(what.find("not falling back to CPU"), std::string::npos) << what;
  }
  EXPECT_NE(
      strictGpuRefusal(StrictGpuFailure::WeightLoadFailed, override, "CUDA0")
          .find("weight load failed on CUDA0"),
      std::string::npos);
}

TEST(VlaModelFactory, AutoInBackendListKeepsCpuFallback) {
  // 'cuda,auto' asks for CUDA first and allows the default order after it,
  // CPU included, so no loader may refuse it for lack of a GPU.
  const std::vector<std::string> override =
      vla_backend_selection::parseBackendRequest("cuda,auto");
  for (const char* arch : {"pi05", "groot", "smolvla"}) {
    const std::string path = writeTempGguf(arch);
    ASSERT_FALSE(path.empty());
    try {
      (void)createVlaModelFromGguf(
          path, /*forceCpu=*/false, /*backendsDir=*/"", {}, override);
      FAIL() << arch << ": load should have thrown (no tensors)";
    } catch (const std::runtime_error& e) {
      const std::string what = e.what();
      EXPECT_EQ(what.find("backend override"), std::string::npos)
          << arch << ": " << what;
    }
    cleanupTempFile(path);
  }
}

TEST(VlaModelFactory, ParseBackendRequestMarksAuto) {
  using vla_backend_selection::backendOverrideIsStrict;
  using vla_backend_selection::parseBackendRequest;
  EXPECT_EQ(parseBackendRequest("cuda"), (std::vector<std::string>{"cuda"}));
  EXPECT_EQ(
      parseBackendRequest("auto,cuda"),
      (std::vector<std::string>{"cuda", "auto"}));
  EXPECT_EQ(
      parseBackendRequest(" CUDA , Auto ,vulkan"),
      (std::vector<std::string>{"cuda", "vulkan", "auto"}));
  EXPECT_TRUE(parseBackendRequest("auto").empty());
  EXPECT_TRUE(backendOverrideIsStrict(parseBackendRequest("cuda,vulkan")));
  EXPECT_FALSE(backendOverrideIsStrict(parseBackendRequest("cuda,auto")));
  EXPECT_FALSE(backendOverrideIsStrict({}));
}
