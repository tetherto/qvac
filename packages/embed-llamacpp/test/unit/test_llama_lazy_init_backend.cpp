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

  /**
   * Helper to free the backend by ensuring refCount reaches zero.
   * This is used by tests that need a clean state.
   * Note: This assumes no active LlamaBackendsHandle instances are holding
   * references.
   *
   * IMPORTANT: initialize() does NOT increment refCount. Only
   * LlamaBackendsHandle increments refCount. The backend is only freed when
   * refCount reaches 0 AND initialized is true. So if refCount is already 0, we
   * need to increment then decrement to actually free it.
   */
  void ensureBackendFreed() {
    // First, try to free by decrementing any existing refCount
    for (int i = 0; i < 10; ++i) {
      LlamaLazyInitializeBackend::decrementRefCount();
    }

    // Ensure backend is initialized (if it wasn't, initialize it)
    // This doesn't change refCount, just sets initialized = true
    LlamaLazyInitializeBackend::initialize("");

    // Now backend is initialized with refCount = 0 (or was already initialized)
    // To free it, we need refCount > 0, then decrement to 0
    // So increment then decrement
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
    // Backend should now be freed (initialized = false, refCount = 0)
  }
};

TEST_F(LlamaLazyInitializeBackendTest, InitializeWithEmptyDir) {
  // Ensure clean state for this test
  ensureBackendFreed();

  bool result1 = LlamaLazyInitializeBackend::initialize("");
  EXPECT_TRUE(result1) << "First initialization should succeed";

  bool result2 = LlamaLazyInitializeBackend::initialize("");
  EXPECT_FALSE(result2)
      << "Second initialization should fail (already initialized)";
}

TEST_F(LlamaLazyInitializeBackendTest, InitializeWithBackendsDir) {
  std::string backendsDir = getTestBackendsDir();
  // Ensure clean state for this test
  ensureBackendFreed();

  // After ensuring backend is freed, initialization should succeed
  bool result = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(result)
      << "Initialization with backends directory should succeed after reset";

  // Verify idempotency - second call should return false
  bool result2 = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_FALSE(result2)
      << "Second initialization should fail (already initialized)";
}

TEST_F(LlamaLazyInitializeBackendTest, InitializeIdempotency) {
  std::string backendsDir = getTestBackendsDir();
  // Ensure clean state for this test
  ensureBackendFreed();

  // Test that multiple calls to initialize() are idempotent
  bool result1 = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(result1) << "First initialization should succeed";

  // Second call should return false (already initialized)
  bool result2 = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_FALSE(result2) << "Second initialization should fail (idempotency)";

  // Third call should also return false
  bool result3 = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_FALSE(result3)
      << "Third initialization should also fail (idempotency)";
}

TEST_F(LlamaLazyInitializeBackendTest, RefCountOperations) {
  // Ensure clean state for this test
  ensureBackendFreed();

  // Initialize backend - NOTE: initialize() does NOT increment refCount
  // Only LlamaBackendsHandle increments refCount
  bool initResult = LlamaLazyInitializeBackend::initialize("");
  EXPECT_TRUE(initResult) << "Initialization should succeed after reset";

  // Verify ref count operations don't throw
  // We manually increment refCount to test the refCount mechanism
  EXPECT_NO_THROW({
    // Increment refCount to 2
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::incrementRefCount();

    // Decrement back to 0 (2 decrements for the 2 increments)
    LlamaLazyInitializeBackend::decrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();

    // Now refCount should be 0, but backend is still initialized
    // We need one more increment then decrement to actually free it
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::decrementRefCount();
  });

  // After decrementing refCount to zero, backend should be freed
  // Attempting to initialize again should succeed
  bool canReinitialize = LlamaLazyInitializeBackend::initialize("");
  EXPECT_TRUE(canReinitialize) << "Backend should be freed when refCount "
                                  "reaches zero, allowing reinitialization";
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleConstruction) {
  std::string backendsDir = getTestBackendsDir();
  // Ensure clean state for this test
  ensureBackendFreed();

  // Verify handle construction initializes backend and increments ref count
  {
    LlamaBackendsHandle handle(backendsDir);
    // After handle construction, backend should be initialized
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should already be initialized by handle";
  }
  // Handle is destroyed here, which should decrement refCount to 0
  // Since refCount reaches zero, backend should be freed

  // Verify backend was freed by attempting to reinitialize
  bool canReinitialize = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(canReinitialize) << "Backend should be freed when handle is "
                                  "destroyed and refCount reaches zero";
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleMoveConstruction) {
  std::string backendsDir = getTestBackendsDir();
  // Ensure clean state for this test
  ensureBackendFreed();

  {
    LlamaBackendsHandle handle1(backendsDir);
    // Move construct handle2 from handle1
    // handle1 should no longer own (ownsHandle = false)
    // handle2 should own (ownsHandle = true)
    // refCount should still be 1 (not decremented)
    LlamaBackendsHandle handle2(std::move(handle1));

    // Backend should still be initialized
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should still be initialized after move construction";
  }
  // handle2 is destroyed here, which should decrement refCount to 0
  // Backend should be freed

  // Verify backend was freed
  bool canReinitialize = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(canReinitialize)
      << "Backend should be freed when moved handle is destroyed";
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleMoveAssignment) {
  std::string backendsDir = getTestBackendsDir();
  // Ensure clean state for this test
  ensureBackendFreed();

  {
    LlamaBackendsHandle handle1(backendsDir);
    LlamaBackendsHandle handle2("");
    // Move assign handle1 to handle2
    // handle1 should no longer own (ownsHandle = false)
    // handle2 should own (ownsHandle = true)
    // handle2's previous ownership should decrement refCount, but handle1's
    // ownership transfers Net result: refCount should still be 1
    handle2 = std::move(handle1);

    // Backend should still be initialized
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should still be initialized after move assignment";
  }
  // handle2 is destroyed here, which should decrement refCount to 0
  // Backend should be freed

  // Verify backend was freed
  bool canReinitialize = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(canReinitialize)
      << "Backend should be freed when moved handle is destroyed";
}

