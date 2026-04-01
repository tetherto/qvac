#include <any>
#include <chrono>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp"
#include "qvac-lib-inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp"

namespace qvac_lib_inference_addon_cpp {

// Mock model for batch processing
class BatchTestModel : public model::IModel {
public:
  std::string getName() const override { return "BatchTestModel"; }
  RuntimeStats runtimeStats() const override { return {}; }

  std::any process(const std::any& input) override {
    auto batch = std::any_cast<std::vector<std::string>>(input);
    std::string result;
    for (size_t i = 0; i < batch.size(); ++i) {
      result += batch[i];
      if (i < batch.size() - 1) {
        result += ",";
      }
    }
    return result;
  }
};

// Helper function to create handler and addon for batch tests
std::pair<
    std::shared_ptr<
        out_handl::CppContainerOutputHandler<std::set<std::string>>>,
    std::unique_ptr<AddonCpp>>
createBatchTestAddon() {
  auto handler = std::make_shared<
      out_handl::CppContainerOutputHandler<std::set<std::string>>>();

  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outputHandlers;
  outputHandlers.add(handler);
  auto outputCallback =
      std::make_unique<OutputCallBackCpp>(std::move(outputHandlers));

  auto addon = std::make_unique<AddonCpp>(
      std::move(outputCallback), std::make_unique<BatchTestModel>());

  return {handler, std::move(addon)};
}

// Helper function to check if an item is present in any of the processed
// batches. Uses string find to check for the item in comma-separated batch
// strings.
bool isItemInBatches(
    const std::set<std::string>& batches, const std::string& item) {
  for (const auto& batch : batches) {
    size_t pos = batch.find(item);
    if (pos != std::string::npos) {
      size_t afterItem = pos + item.length();
      bool atEnd = (afterItem == batch.length());
      bool followedByComma =
          (afterItem < batch.length() && batch[afterItem] == ',');
      return atEnd || followedByComma;
    }
  }
  return false;
}

template <typename HandlerT>
inline void
waitForOutput(const std::shared_ptr<HandlerT>& handler, size_t count) {
  constexpr auto timeout = std::chrono::milliseconds(2000);
  bool received = handler->waitForItems(count, timeout);
  EXPECT_TRUE(received) << "Output was not received within timeout";
}

template <typename HandlerT>
void assertItemsInBatches(
    const std::shared_ptr<HandlerT>& handler,
    const std::vector<std::string>& items) {
  auto access = handler->access();
  for (const auto& item : items) {
    ASSERT_TRUE(isItemInBatches(*access, item))
        << "Item " << item << " was not found in any batch";
  }
}

TEST(BatchedAddonTest, BatchHandlerProcessesSingleBatch) {
  auto [handler, addon] = createBatchTestAddon();
  addon->activate();

  // Set a complete batch as a single job
  addon->runJob(std::any(std::vector<std::string>{"item1", "item2", "item3"}));

  waitForOutput(handler, 1);

  // Verify that the batch was processed
  EXPECT_EQ(handler->size(), 1);
  assertItemsInBatches(handler, {"item1", "item2", "item3"});
}

TEST(BatchedAddonTest, BatchHandlerProcessesExactBatches) {
  auto [handler, addon] = createBatchTestAddon();
  addon->activate();

  // Process batches sequentially
  addon->runJob(std::any(std::vector<std::string>{"item1", "item2"}));
  waitForOutput(handler, 1);

  addon->runJob(std::any(std::vector<std::string>{"item3", "item4"}));
  waitForOutput(handler, 2);

  addon->runJob(std::any(std::vector<std::string>{"item5", "item6"}));
  waitForOutput(handler, 3);

  EXPECT_EQ(handler->size(), 3);
  assertItemsInBatches(
      handler, {"item1", "item2", "item3", "item4", "item5", "item6"});
}

TEST(BatchedAddonTest, BatchHandlerProcessesExactBatchesNoAppend) {
  auto [handler, addon] = createBatchTestAddon();
  addon->activate();

  // Process batches sequentially
  addon->runJob(std::any(std::vector<std::string>{"item1", "item2"}));
  waitForOutput(handler, 1);

  addon->runJob(std::any(std::vector<std::string>{"item3"}));
  waitForOutput(handler, 2);

  addon->runJob(std::any(std::vector<std::string>{"item4", "item5"}));
  waitForOutput(handler, 3);

  auto access = handler->access();
  EXPECT_EQ(access->size(), 3);
  EXPECT_NE(access->find("item1,item2"), access->end());
  EXPECT_NE(access->find("item3"), access->end());
  EXPECT_NE(access->find("item4,item5"), access->end());
}

TEST(BatchedAddonTest, BatchHandlerWithLargeBatchSize) {
  auto [handler, addon] = createBatchTestAddon();
  addon->activate();

  // Set a complete batch with all items
  std::vector<std::string> items;
  for (int i = 1; i <= 5; ++i) {
    items.push_back(std::string("item") + std::to_string(i));
  }
  addon->runJob(std::any(items));

  waitForOutput(handler, 1);

  // Verify that the batch was processed
  EXPECT_EQ(handler->size(), 1) << "Expected single batch output";

  assertItemsInBatches(handler, {"item1", "item2", "item3", "item4", "item5"});
}

} // namespace qvac_lib_inference_addon_cpp
