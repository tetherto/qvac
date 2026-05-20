#include <cstdio>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>

#include <gtest/gtest.h>

#include <gguf.h>

#include "model-interface/model_factory.hpp"

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
// tensor, so the real SmolVLA load path will fail. We can't reach a
// successful infer() with a synthetic fixture, but we CAN observe which
// subclass the factory chose by inspecting the exception message: the
// SmolVLA adapter throws "failed to load SmolVLA model …" while the
// π₀.₅ stub throws "pi05 … not yet implemented".

TEST(VlaModelFactory, DispatchesPi05ArchitectureToPi05Stub) {
  const std::string path = writeTempGguf("pi05");
  ASSERT_FALSE(path.empty());
  try {
    (void)createVlaModelFromGguf(path, /*forceCpu=*/true, /*backendsDir=*/"");
    FAIL() << "pi05 factory dispatch should have thrown (stub)";
  } catch (const std::runtime_error& e) {
    const std::string what = e.what();
    EXPECT_NE(what.find("pi05"), std::string::npos)
        << "exception did not come from Pi05Model: " << what;
    EXPECT_NE(what.find("not yet implemented"), std::string::npos) << what;
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
