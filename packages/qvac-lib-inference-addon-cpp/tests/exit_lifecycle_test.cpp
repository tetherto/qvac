// Tests for the two exit-time lifecycle fixes:
//   1. OutputCallBackJs uv_unrefs its async handle so it does not, by itself,
//      keep the libuv loop alive (else brittle's beforeExit never fires and the
//      process hangs ~65s before SIGSEGV during static destruction).
//   2. JsInterface stores AddonJs instances per js_env_t and registers a
//      teardown callback so the instances are deterministically destructed
//      while the env is still alive — before llama.cpp / Vulkan globals are
//      torn down by C++ static destructors.

#include <any>
#include <memory>
#include <string>

#include <gtest/gtest.h>

#include "helpers_header/js.h"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"
#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/addon/AddonJs.hpp"
#include "qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp"
#include "qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputCallbackInterface.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

namespace {

class NoopModel : public model::IModel {
public:
  std::string getName() const override { return "NoopModel"; }
  RuntimeStats runtimeStats() const override { return {}; }
  std::any process(const std::any& input) override { return input; }
};

class NoopOutputCallback : public OutputCallBackInterface {
public:
  void initializeProcessingThread(
      std::shared_ptr<OutputQueue> /*outputQueue*/) override {}
  void notify() override {}
  void stop() override {}
};

std::unique_ptr<AddonJs> makeAddon(js_env_t* env) {
  return std::make_unique<AddonJs>(
      env,
      std::make_unique<NoopOutputCallback>(),
      std::make_unique<NoopModel>());
}

class ExitLifecycleTest : public ::testing::Test {
protected:
  void SetUp() override { js_test_mocks::resetAll(); }
  void TearDown() override { js_test_mocks::resetAll(); }
};

} // namespace

// ============================================================================
// Phase 1: OutputCallBackJs::initializeProcessingThread must uv_unref the
// async handle so it doesn't keep the libuv loop alive.
// ============================================================================

TEST_F(ExitLifecycleTest, OutputCallbackUnrefsAsyncHandleAfterInit) {
  js_env_t env;
  js_value_t jsHandle;
  js_value_t outputCb;

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> handlers;
  auto callback = std::make_unique<OutputCallBackJs>(
      &env, &jsHandle, &outputCb, std::move(handlers));

  // Sanity: no handles registered before init.
  EXPECT_TRUE(js_test_mocks::refdHandles().empty());

  NoopOutputCallback dummyCb;
  NoopModel dummyModel;
  auto outputQueue = std::make_shared<OutputQueue>(dummyCb, dummyModel);

  callback->initializeProcessingThread(outputQueue);

  // After init the async handle must NOT keep the loop alive. The mock's
  // uv_async_init adds the handle to refdHandles; uv_unref removes it.
  EXPECT_TRUE(js_test_mocks::refdHandles().empty())
      << "OutputCallBackJs left a ref'd handle on the loop after "
         "initializeProcessingThread; this prevents the libuv loop from "
         "exiting and reproduces the 65s post-test hang.";

  // Destructor cleans up the handle (uv_close path).
  callback.reset();
  EXPECT_TRUE(js_test_mocks::refdHandles().empty());
}

TEST_F(ExitLifecycleTest, OutputCallbackHandleClosedOnDestruction) {
  js_env_t env;
  js_value_t jsHandle;
  js_value_t outputCb;

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> handlers;
  {
    auto callback = std::make_unique<OutputCallBackJs>(
        &env, &jsHandle, &outputCb, std::move(handlers));
    NoopOutputCallback dummyCb;
    NoopModel dummyModel;
    auto outputQueue = std::make_shared<OutputQueue>(dummyCb, dummyModel);
    callback->initializeProcessingThread(outputQueue);
  }
  EXPECT_TRUE(js_test_mocks::refdHandles().empty());
}

// ============================================================================
// Phase 2: JsInterface must store instances per env, register a teardown
// callback, and synchronously destruct all instances when the env tears down.
// ============================================================================

TEST_F(ExitLifecycleTest, CreateInstanceRegistersTeardownCallback) {
  js_env_t env;

  auto* result = JsInterface::createInstance(&env, makeAddon(&env));
  ASSERT_NE(result, nullptr);

  auto& callbacks = js_test_mocks::teardownCallbacks();
  ASSERT_EQ(callbacks.count(&env), 1u)
      << "createInstance must register exactly one teardown callback per env";
  EXPECT_EQ(callbacks[&env].size(), 1u);
  EXPECT_EQ(callbacks[&env][0].data, &env)
      << "Teardown callback data must be the env pointer so it knows which "
         "env to clean up";
}

