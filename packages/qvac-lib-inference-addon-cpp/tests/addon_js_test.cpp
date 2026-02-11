#include <any>
#include <memory>
#include <string>

#include <gtest/gtest.h>

#include "helpers_header/js.h"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/addon/AddonJs.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputCallbackInterface.hpp"

namespace qvac_lib_inference_addon_cpp {

// Simple mock model for testing AddonJs instantiation
class MockModel : public model::IModel {
public:
  std::string getName() const override { return "MockModel"; }
  RuntimeStats runtimeStats() const override { return {}; }
  std::any process(const std::any& input) override { return input; }
};

// Mock output callback for testing
class MockOutputCallback : public OutputCallBackInterface {
  bool stopped_{false};

public:
  void initializeProcessingThread(
      std::shared_ptr<OutputQueue> /*outputQueue*/) override {}
  void notify() override {}
  void stop() override { stopped_ = true; }
};

AddonJs createTestAddonJs() {
  js_env_t env;
  auto outputCallback = std::make_unique<MockOutputCallback>();
  auto model = std::make_unique<MockModel>();
  return AddonJs(&env, std::move(outputCallback), std::move(model));
}

TEST(AddonJsTest, CanInstantiateAddonJs) {
  auto addon = createTestAddonJs();

  EXPECT_NE(addon.addonCpp, nullptr);
  EXPECT_EQ(addon.addonCpp->model.get().getName(), "MockModel");
}

TEST(AddonJsTest, AddonCppIsAccessibleViaAddonJs) {
  auto addon = createTestAddonJs();

  // Verify the shared_ptr to AddonCpp is valid and accessible
  ASSERT_NE(addon.addonCpp, nullptr);

  // The model reference should be accessible through AddonCpp
  const model::IModel& modelRef = addon.addonCpp->model.get();
  EXPECT_EQ(modelRef.getName(), "MockModel");
}

TEST(AddonJsTest, RunJobRValue) {
  auto addon = createTestAddonJs();
  std::string testInput = "test-data";
  EXPECT_NO_THROW(addon.runJob(std::any(std::move(testInput))));
}

TEST(AddonJsTest, RunJobUsesMoveSemantics) {
  auto addon = createTestAddonJs();

  // Prepare the test input and wrap it in a std::any
  std::string testInput = "test-data";
  std::any inputAny = testInput;

  // Call runJob with std::move - intentionally moving inputAny
  EXPECT_NO_THROW(addon.runJob(std::move(inputAny)));
}

TEST(AddonJsTest, CancelJobInvokesAddonCppCancelJob) {
  auto addon = createTestAddonJs();
  // No exception should be thrown
  EXPECT_NO_THROW(addon.cancelJob());
}

} // namespace qvac_lib_inference_addon_cpp
