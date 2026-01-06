/* Batch Translation Validation Tests
 *
 * These tests verify the batch translation API contract without requiring
 * actual Bergamot models. Here, focus is on error handling and proper struct
 * initialization.
 *
 */

#include <gtest/gtest.h>

#include "model-interface/bergamot.hpp"

class BergamotBatchTest : public ::testing::Test {
protected:
  std::vector<std::string> createTestInput(size_t count) {
    std::vector<std::string> inputs;
    for (size_t i = 0; i < count; ++i) {
      inputs.emplace_back("Test Sentence " + std::to_string(i));
    }
    return inputs;
  }
};

// NULL BERGAMOT CTX CHECK
TEST_F(BergamotBatchTest, BatchTranslateWithNullContext) {
  auto texts = createTestInput(3);
  auto result = bergamot_translate_batch(nullptr, texts); // Flag Error

  EXPECT_FALSE(result.error.empty());
  EXPECT_EQ(result.error, "invalid context");

  // Proper Initialization
  EXPECT_EQ(result.translations.size(), texts.size());
  EXPECT_EQ(result.success.size(), texts.size());

  // No Success for any input
  for (size_t i = 0; i < result.success.size(); i++) {
    EXPECT_FALSE(result.success[i]);
  }
}

// EMPTY INPUT CHECK
TEST_F(BergamotBatchTest, BatchTranslateEmptyInput) {
  std::vector<std::string> emptyInput;
  auto result = bergamot_translate_batch(nullptr, emptyInput);

  EXPECT_TRUE(result.translations.empty());
  EXPECT_TRUE(result.success.empty());
}

// DEFAULT BATCH API OUTPUT STRUCT CHECK
TEST_F(BergamotBatchTest, BatchResultStructDefault) {
  bergamot_batch_result result;
  // translation texts, success and error flag all should be empty
  EXPECT_TRUE(result.translations.empty());
  EXPECT_TRUE(result.success.empty());
  EXPECT_TRUE(result.error.empty());
}

// Single Translate Check with BATCH-BERGAMOT
TEST_F(BergamotBatchTest, BatchTranslateSingleText) {
  auto text = createTestInput(1);
  auto result = bergamot_translate_batch(nullptr, text);
  // Should handle single text batch
  EXPECT_EQ(result.translations.size(), 1);
  EXPECT_EQ(result.success.size(), 1);
  EXPECT_FALSE(result.success[0]); // Null context
  EXPECT_FALSE(result.error.empty());
}

// Five texts Translate CHECK with BATCH-BERGAMOT API
TEST_F(BergamotBatchTest, BatchTranslateFiveText) {
  auto texts = createTestInput(5);
  auto result = bergamot_translate_batch(nullptr, texts);
  // Should handle five text as batch
  EXPECT_EQ(result.translations.size(), 5);
  EXPECT_EQ(result.success.size(), 5);
  for (size_t i = 0; i < 5; ++i) {
    EXPECT_FALSE(result.success[i]); // Null context
  }
  EXPECT_FALSE(result.error.empty());
}

// Ten texts Translate CHECK with BATCH-BERGAMOT API
TEST_F(BergamotBatchTest, BatchTranslateTenText) {
  auto texts = createTestInput(10);
  auto result = bergamot_translate_batch(nullptr, texts);
  // Should handle five text as batch
  EXPECT_EQ(result.translations.size(), 10);
  EXPECT_EQ(result.success.size(), 10);
  for (size_t i = 0; i < 10; ++i) {
    EXPECT_FALSE(result.success[i]); // Null context
  }
  EXPECT_FALSE(result.error.empty());
}

// Check Mixed Input as BATCH with BATCH-BERGAMOT API
TEST_F(BergamotBatchTest, BatchTranslateMixedEmptyInputs) {
  std::vector<std::string> texts{"hello", "", "world", ""};
  auto result = bergamot_translate_batch(nullptr, texts);

  // Should handle mix of empty and non-empty strings
  EXPECT_EQ(result.translations.size(), 4);
  EXPECT_EQ(result.success.size(), 4);

  // All should fail due to null context
  for (size_t i = 0; i < 4; i++) {
    EXPECT_FALSE(result.success[i]);
  }
}
