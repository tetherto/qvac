#include <filesystem>
#include <string>

#include <gtest/gtest.h>

#include "model-interface/NmtLazyInitializeBackend.hpp"

namespace fs = std::filesystem;

class NmtLazyInitializeBackendTest : public ::testing::Test {
protected:
  std::string getTestBackendsDir() {
#ifdef TEST_BINARY_DIR
    return std::string(TEST_BINARY_DIR);
#else
    return (fs::current_path() / "build" / "addon" / "tests").string();
#endif
  }

  void TearDown() override {
    // Ensure the singleton is reset between tests. We increment once so
    // g_refCount is at least 1, then drain with enough decrements to
    // guarantee the count reaches zero and g_initialized is cleared.
    // incrementRefCount / decrementRefCount are no-ops when not initialized,
    // and decrementRefCount resets state when the count reaches zero.
    NmtLazyInitializeBackend::incrementRefCount();
    for (int i = 0; i < 17; ++i) {
      NmtLazyInitializeBackend::decrementRefCount();
    }
  }
};

TEST_F(
    NmtLazyInitializeBackendTest, InitializeOnceReturnsTrueSecondReturnsFalse) {
  bool result1 = NmtLazyInitializeBackend::initialize("");
  EXPECT_TRUE(result1);

  bool result2 = NmtLazyInitializeBackend::initialize("");
  EXPECT_FALSE(result2);
}

TEST_F(NmtLazyInitializeBackendTest, InitializeWithBackendsDirDoesNotThrow) {
  std::string backendsDir = getTestBackendsDir();
  EXPECT_NO_THROW({
    bool result = NmtLazyInitializeBackend::initialize(backendsDir);
    (void)result;
  });
}

TEST_F(
    NmtLazyInitializeBackendTest,
    InitializeIdempotencyReturnsFalseOnSecondCall) {
  std::string backendsDir = getTestBackendsDir();

  bool result1 = NmtLazyInitializeBackend::initialize(backendsDir);
  bool result2 = NmtLazyInitializeBackend::initialize(backendsDir);
  EXPECT_FALSE(result2);
}

TEST_F(NmtLazyInitializeBackendTest, RefCountIncrementAndDecrementDoNotThrow) {
  NmtLazyInitializeBackend::initialize("");

  EXPECT_NO_THROW({
    NmtLazyInitializeBackend::incrementRefCount();
    NmtLazyInitializeBackend::incrementRefCount();
    NmtLazyInitializeBackend::decrementRefCount();
    NmtLazyInitializeBackend::decrementRefCount();
    NmtLazyInitializeBackend::decrementRefCount();
    NmtLazyInitializeBackend::decrementRefCount();
  });
}

TEST_F(
    NmtLazyInitializeBackendTest, RefCountReachingZeroResetsInitializedState) {
  NmtLazyInitializeBackend::initialize("");

  NmtLazyInitializeBackend::incrementRefCount();
  NmtLazyInitializeBackend::incrementRefCount();
  NmtLazyInitializeBackend::decrementRefCount();
  NmtLazyInitializeBackend::decrementRefCount();
  NmtLazyInitializeBackend::decrementRefCount();
  NmtLazyInitializeBackend::decrementRefCount();

  // After refcount reaches zero, g_initialized is reset: a new initialize
  // should return true again.
  bool canReinitialize = NmtLazyInitializeBackend::initialize("");
  EXPECT_TRUE(canReinitialize);
}

TEST_F(
    NmtLazyInitializeBackendTest,
    DifferentBackendsDirWarningStillReturnsFalse) {
  std::string backendsDir = getTestBackendsDir();

  bool result1 = NmtLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(result1);

  // Initialize with a different directory: should log a warning and return
  // false (already initialized).
  bool result2 = NmtLazyInitializeBackend::initialize("/different/path");
  EXPECT_FALSE(result2);

  // Clean up — decrement so the singleton resets for subsequent tests.
  NmtLazyInitializeBackend::decrementRefCount();
  NmtLazyInitializeBackend::decrementRefCount();
}

TEST_F(
    NmtLazyInitializeBackendTest,
    DecrementRefCountWhenNotInitializedDoesNotCrash) {
  EXPECT_NO_THROW({
    NmtLazyInitializeBackend::decrementRefCount();
    NmtLazyInitializeBackend::decrementRefCount();
  });
}

TEST_F(
    NmtLazyInitializeBackendTest, NmtBackendsHandleConstructionDoesNotThrow) {
  std::string backendsDir = getTestBackendsDir();
  EXPECT_NO_THROW({ NmtBackendsHandle handle(backendsDir); });
}

TEST_F(NmtLazyInitializeBackendTest, NmtBackendsHandleEmptyDirDoesNotThrow) {
  EXPECT_NO_THROW({ NmtBackendsHandle handle(""); });
}

TEST_F(NmtLazyInitializeBackendTest, NmtBackendsHandleMoveConstruction) {
  std::string backendsDir = getTestBackendsDir();

  {
    NmtBackendsHandle handle1(backendsDir);
    EXPECT_NO_THROW({ NmtBackendsHandle handle2(std::move(handle1)); });
  }
}

TEST_F(NmtLazyInitializeBackendTest, NmtBackendsHandleMoveAssignment) {
  std::string backendsDir = getTestBackendsDir();

  {
    NmtBackendsHandle handle1(backendsDir);
    NmtBackendsHandle handle2("");
    EXPECT_NO_THROW({ handle2 = std::move(handle1); });
  }
}

TEST_F(NmtLazyInitializeBackendTest, NmtBackendsHandleSelfAssignment) {
  std::string backendsDir = getTestBackendsDir();

  {
    NmtBackendsHandle handle(backendsDir);
    EXPECT_NO_THROW({ handle = std::move(handle); });
  }
}

TEST_F(NmtLazyInitializeBackendTest, MultipleNmtBackendsHandlesDoNotThrow) {
  std::string backendsDir = getTestBackendsDir();
  EXPECT_NO_THROW({
    NmtBackendsHandle handle1(backendsDir);
    NmtBackendsHandle handle2(backendsDir);
    NmtBackendsHandle handle3(backendsDir);
  });
}

TEST_F(
    NmtLazyInitializeBackendTest, NmtBackendsHandleDefaultConstructorIsNoOp) {
  // Default-constructed handle does not own the backend; destroying it should
  // not decrement the reference count or touch backend state.
  NmtLazyInitializeBackend::initialize("");
  NmtLazyInitializeBackend::incrementRefCount();

  EXPECT_NO_THROW({
    NmtBackendsHandle noopHandle;
    // noopHandle goes out of scope here without affecting refcount
  });

  // The owning refcount is still live — decrement explicitly to clean up.
  NmtLazyInitializeBackend::decrementRefCount();
  NmtLazyInitializeBackend::decrementRefCount();
}

TEST_F(NmtLazyInitializeBackendTest, NmtBackendsHandleMoveTransfersOwnership) {
  std::string backendsDir = getTestBackendsDir();
  EXPECT_NO_THROW({
    NmtBackendsHandle handle1(backendsDir);
    NmtBackendsHandle handle2(std::move(handle1));
    // handle1 no longer owns; handle2 does. Destroying handle2 decrements once.
  });
}
