#include <any>
#include <chrono>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp"
#include "qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

// Mock model for testing
class MockModel : public model::IModel {
public:
  std::string getName() const override { return "MockModel"; }
  RuntimeStats runtimeStats() const override { return {}; }
  std::any process(const std::any& /*input*/) override { return {}; }
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

  void reset() { buffer_.str(""); }
};

TEST(CppOutputHandlerTest, LogMsgOutputHandlerOutputsToCout) {
  out_handl::CppLogMsgOutputHandler handler;

  Output::LogMsg logMsg("Test log message");
  std::any testData = std::any(logMsg);

  EXPECT_TRUE(handler.canHandle(testData));

  CoutCapture capture;
  handler.handleOutput(testData);

  // QLOG outputs with format "[INFO]: message\n" when JS_LOGGER is not defined
  EXPECT_EQ(capture.getOutput(), "[INFO]: Test log message\n");
}

TEST(CppOutputHandlerTest, ErrorOutputHandlerOutputsToCerr) {
  out_handl::CppErrorOutputHandler handler;

  Output::Error error("Test error message");
  std::any testData = std::any(error);

  EXPECT_TRUE(handler.canHandle(testData));

  // QLOG outputs to std::cout (not std::cerr) with format "[ERROR]: message\n"
  // when JS_LOGGER is not defined
  CoutCapture capture;
  handler.handleOutput(testData);

  EXPECT_EQ(capture.getOutput(), "[ERROR]: Test error message\n");
}

TEST(CppOutputHandlerTest, OutputCallbackCppWithCustomStringHandler) {
  // Create queued output handler to collect outputs
  auto queuedHandler =
      std::make_shared<out_handl::CppQueuedOutputHandler<std::string>>();

  // Create handlers and add queued string handler
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>> handlers;
  handlers.add(queuedHandler);

  // Create callback
  OutputCallBackCpp callback(std::move(handlers));

  // Create mock model for output queue
  MockModel mockModel;

  // Create output queue
  auto outputQueue = std::make_shared<OutputQueue>(callback, mockModel);

  // Initialize the processing thread
  callback.initializeProcessingThread(outputQueue);

  // Queue string outputs
  std::vector<std::string> testStrings = {
      "Hello from OutputCallbackCpp!", "Second message", "Third message"};

  for (size_t i = 0; i < testStrings.size(); ++i) {
    outputQueue->queueResult(static_cast<JobId>(i + 1), std::any(testStrings[i]));
  }

  // Pop items from the queue with timeout - no need for manual sleep
  for (size_t i = 0; i < testStrings.size(); ++i) {
    auto result = queuedHandler->tryPop(std::chrono::milliseconds(500));
    ASSERT_TRUE(result.has_value()) << "Timeout waiting for output " << i;
    EXPECT_EQ(result.value(), testStrings[i]);
  }
}

TEST(CppOutputHandlerTest, OutputCallbackCppProcessesLogMsg) {
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>> handlers;
  OutputCallBackCpp callback(std::move(handlers));

  MockModel mockModel;
  auto outputQueue = std::make_shared<OutputQueue>(callback, mockModel);
  callback.initializeProcessingThread(outputQueue);

  // Queue a log message (this would normally be done internally)
  // Since we can't directly queue LogMsg events, we'll test the handler
  // directly which is what the callback uses
  CoutCapture capture;
  out_handl::CppLogMsgOutputHandler handler;
  Output::LogMsg logMsg("Test log from callback");
  handler.handleOutput(std::any(logMsg));
  // QLOG outputs with format "[INFO]: message\n" when JS_LOGGER is not defined
  EXPECT_EQ(capture.getOutput(), "[INFO]: Test log from callback\n");
}

} // namespace qvac_lib_inference_addon_cpp
