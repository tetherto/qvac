#include <filesystem>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <llama.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/BertErrors.hpp"
#include "model-interface/BertModel.hpp"

namespace fs = std::filesystem;

class BertEmbeddingsTest : public ::testing::Test {};

TEST_F(BertEmbeddingsTest, ConstructorWithValidLayout) {
  std::vector<float> data(10 * 5);
  for (std::size_t i = 0; i < data.size(); ++i) {
    data[i] = static_cast<float>(i);
  }

  BertEmbeddings::Layout layout{10, 5};
  BertEmbeddings embeddings(std::move(data), layout);

  EXPECT_EQ(embeddings.size(), 10);
  EXPECT_EQ(embeddings.embeddingSize(), 5);
}

TEST_F(BertEmbeddingsTest, SingleEmbedding) {
  std::vector<float> data{1.0f, 2.0f, 3.0f};
  BertEmbeddings::Layout layout{1, 3};
  BertEmbeddings embeddings(std::move(data), layout);

  EXPECT_EQ(embeddings.size(), 1);
  EXPECT_EQ(embeddings.embeddingSize(), 3);

  auto embedding = embeddings[0];
  EXPECT_EQ(embedding.size(), 3);
  EXPECT_FLOAT_EQ(embedding[0], 1.0f);
  EXPECT_FLOAT_EQ(embedding[1], 2.0f);
  EXPECT_FLOAT_EQ(embedding[2], 3.0f);
}

TEST_F(BertEmbeddingsTest, MultipleEmbeddings) {
  std::vector<float> data{1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f};
  BertEmbeddings::Layout layout{2, 3};
  BertEmbeddings embeddings(std::move(data), layout);

  EXPECT_EQ(embeddings.size(), 2);
  EXPECT_EQ(embeddings.embeddingSize(), 3);

  auto embedding0 = embeddings[0];
  EXPECT_EQ(embedding0.size(), 3);
  EXPECT_FLOAT_EQ(embedding0[0], 1.0f);
  EXPECT_FLOAT_EQ(embedding0[1], 2.0f);
  EXPECT_FLOAT_EQ(embedding0[2], 3.0f);

  auto embedding1 = embeddings[1];
  EXPECT_EQ(embedding1.size(), 3);
  EXPECT_FLOAT_EQ(embedding1[0], 4.0f);
  EXPECT_FLOAT_EQ(embedding1[1], 5.0f);
  EXPECT_FLOAT_EQ(embedding1[2], 6.0f);
}

TEST_F(BertEmbeddingsTest, EmptyEmbeddings) {
  std::vector<float> data;
  BertEmbeddings::Layout layout{0, 0};
  BertEmbeddings embeddings(std::move(data), layout);

  EXPECT_EQ(embeddings.size(), 0);
  EXPECT_EQ(embeddings.embeddingSize(), 0);
}

TEST_F(BertEmbeddingsTest, AccessAllEmbeddings) {
  const std::size_t count = 5;
  const std::size_t size = 4;
  std::vector<float> data(count * size);
  for (std::size_t i = 0; i < data.size(); ++i) {
    data[i] = static_cast<float>(i);
  }

  BertEmbeddings::Layout layout{count, size};
  BertEmbeddings embeddings(std::move(data), layout);

  for (std::size_t i = 0; i < count; ++i) {
    auto embedding = embeddings[i];
    EXPECT_EQ(embedding.size(), size);
    for (std::size_t j = 0; j < size; ++j) {
      EXPECT_FLOAT_EQ(embedding[j], static_cast<float>(i * size + j));
    }
  }
}

TEST_F(BertEmbeddingsTest, LargeEmbeddings) {
  const std::size_t count = 100;
  const std::size_t size = 768;
  std::vector<float> data(count * size);
  for (std::size_t i = 0; i < data.size(); ++i) {
    data[i] = static_cast<float>(i) * 0.001f;
  }

  BertEmbeddings::Layout layout{count, size};
  BertEmbeddings embeddings(std::move(data), layout);

  EXPECT_EQ(embeddings.size(), count);
  EXPECT_EQ(embeddings.embeddingSize(), size);

  auto embedding = embeddings[50];
  EXPECT_EQ(embedding.size(), size);
  EXPECT_FLOAT_EQ(embedding[0], 50.0f * size * 0.001f);
}

class BertModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    fs::path backendDir;
#ifdef TEST_BINARY_DIR
    backendDir = fs::path(TEST_BINARY_DIR);
#else
    backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
    test_backends_dir = backendDir.string();

    // Try multiple possible locations for the model file
    std::vector<fs::path> possiblePaths = {
        // From workspace root
        fs::path{"models/unit-test/test-model.gguf"},
        // From build/test/unit (go up 3 levels)
        fs::path{"../../../models/unit-test/test-model.gguf"},
        // Absolute path from backendDir location
        backendDir.parent_path().parent_path().parent_path() / "models" /
            "unit-test" / "test-model.gguf",
        // From current working directory
        fs::current_path() / "models" / "unit-test" / "test-model.gguf"};

    test_model_path = "";
    for (const auto& path : possiblePaths) {
      if (fs::exists(path)) {
        test_model_path = fs::absolute(path).string();
        break;
      }
    }

    // If still not found, use relative path as last resort
    if (test_model_path.empty()) {
      test_model_path = "models/unit-test/test-model.gguf";
    }
  }

  std::string test_backends_dir;
  std::string test_model_path;

  std::string getValidModelPath() { return test_model_path; }
  std::string getInvalidModelPath() { return "nonexistent_model.gguf"; }
};

TEST_F(BertModelTest, IsLoadedBeforeInit) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(BertModelTest, InitializeBackend) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  EXPECT_NO_THROW(model.initializeBackend(test_backends_dir));
}

TEST_F(BertModelTest, InitializeBackendWithEmptyDir) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  EXPECT_NO_THROW(model.initializeBackend(""));
}

TEST_F(BertModelTest, ResetMethod) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  EXPECT_NO_THROW(model.reset());
}

TEST_F(BertModelTest, RuntimeStatsBeforeProcessing) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  auto stats = model.runtimeStats();
  // RuntimeStats is a vector of key-value pairs
  // Before processing, it should contain model configuration stats
  EXPECT_GE(stats.size(), 0);

  // Verify stats structure - should have batch_size and context_size if model
  // is loaded
  bool hasBatchSize = false;
  bool hasContextSize = false;
  for (const auto& stat : stats) {
    if (stat.first == "batch_size") {
      hasBatchSize = true;
    }
    if (stat.first == "context_size") {
      hasContextSize = true;
    }
  }
  // These should be present if model is loaded
  EXPECT_TRUE(hasBatchSize);
  EXPECT_TRUE(hasContextSize);
}

TEST_F(BertModelTest, RuntimeStatsAfterProcessing) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  // Process some input to generate stats
  std::string prompt = "Test prompt for stats";
  model.encodeHostF32(prompt);

  auto stats = model.runtimeStats();
  EXPECT_GT(stats.size(), 0);

  // After processing, should have performance stats
  bool hasTotalTokens = false;
  bool hasTotalTime = false;
  for (const auto& stat : stats) {
    if (stat.first == "total_tokens") {
      hasTotalTokens = true;
    }
    if (stat.first == "total_time_ms") {
      hasTotalTime = true;
    }
  }
  EXPECT_TRUE(hasTotalTokens);
  EXPECT_TRUE(hasTotalTime);
}

TEST_F(BertModelTest, ConstructorWithInvalidPath) {
  std::string invalid_path = getInvalidModelPath();
  std::string config = "-dev\tcpu\n";

  EXPECT_NO_THROW({
    BertModel model(invalid_path, config);
    EXPECT_FALSE(model.isLoaded());
  });
}

TEST_F(BertModelTest, ConstructorWithEmptyConfig) {
  std::string invalid_path = getInvalidModelPath();
  std::string config = "";

  EXPECT_NO_THROW({
    BertModel model(invalid_path, config);
    EXPECT_FALSE(model.isLoaded());
  });
}

TEST_F(BertModelTest, ConstructorWithBackendsDir) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  EXPECT_NO_THROW({
    BertModel model(getValidModelPath(), config, test_backends_dir);
    EXPECT_FALSE(model.isLoaded());
  });
}

TEST_F(BertModelTest, ModelLoadsSuccessfully) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  EXPECT_TRUE(model.isLoaded());
  EXPECT_NE(model.getModel(), nullptr);
  EXPECT_NE(model.getCtx(), nullptr);
}