TEST_F(LlamaLazyInitializeBackendTest, MultipleBackendsHandles) {
  std::string backendsDir = getTestBackendsDir();
  // Ensure clean state for this test
  ensureBackendFreed();

  // Verify multiple handles can be created and all share the same backend
  {
    LlamaBackendsHandle handle1(backendsDir);
    LlamaBackendsHandle handle2(backendsDir);
    LlamaBackendsHandle handle3(backendsDir);
    // All handles should share the same initialized backend
    // refCount should be 3 (one for each handle)
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should already be initialized by first handle";
  }
  // All handles are destroyed here, which should decrement refCount to 0
  // Backend should be freed

  // Verify backend was freed
  bool canReinitialize = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(canReinitialize) << "Backend should be freed when all handles "
                                  "are destroyed and refCount reaches zero";
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleEmptyDir) {
  // Ensure clean state for this test
  ensureBackendFreed();

  // Verify handle can be constructed with empty directory (uses default backend
  // loading)
  {
    LlamaBackendsHandle handle("");
    // Backend should be initialized even with empty dir
    bool alreadyInitialized = LlamaLazyInitializeBackend::initialize("");
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should already be initialized by handle";
  }
  // Handle is destroyed here, which should decrement refCount to 0
  // Backend should be freed

  // Verify backend was freed
  bool canReinitialize = LlamaLazyInitializeBackend::initialize("");
  EXPECT_TRUE(canReinitialize) << "Backend should be freed when handle is "
                                  "destroyed and refCount reaches zero";
}

TEST_F(LlamaLazyInitializeBackendTest, BackendDirectoryTracking) {
  std::string backendsDir = getTestBackendsDir();
  // Ensure clean state for this test
  ensureBackendFreed();

  bool result1 = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(result1) << "First initialization should succeed";

  // Attempting to initialize with a different path should fail
  // (backend is already initialized with a different directory)
  bool result2 = LlamaLazyInitializeBackend::initialize("/different/path");
  EXPECT_FALSE(result2) << "Initialization with different path should fail "
                           "when backend is already initialized";
}

TEST_F(LlamaLazyInitializeBackendTest, RefCountReachesZero) {
  // Ensure clean state for this test
  ensureBackendFreed();

  // Initialize backend - NOTE: initialize() does NOT increment refCount
  bool initResult = LlamaLazyInitializeBackend::initialize("");
  EXPECT_TRUE(initResult) << "Initialization should succeed after reset";

  // Test that backend is freed when refCount reaches zero
  EXPECT_NO_THROW({
    // Increment refCount to 2
    LlamaLazyInitializeBackend::incrementRefCount();
    LlamaLazyInitializeBackend::incrementRefCount();

    // Decrement once - refCount is now 1, backend still initialized
    LlamaLazyInitializeBackend::decrementRefCount();

    // Verify backend is still initialized (refCount = 1, initialized = true)
    bool stillInitialized = !LlamaLazyInitializeBackend::initialize("");
    EXPECT_TRUE(stillInitialized)
        << "Backend should still be initialized when refCount > 0";

    // Decrement to 0 - this should free the backend immediately
    // When refCount reaches 0 AND initialized is true, decrementRefCount()
    // frees the backend
    LlamaLazyInitializeBackend::decrementRefCount();
  });

  // After refCount reaches zero, backend should be freed immediately
  // Verify by attempting to reinitialize
  bool canReinitialize = LlamaLazyInitializeBackend::initialize("");
  EXPECT_TRUE(canReinitialize)
      << "Backend should be freed immediately when refCount reaches zero";
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleSelfAssignment) {
  std::string backendsDir = getTestBackendsDir();
  // Ensure clean state for this test
  ensureBackendFreed();

  {
    LlamaBackendsHandle handle(backendsDir);
    // Self-assignment should be safe (no-op due to self-check in operator=)
    // refCount should remain 1, backend should still be initialized
    handle = std::move(handle);

    // Verify backend is still initialized
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized)
        << "Backend should still be initialized after self-assignment";
  }
  // Handle is destroyed, refCount goes to 0, backend should be freed

  // Verify backend was freed
  bool canReinitialize = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(canReinitialize) << "Backend should be freed when handle is "
                                  "destroyed after self-assignment";
}

TEST_F(LlamaLazyInitializeBackendTest, BackendsHandleNonOwning) {
  std::string backendsDir = getTestBackendsDir();
  // Ensure clean state for this test
  ensureBackendFreed();

  {
    LlamaBackendsHandle handle1(backendsDir);
    // Move construct handle2 from handle1
    // handle1 becomes non-owning (ownsHandle = false)
    // handle2 becomes owning (ownsHandle = true)
    // refCount should remain 1 (not decremented)
    LlamaBackendsHandle handle2(std::move(handle1));

    // Verify backend is still initialized
    bool alreadyInitialized =
        LlamaLazyInitializeBackend::initialize(backendsDir);
    EXPECT_FALSE(alreadyInitialized) << "Backend should still be initialized "
                                        "after move to non-owning handle";
  }
  // handle2 is destroyed, refCount goes to 0, backend should be freed
  // handle1 (non-owning) destruction does nothing

  // Verify backend was freed
  bool canReinitialize = LlamaLazyInitializeBackend::initialize(backendsDir);
  EXPECT_TRUE(canReinitialize)
      << "Backend should be freed when owning handle is destroyed";
}
