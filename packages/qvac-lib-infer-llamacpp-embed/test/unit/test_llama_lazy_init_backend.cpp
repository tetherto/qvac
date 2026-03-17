#include <filesystem>
#include <string>

#include <gtest/gtest.h>

#include "model-interface/LlamaLazyInitializeBackend.hpp"

namespace fs = std::filesystem;

class LlamaLazyInitializeBackendTest : public ::testing::Test {
protected:
  std::string getTestBackendsDir() {
    fs::path backendDir;
#ifdef TEST_BINARY_DIR
    backendDir = fs::path(TEST_BINARY_DIR);
#else
    backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
    return backendDir.string();
  }
};

TEST_F(LlamaLazyInitializeBackendTest, InitializeWithEmptyDir) {
  // Backend may already be initialized by a prior test (process-global state,
  // intentionally never freed). Just verify idempotency.
  LlamaLazyInitializeBackend::initialize("");

  bool result2 = LlamaLazyInitializeBackend::initialize("");
  EXPECT_FALSE(result2)
      << "Second initialization should fail (already initialized)";
}

TEST_F(LlamaLazyInitializeBackendTest, InitializeWithBackendsDir) {
  std::string backendsDir = getTestBackendsDir();

  EXPECT_NO_THROW({
    LlamaLazyInitializeBackend::initialize(backendsDir);
  });

  // Verify idempotency - second call should return false
  bool result2 = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_FALSE(result2)
      << "Second initialization should fail (already initialized)";
}

TEST_F(LlamaLazyInitializeBackendTest, InitializeIdempotency) {
  std::string backendsDir = getTestBackendsDir();

  // First call may or may not succeed depending on prior test state
  LlamaLazyInitializeBackend::initialize(backendsDir);

  // Subsequent calls should always return false (already initialized)
  bool result2 = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_FALSE(result2) << "Second initialization should fail (idempotency)";

  bool result3 = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_FALSE(result3)
      << "Third initialization should also fail (idempotency)";
}

TEST_F(LlamaLazyInitializeBackendTest, RefCountOperations) {
  LlamaLazyInitializeBackend::initialize("");

  // Verify ref count operations don't throw
  EXPECT_NO_THROW({
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
    // Extra decrements below zero are safe (clamped to 0)
    LlamaLazyInitializeBackend::decrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
  });

  // Backend remains initialized even after refcount reaches zero.
  // Shutdown is handled at process exit from the JS layer, not on refcount 0.
  bool canReinitialize = LlamaLazyInitializeBackend::initialize("");
  EXPECT_FALSE(canReinitialize)
      << "Backend should remain initialized (shutdown only at process exit)";
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleConstruction) {
  std::string backendsDir = getTestBackendsDir();

  // Verify handle construction initializes backend and increments ref count
  {
    LlamaBackendsHandle handle(backendsDir);
    // After handle construction, backend should be initialized
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should already be initialized by handle";
  }
  // Handle destroyed — refcount decremented but backend stays initialized.
  // Shutdown only happens at process exit from the JS layer.
  bool stillInitialized =
      !LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(stillInitialized)
      << "Backend should remain initialized after handle destruction";
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleMoveConstruction) {
  std::string backendsDir = getTestBackendsDir();

  {
    LlamaBackendsHandle handle1(backendsDir);
    LlamaBackendsHandle handle2(std::move(handle1));

    // Backend should still be initialized after move
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should still be initialized after move construction";
  }
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleMoveAssignment) {
  std::string backendsDir = getTestBackendsDir();

  {
    LlamaBackendsHandle handle1(backendsDir);
    LlamaBackendsHandle handle2("");
    handle2 = std::move(handle1);

    // Backend should still be initialized after move assignment
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should still be initialized after move assignment";
  }
}

TEST_F(LlamaLazyInitializeBackendTest, MultipleBackendsHandles) {
  std::string backendsDir = getTestBackendsDir();

  // Verify multiple handles can be created and all share the same backend
  {
    LlamaBackendsHandle handle1(backendsDir);
    LlamaBackendsHandle handle2(backendsDir);
    LlamaBackendsHandle handle3(backendsDir);
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should already be initialized by first handle";
  }
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleEmptyDir) {
  // Verify handle can be constructed with empty directory (uses default backend
  // loading)
  {
    LlamaBackendsHandle handle("");
    bool alreadyInitialized = LlamaLazyInitializeBackend::initialize("");
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should already be initialized by handle";
  }
}

TEST_F(LlamaLazyInitializeBackendTest, BackendDirectoryTracking) {
  std::string backendsDir = getTestBackendsDir();

  // Ensure backend is initialized (may already be from a prior test)
  LlamaLazyInitializeBackend::initialize(backendsDir);

  // Attempting to initialize with a different path should fail
  // (backend is already initialized with a different directory)
  bool result2 = LlamaLazyInitializeBackend::initialize("/different/path");
  EXPECT_FALSE(result2) << "Initialization with different path should fail "
                           "when backend is already initialized";
}

TEST_F(LlamaLazyInitializeBackendTest, RefCountReachesZero) {
  LlamaLazyInitializeBackend::initialize("");

  EXPECT_NO_THROW({
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();

    // Backend should still be initialized
    bool stillInitialized = !LlamaLazyInitializeBackend::initialize("");
    EXPECT_TRUE(stillInitialized)
        << "Backend should still be initialized when refCount > 0";

    LlamaLazyInitializeBackend::decrementRefCount();
  });

  // Backend remains initialized even after refcount reaches zero.
  // Shutdown is handled at process exit from the JS layer, not on refcount 0.
  bool canReinitialize = LlamaLazyInitializeBackend::initialize("");
  EXPECT_FALSE(canReinitialize)
      << "Backend should remain initialized (shutdown only at process exit)";
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleSelfAssignment) {
  std::string backendsDir = getTestBackendsDir();

  {
    LlamaBackendsHandle handle(backendsDir);
    // Self-assignment should be safe (no-op due to self-check in operator=)
    handle = std::move(handle);

    // Verify backend is still initialized
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should still be initialized after self-assignment";
  }
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleNonOwning) {
  std::string backendsDir = getTestBackendsDir();

  {
    LlamaBackendsHandle handle1(backendsDir);
    // Move construct handle2 from handle1
    // handle1 becomes non-owning, handle2 becomes owning
    LlamaBackendsHandle handle2(std::move(handle1));

    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized) << "Backend should still be initialized "
                                        "after move to non-owning handle";
  }
}