TEST_F(BertModelTest, ModelFailsToLoadWithInvalidPath) {
  std::string invalid_path = getInvalidModelPath();
  std::string config = "-dev\tcpu\n";

  BertModel model(invalid_path, config);
  model.initializeBackend(test_backends_dir);

  // waitForLoadInitialization() throws an exception when model file doesn't
  // exist
  using namespace qvac_lib_infer_llamacpp_embed::errors;
  EXPECT_THROW({ model.waitForLoadInitialization(); }, std::runtime_error);

  EXPECT_FALSE(model.isLoaded());
}

TEST_F(BertModelTest, EncodeHostF32SingleString) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string prompt = "Hello world";
  BertEmbeddings embeddings = model.encodeHostF32(prompt);

  EXPECT_EQ(embeddings.size(), 1);
  EXPECT_GT(embeddings.embeddingSize(), 0);
  EXPECT_EQ(embeddings[0].size(), embeddings.embeddingSize());

  // Verify embedding values are not all zeros
  bool hasNonZero = false;
  for (float val : embeddings[0]) {
    if (val != 0.0f) {
      hasNonZero = true;
      break;
    }
  }
  EXPECT_TRUE(hasNonZero);
}

TEST_F(BertModelTest, EncodeHostF32MultipleStrings) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::vector<std::string> prompts = {
      "Hello world", "Test embedding", "Another prompt"};
  BertEmbeddings embeddings = model.encodeHostF32(prompts);

  EXPECT_EQ(embeddings.size(), 3);
  EXPECT_GT(embeddings.embeddingSize(), 0);

  // Verify each embedding has correct size
  for (std::size_t i = 0; i < embeddings.size(); ++i) {
    EXPECT_EQ(embeddings[i].size(), embeddings.embeddingSize());
  }

  // Verify embeddings are different (not identical)
  if (embeddings.size() >= 2) {
    bool areDifferent = false;
    for (std::size_t j = 0; j < embeddings[0].size(); ++j) {
      if (embeddings[0][j] != embeddings[1][j]) {
        areDifferent = true;
        break;
      }
    }
    EXPECT_TRUE(areDifferent);
  }
}

TEST_F(BertModelTest, EncodeHostF32EmptyString) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string prompt = "";
  BertEmbeddings embeddings = model.encodeHostF32(prompt);

  EXPECT_EQ(embeddings.size(), 1);
  EXPECT_GT(embeddings.embeddingSize(), 0);
}

TEST_F(BertModelTest, EncodeHostF32Sequences) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::vector<std::string> sequences = {"First sequence", "Second sequence"};
  BertEmbeddings embeddings = model.encodeHostF32Sequences(sequences);

  EXPECT_EQ(embeddings.size(), 2);
  EXPECT_GT(embeddings.embeddingSize(), 0);

  for (std::size_t i = 0; i < embeddings.size(); ++i) {
    EXPECT_EQ(embeddings[i].size(), embeddings.embeddingSize());
  }
}

TEST_F(BertModelTest, EncodeHostF32SequencesEmpty) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::vector<std::string> sequences;
  BertEmbeddings embeddings = model.encodeHostF32Sequences(sequences);

  EXPECT_EQ(embeddings.size(), 0);
  EXPECT_GT(embeddings.embeddingSize(), 0);
}

TEST_F(BertModelTest, ProcessWithStringInput) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string input = "Process this text";
  BertModel::Input variantInput = input;
  BertEmbeddings embeddings = model.process(variantInput);

  EXPECT_EQ(embeddings.size(), 1);
  EXPECT_GT(embeddings.embeddingSize(), 0);
  EXPECT_EQ(embeddings[0].size(), embeddings.embeddingSize());
}

TEST_F(BertModelTest, ProcessWithVectorInput) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::vector<std::string> input = {"First", "Second", "Third"};
  BertModel::Input variantInput = input;
  BertEmbeddings embeddings = model.process(variantInput);

  EXPECT_EQ(embeddings.size(), 3);
  EXPECT_GT(embeddings.embeddingSize(), 0);

  for (std::size_t i = 0; i < embeddings.size(); ++i) {
    EXPECT_EQ(embeddings[i].size(), embeddings.embeddingSize());
  }
}

