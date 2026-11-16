#include <cstdlib>
#include <filesystem>
#include <string>

#include <gtest/gtest.h>

#include "model-interface/LlamaLazyInitializeBackend.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

namespace {
void setRaggedEnv(const char* value) {
#ifdef _WIN32
  _putenv_s("LLAMA_RS_RAGGED", value == nullptr ? "" : value);
#else
  if (value == nullptr) {
    unsetenv("LLAMA_RS_RAGGED");
  } else {
    setenv("LLAMA_RS_RAGGED", value, /*overwrite=*/1);
  }
#endif
}

std::string raggedEnv() {
  const char* value = std::getenv("LLAMA_RS_RAGGED");
  return value == nullptr ? std::string() : std::string(value);
}
} // namespace

TEST(LlamaRaggedUbatchesDefault, SetsZeroWhenUnset) {
  setRaggedEnv(nullptr);
  LlamaLazyInitializeBackend::defaultRaggedUbatchesOff();
  EXPECT_EQ(raggedEnv(), "0");
}

TEST(LlamaRaggedUbatchesDefault, KeepsCallerValue) {
  setRaggedEnv("1");
  LlamaLazyInitializeBackend::defaultRaggedUbatchesOff();
  EXPECT_EQ(raggedEnv(), "1");
  setRaggedEnv(nullptr);
}

class LlamaLazyInitializeBackendTest : public ::testing::Test {
protected:
  std::string getTestBackendsDir() {
    return test_common::getTestBackendsDir().string();
  }
};

TEST_F(LlamaLazyInitializeBackendTest, InitializeWithEmptyDir) {
  bool result1 = LlamaLazyInitializeBackend::initialize("");
  EXPECT_TRUE(result1);

  bool result2 = LlamaLazyInitializeBackend::initialize("");
  EXPECT_FALSE(result2);
}

TEST_F(LlamaLazyInitializeBackendTest, InitializeWithBackendsDir) {
  std::string backendsDir = getTestBackendsDir();
  EXPECT_NO_THROW({
    bool result = LlamaLazyInitializeBackend::initialize(backendsDir);
    (void)result;
  });
}

TEST_F(LlamaLazyInitializeBackendTest, InitializeIdempotency) {
  std::string backendsDir = getTestBackendsDir();

  bool result1 = LlamaLazyInitializeBackend::initialize(backendsDir);
  bool result2 = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_FALSE(result2);
}

TEST_F(LlamaLazyInitializeBackendTest, RefCountOperations) {
  LlamaLazyInitializeBackend::initialize("");

  EXPECT_NO_THROW({
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
  });
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleConstruction) {
  std::string backendsDir = getTestBackendsDir();
  EXPECT_NO_THROW({ LlamaBackendsHandle handle(backendsDir); });
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleMoveConstruction) {
  std::string backendsDir = getTestBackendsDir();

  {
    LlamaBackendsHandle handle1(backendsDir);
    EXPECT_NO_THROW({ LlamaBackendsHandle handle2(std::move(handle1)); });
  }
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleMoveAssignment) {
  std::string backendsDir = getTestBackendsDir();

  {
    LlamaBackendsHandle handle1(backendsDir);
    LlamaBackendsHandle handle2("");
    EXPECT_NO_THROW({ handle2 = std::move(handle1); });
  }
}

TEST_F(LlamaLazyInitializeBackendTest, MultipleBackendsHandles) {
  std::string backendsDir = getTestBackendsDir();
  EXPECT_NO_THROW({
    LlamaBackendsHandle handle1(backendsDir);
    LlamaBackendsHandle handle2(backendsDir);
    LlamaBackendsHandle handle3(backendsDir);
  });
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleEmptyDir) {
  EXPECT_NO_THROW({ LlamaBackendsHandle handle(""); });
}

TEST_F(LlamaLazyInitializeBackendTest, BackendDirectoryTracking) {
  std::string backendsDir = getTestBackendsDir();

  bool result1 = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(result1);

  // Try to initialize with different directory - should return false and log
  // warning
  bool result2 = LlamaLazyInitializeBackend::initialize("/different/path");
  EXPECT_FALSE(result2);

  // Clean up
  LlamaLazyInitializeBackend::decrementRefCount();
  LlamaLazyInitializeBackend::decrementRefCount();
}

TEST_F(LlamaLazyInitializeBackendTest, RefCountReachesZero) {
  LlamaLazyInitializeBackend::initialize("");

  EXPECT_NO_THROW({
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
  });

  bool canReinitialize = LlamaLazyInitializeBackend::initialize("");
  EXPECT_TRUE(canReinitialize);
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleSelfAssignment) {
  std::string backendsDir = getTestBackendsDir();

  {
    LlamaBackendsHandle handle(backendsDir);
    EXPECT_NO_THROW({ handle = std::move(handle); });
  }
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleNonOwning) {
  std::string backendsDir = getTestBackendsDir();
  EXPECT_NO_THROW({
    LlamaBackendsHandle handle1(backendsDir);
    LlamaBackendsHandle handle2(std::move(handle1));
  });
}

TEST_F(LlamaLazyInitializeBackendTest, DecrementRefCountWhenNotInitialized) {
  // Decrement when not initialized should not crash
  EXPECT_NO_THROW({
    LlamaLazyInitializeBackend::decrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
  });
}
