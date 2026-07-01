#include <any>
#include <chrono>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp"
#include "inference-addon-cpp/handlers/OutputHandler.hpp"
#include "inference-addon-cpp/job/JobId.hpp"
#include "inference-addon-cpp/queue/OutputCallbackCpp.hpp"
#include "inference-addon-cpp/queue/OutputQueue.hpp"

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
    outputQueue->queueResult(std::any(testStrings[i]));
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

// ============================================================================
// OutputQueue id-tagging contract (red without the new overloads, green after)
// ============================================================================

/// Mock callback that does nothing — used so OutputQueue can be instantiated.
class NoopOutputCallback : public OutputCallBackInterface {
public:
  void initializeProcessingThread(
      std::shared_ptr<OutputQueue> /*q*/) override {}
  void notify() override {}
  void stop() override {}
};

TEST(OutputQueueIdTest, QueueResultWithIdPreservesId) {
  /// Verifies that a result queued with a specific JobId comes back with
  /// exactly that id from clear().
  NoopOutputCallback cb;
  MockModel model;
  OutputQueue queue(cb, model);

  const JobId expectedId = 42;
  queue.queueResult(std::any(std::string("hello")), expectedId);

  const auto entries = queue.clear();
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].first, expectedId);
  EXPECT_EQ(std::any_cast<std::string>(entries[0].second), "hello");
}

TEST(OutputQueueIdTest, QueueResultNoIdUsesKNoJobId) {
  /// Backward-compat: the no-id overload must stamp kNoJobId so existing
  /// single-job callers remain unaffected (JS 5th arg becomes undefined).
  NoopOutputCallback cb;
  MockModel model;
  OutputQueue queue(cb, model);

  queue.queueResult(std::any(std::string("world")));

  const auto entries = queue.clear();
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].first, kNoJobId);
  EXPECT_EQ(std::any_cast<std::string>(entries[0].second), "world");
}

TEST(OutputQueueIdTest, QueueJobEndedWithIdPreservesId) {
  /// Verifies queueJobEnded(id) stamps the correct id on the stats entry.
  NoopOutputCallback cb;
  MockModel model;
  OutputQueue queue(cb, model);

  const JobId expectedId = 7;
  queue.queueJobEnded(expectedId);

  const auto entries = queue.clear();
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].first, expectedId);
}

TEST(OutputQueueIdTest, QueueJobEndedNoIdUsesKNoJobId) {
  /// No-id queueJobEnded() must produce kNoJobId for backward compatibility.
  NoopOutputCallback cb;
  MockModel model;
  OutputQueue queue(cb, model);

  queue.queueJobEnded();

  const auto entries = queue.clear();
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].first, kNoJobId);
}

TEST(OutputQueueIdTest, QueueExceptionWithIdPreservesId) {
  /// Verifies queueException(e, id) stamps the correct id.
  NoopOutputCallback cb;
  MockModel model;
  OutputQueue queue(cb, model);

  const JobId expectedId = 99;
  const std::runtime_error err("boom");
  queue.queueException(err, expectedId);

  const auto entries = queue.clear();
  ASSERT_EQ(entries.size(), 1u);
  EXPECT_EQ(entries[0].first, expectedId);
}

TEST(OutputQueueIdTest, MultipleJobsPreserveOrder) {
  /// Mixed tagged and untagged entries preserve insertion order.
  NoopOutputCallback cb;
  MockModel model;
  OutputQueue queue(cb, model);

  queue.queueResult(std::any(std::string("a")), 1u);
  queue.queueResult(std::any(std::string("b")));
  queue.queueResult(std::any(std::string("c")), 2u);

  const auto entries = queue.clear();
  ASSERT_EQ(entries.size(), 3u);
  EXPECT_EQ(entries[0].first, 1u);
  EXPECT_EQ(entries[1].first, kNoJobId);
  EXPECT_EQ(entries[2].first, 2u);
}

} // namespace qvac_lib_inference_addon_cpp