TEST_F(BertModelTest, ProcessWithCallback) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string input = "Test callback";
  BertModel::Input variantInput = input;
  bool callbackCalled = false;

  auto callback = [&callbackCalled](const BertEmbeddings& emb) {
    callbackCalled = true;
    EXPECT_EQ(emb.size(), 1);
    EXPECT_GT(emb.embeddingSize(), 0);
  };

  BertEmbeddings embeddings = model.process(variantInput, callback);
  EXPECT_TRUE(callbackCalled);
  EXPECT_EQ(embeddings.size(), 1);
}

TEST_F(BertModelTest, ContextOverflowSingleString) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  // Get model's context size
  const llama_model* llamaModel = model.getModel();
  int nCtxTrain = llama_model_n_ctx_train(llamaModel);

  // Create a string that will exceed context size when tokenized
  // "Hello world " is approximately 2-3 tokens, so repeat many times
  int repeatCount = (nCtxTrain / 2) + 100; // Ensure we exceed the limit
  std::string longString = "Hello world ";
  for (int i = 0; i < repeatCount; ++i) {
    longString += "Hello world ";
  }

  using namespace qvac_lib_infer_llamacpp_embed::errors;
  EXPECT_THROW({ model.encodeHostF32(longString); }, qvac_errors::StatusError);
}

TEST_F(BertModelTest, ContextOverflowMultipleStrings) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  const llama_model* llamaModel = model.getModel();
  int nCtxTrain = llama_model_n_ctx_train(llamaModel);

  // Create a string that will exceed context size
  int repeatCount = (nCtxTrain / 2) + 100;
  std::string longString = "Hello world ";
  for (int i = 0; i < repeatCount; ++i) {
    longString += "Hello world ";
  }

  std::vector<std::string> prompts = {
      "Normal prompt", longString, "Another normal"};

  using namespace qvac_lib_infer_llamacpp_embed::errors;
  EXPECT_THROW({ model.encodeHostF32(prompts); }, qvac_errors::StatusError);
}

TEST_F(BertModelTest, ContextOverflowSequences) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  const llama_model* llamaModel = model.getModel();
  int nCtxTrain = llama_model_n_ctx_train(llamaModel);

  // Create a string that will exceed context size
  int repeatCount = (nCtxTrain / 2) + 100;
  std::string longString = "Hello world ";
  for (int i = 0; i < repeatCount; ++i) {
    longString += "Hello world ";
  }

  std::vector<std::string> sequences = {"Normal sequence", longString};

  using namespace qvac_lib_infer_llamacpp_embed::errors;
  EXPECT_THROW(
      { model.encodeHostF32Sequences(sequences); }, qvac_errors::StatusError);
}

TEST_F(BertModelTest, ProcessWithContextOverflow) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  const llama_model* llamaModel = model.getModel();
  int nCtxTrain = llama_model_n_ctx_train(llamaModel);

  int repeatCount = (nCtxTrain / 2) + 100;
  std::string longString = "Hello world ";
  for (int i = 0; i < repeatCount; ++i) {
    longString += "Hello world ";
  }

  BertModel::Input variantInput = longString;

  using namespace qvac_lib_infer_llamacpp_embed::errors;
  EXPECT_THROW({ model.process(variantInput); }, qvac_errors::StatusError);
}

TEST_F(BertModelTest, ModelLoadsAndProcessesMultipleTimes) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  // Process multiple times to verify model state is maintained
  for (int i = 0; i < 3; ++i) {
    std::string prompt = "Test prompt " + std::to_string(i);
    BertEmbeddings embeddings = model.encodeHostF32(prompt);

    EXPECT_EQ(embeddings.size(), 1);
    EXPECT_GT(embeddings.embeddingSize(), 0);
  }
}

TEST_F(BertModelTest, PreprocessPrompt) {
  if (!fs::exists(getValidModelPath())) {
    GTEST_SKIP() << "Test model not found at: " << getValidModelPath();
  }

  std::string config = "-dev\tcpu\n";
  BertModel model(getValidModelPath(), config);
  model.initializeBackend(test_backends_dir);
  model.waitForLoadInitialization();

  if (!model.isLoaded()) {
    GTEST_SKIP() << "Model failed to load";
  }

  std::string prompt = "Line 1\nLine 2\nLine 3";
  std::vector<std::string> preprocessed = model.preprocessPrompt(prompt);

  EXPECT_GT(preprocessed.size(), 0);
  // Preprocessing should split by newlines
  EXPECT_GE(preprocessed.size(), 1);
}