TEST_F(ExitLifecycleTest, CreateInstanceRegistersHookOnceForMultipleInstances) {
  js_env_t env;

  JsInterface::createInstance(&env, makeAddon(&env));
  JsInterface::createInstance(&env, makeAddon(&env));
  JsInterface::createInstance(&env, makeAddon(&env));

  auto& callbacks = js_test_mocks::teardownCallbacks();
  EXPECT_EQ(callbacks[&env].size(), 1u)
      << "Hook must be registered exactly once per env regardless of how "
         "many AddonJs instances are created";
}

TEST_F(ExitLifecycleTest, EachEnvGetsItsOwnTeardownCallback) {
  js_env_t envA;
  js_env_t envB;

  JsInterface::createInstance(&envA, makeAddon(&envA));
  JsInterface::createInstance(&envB, makeAddon(&envB));

  auto& callbacks = js_test_mocks::teardownCallbacks();
  EXPECT_EQ(callbacks[&envA].size(), 1u);
  EXPECT_EQ(callbacks[&envB].size(), 1u);
  EXPECT_EQ(callbacks[&envA][0].data, &envA);
  EXPECT_EQ(callbacks[&envB][0].data, &envB);
}

TEST_F(ExitLifecycleTest, EnvTeardownDestructsAllInstancesForThatEnv) {
  js_env_t env;

  // Use a model whose destructor flips a flag so we can prove the dtor ran.
  struct DestructionTrackingModel : public model::IModel {
    bool* destructed_;
    explicit DestructionTrackingModel(bool* d) : destructed_(d) {}
    ~DestructionTrackingModel() override { *destructed_ = true; }
    std::string getName() const override { return "DestructionTrackingModel"; }
    RuntimeStats runtimeStats() const override { return {}; }
    std::any process(const std::any& input) override { return input; }
  };

  bool destructedA = false;
  bool destructedB = false;
  bool destructedC = false;

  auto makeTrackingAddon = [&](js_env_t* e, bool* flag) {
    return std::make_unique<AddonJs>(
        e,
        std::make_unique<NoopOutputCallback>(),
        std::make_unique<DestructionTrackingModel>(flag));
  };

  JsInterface::createInstance(&env, makeTrackingAddon(&env, &destructedA));
  JsInterface::createInstance(&env, makeTrackingAddon(&env, &destructedB));
  JsInterface::createInstance(&env, makeTrackingAddon(&env, &destructedC));

  EXPECT_FALSE(destructedA);
  EXPECT_FALSE(destructedB);
  EXPECT_FALSE(destructedC);

  js_test_mocks::triggerEnvTeardown(&env);

  EXPECT_TRUE(destructedA)
      << "AddonJs instance A must be destructed when the env tears down";
  EXPECT_TRUE(destructedB);
  EXPECT_TRUE(destructedC);
}

TEST_F(ExitLifecycleTest, EnvTeardownDoesNotAffectOtherEnvsInstances) {
  js_env_t envA;
  js_env_t envB;

  struct DestructionTrackingModel : public model::IModel {
    bool* destructed_;
    explicit DestructionTrackingModel(bool* d) : destructed_(d) {}
    ~DestructionTrackingModel() override { *destructed_ = true; }
    std::string getName() const override { return "DestructionTrackingModel"; }
    RuntimeStats runtimeStats() const override { return {}; }
    std::any process(const std::any& input) override { return input; }
  };

  bool destructedA = false;
  bool destructedB = false;

  JsInterface::createInstance(
      &envA,
      std::make_unique<AddonJs>(
          &envA,
          std::make_unique<NoopOutputCallback>(),
          std::make_unique<DestructionTrackingModel>(&destructedA)));
  JsInterface::createInstance(
      &envB,
      std::make_unique<AddonJs>(
          &envB,
          std::make_unique<NoopOutputCallback>(),
          std::make_unique<DestructionTrackingModel>(&destructedB)));

  js_test_mocks::triggerEnvTeardown(&envA);

  EXPECT_TRUE(destructedA);
  EXPECT_FALSE(destructedB)
      << "Tearing down envA must NOT touch instances bound to envB";

  // Clean up envB so we don't leak across tests.
  js_test_mocks::triggerEnvTeardown(&envB);
  EXPECT_TRUE(destructedB);
}

TEST_F(ExitLifecycleTest, EnvTeardownIsIdempotent) {
  js_env_t env;

  JsInterface::createInstance(&env, makeAddon(&env));

  EXPECT_NO_THROW(js_test_mocks::triggerEnvTeardown(&env));
  // Second teardown for the same env (no callbacks registered) is a no-op.
  EXPECT_NO_THROW(js_test_mocks::triggerEnvTeardown(&env));
}

} // namespace qvac_lib_inference_addon_cpp
