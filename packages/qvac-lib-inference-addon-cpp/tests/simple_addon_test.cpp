#include <any>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp"
#include "qvac-lib-inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp"

namespace qvac_lib_inference_addon_cpp {

// Test model that blocks in process() until unblocked
class BlockingTestModel : public model::IModel, public model::IModelCancel {
public:
  BlockingTestModel()
      : blocked_(false), cancelled_(false), cancelCalled_(false) {}

  std::string getName() const override { return "BlockingTestModel"; }
  RuntimeStats runtimeStats() const override { return {}; }

  std::any process(const std::any& input) override {
    auto inputStr = std::any_cast<std::string>(input);
    std::cout << "[BlockingTestModel] process called with input: " << inputStr
              << std::endl;
    std::unique_lock<std::mutex> lock(mutex_);

    // Only block for the first job ("blocking")
    if (inputStr == "blocking") {
      blocked_ = true;
      cv_.notify_one(); // Notify that we're blocked
      std::cout << "[BlockingTestModel] Waiting to be unblocked..."
                << std::endl;

      constexpr auto timeout = std::chrono::seconds(3);
      bool result = cv_.wait_for(
          lock, timeout, [this] { return !blocked_ || cancelled_; });
      if (!result) {
        // Test should fail
        std::cout << "[BlockingTestModel] Timeout waiting to be unblocked!"
                  << std::endl;
        throw std::runtime_error(
            "Timeout: BlockingTestModel wait exceeded 15 seconds");
      }

      if (cancelled_) {
        std::cout << "[BlockingTestModel] Throwing job cancelled" << std::endl;
        throw std::runtime_error("Job cancelled");
      }

      blocked_ = false;
      std::cout << "[BlockingTestModel] Unblocked, returning: " << inputStr
                << std::endl;
    } else {
      // For other jobs, process immediately
      std::cout << "[BlockingTestModel] Processing non-blocking job: "
                << inputStr << std::endl;
    }
    return inputStr; // Return same string as input
  }

  // Unblock the process method
  void unblock() {
    std::lock_guard<std::mutex> lock(mutex_);
    blocked_ = false;
    cv_.notify_one();
  }

  // Wait until process is blocked
  void waitUntilBlocked() {
    std::unique_lock<std::mutex> lock(mutex_);
    constexpr auto timeout = std::chrono::seconds(5);
    bool wasBlocked =
        cv_.wait_for(lock, timeout, [this] { return blocked_.load(); });
    if (!wasBlocked) {
      throw std::runtime_error(
          "Timeout: BlockingTestModel did not become blocked in time");
    }
  }

  // IModelCancel implementation
  void cancel() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    cancelled_ = true;
    cancelCalled_ = true;
    cv_.notify_one();
  }

  bool wasCancelCalled() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return cancelCalled_;
  }

private:
  mutable std::mutex mutex_;
  mutable std::condition_variable cv_;
  mutable std::atomic<bool> blocked_;
  mutable std::atomic<bool> cancelled_;
  mutable std::atomic<bool> cancelCalled_;
};

// Helper to capture std::cout output
class CoutCapture {
  std::streambuf* original_;
  std::ostringstream buffer_;

public:
  CoutCapture() : original_(std::cout.rdbuf()) {
    std::cout.rdbuf(buffer_.rdbuf());
  }

  ~CoutCapture() { std::cout.rdbuf(original_); }

  std::string getOutput() const { return buffer_.str(); }

  // Wait for output containing the expected string
  bool waitForOutput(
      const std::string& expected, std::chrono::milliseconds timeout) {
    auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
      if (buffer_.str().find(expected) != std::string::npos) {
        return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return false;
  }
};

// Helper function to create handler and addon for tests
std::pair<
    std::shared_ptr<
        out_handl::CppContainerOutputHandler<std::set<std::string>>>,
    std::unique_ptr<AddonCpp>>
createTestAddon() {
  auto handler = std::make_shared<
      out_handl::CppContainerOutputHandler<std::set<std::string>>>();

  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outputHandlers;
  outputHandlers.add(handler);
  auto outputCallback =
      std::make_unique<OutputCallBackCpp>(std::move(outputHandlers));

  auto addon = std::make_unique<AddonCpp>(
      std::move(outputCallback), std::make_unique<BlockingTestModel>());

  return {handler, std::move(addon)};
}

// Helper function to wait for output to arrive in handler
template <typename HandlerT>
inline void
waitForOutput(const std::shared_ptr<HandlerT>& handler, size_t count = 1) {
  constexpr auto timeout = std::chrono::milliseconds(2000);
  bool received = handler->waitForItems(count, timeout);
  EXPECT_TRUE(received) << "Output was not received within timeout";
}

TEST(SimpleAddonTest, CannotQueueJobWhileOneIsProcessing) {
  auto [handler, addon] = createTestAddon();
  addon->activate();

  // Set first job that will block
  addon->runJob(std::any(std::string("blocking")));

  // Get the model to wait until it's blocked
  auto* model = dynamic_cast<BlockingTestModel*>(&addon->model.get());
  ASSERT_NE(model, nullptr);
  model->waitUntilBlocked();

  // Try to set additional jobs - should fail since only one job is supported
  // These should produce exceptions
  addon->runJob(std::any(std::string("job2")));
  addon->runJob(std::any(std::string("job3")));
  addon->runJob(std::any(std::string("job4")));

  // Unblock the first job so processing can continue
  model->unblock();

  // Wait for output to arrive
  waitForOutput(handler);

  // Verify that only the first job was processed
  {
    auto access = handler->access();
    EXPECT_EQ(access->size(), 1);
    EXPECT_NE(access->find("blocking"), access->end());
    // Other jobs should not be processed (exceptions were queued)
    EXPECT_EQ(access->find("job2"), access->end());
    EXPECT_EQ(access->find("job3"), access->end());
    EXPECT_EQ(access->find("job4"), access->end());
  }

  // Verify cancel was not called during normal operation
  EXPECT_FALSE(model->wasCancelCalled());
}

TEST(SimpleAddonTest, JobCancellationWorks) {
  CoutCapture capture;
  auto [handler, addon] = createTestAddon();
  addon->activate();

  // Start a job that will block
  addon->runJob(std::any(std::string("blocking")));

  // Get the model to wait until it's blocked
  auto* model = dynamic_cast<BlockingTestModel*>(&addon->model.get());
  ASSERT_NE(model, nullptr);
  model->waitUntilBlocked();

  addon->cancelJob();
  ASSERT_EQ(model->wasCancelCalled(), true);

  model->unblock();

  // Wait for the cancellation error to be logged by default
  // CppErrorOutputHandler
  bool errorLogged =
      capture.waitForOutput("Job cancelled", std::chrono::milliseconds(2000));
  ASSERT_TRUE(errorLogged)
      << "Expected 'Job cancelled' error was not logged. Output: "
      << capture.getOutput();

  // Verify no string output was received (job was cancelled before producing
  // output)
  {
    auto access = handler->access();
    EXPECT_EQ(access->size(), 0);
  }
}

} // namespace qvac_lib_inference_addon_cpp
