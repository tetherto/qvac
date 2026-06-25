#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

using test_common::getStatValue;

namespace fs = std::filesystem;

namespace {
constexpr uint32_t kQwen35MultimodalPrefillCells = 2899;
constexpr llama_pos kQwen35MultimodalPrefillPosMax = 90;

std::vector<uint8_t> readBinaryFile(const fs::path& path) {
  std::ifstream stream(path, std::ios::binary);
  return {
      std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

fs::path multimodalTestImagePath() {
  const fs::path packageRelative = "media/fruitPlate.png";
  if (fs::exists(packageRelative)) {
    return packageRelative;
  }

#ifdef TEST_BINARY_DIR
  const fs::path binaryRelative = fs::path(TEST_BINARY_DIR) / ".." / ".." /
                                  ".." / "media" / "fruitPlate.png";
  if (fs::exists(binaryRelative)) {
    return binaryRelative.lexically_normal();
  }
#endif

  return "packages/llm-llamacpp/media/fruitPlate.png";
}
} // namespace

class MtmdLlmContextTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";

    test_model_path = test_common::BaseTestModelPath::get(
        "SmolVLM-500M-Instruct-Q8_0.gguf", "SmolVLM-500M-Instruct.gguf");
    test_projection_path = test_common::BaseTestModelPath::get(
        "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
        "mmproj-SmolVLM-500M-Instruct.gguf");

    fs::path backendDir;
#ifdef TEST_BINARY_DIR
    backendDir = fs::path(TEST_BINARY_DIR);
#else
    backendDir = fs::current_path() / "build" / "test" / "unit";
#endif

    config_files["backendsDir"] = backendDir.string();
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;

  bool hasValidModel() {
    return fs::exists(test_model_path) && fs::exists(test_projection_path);
  }

  bool hasValidQwen35Model() {
    return fs::exists(qwen35_model_path) && fs::exists(qwen35_projection_path);
  }

  std::unique_ptr<LlamaModel> createModel() {
    if (!hasValidModel()) {
      return nullptr;
    }
    std::string modelPath = test_model_path;
    std::string projectionPath = test_projection_path;
    auto configCopy = config_files;
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPath), std::move(projectionPath), std::move(configCopy));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unique_ptr<LlamaModel> createQwen35Model() {
    if (!hasValidQwen35Model()) {
      return nullptr;
    }
    std::string modelPath = qwen35_model_path;
    std::string projectionPath = qwen35_projection_path;
    auto configCopy = config_files;
    configCopy["ctx_size"] = "4096";
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPath), std::move(projectionPath), std::move(configCopy));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::string qwen35_model_path =
      test_common::BaseTestModelPath::get("Qwen3.5-0.8B-Q8_0.gguf");
  std::string qwen35_projection_path =
      test_common::BaseTestModelPath::get("mmproj-Qwen3.5-0.8B-F16.gguf");
};

TEST_F(MtmdLlmContextTest, Constructor) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_TRUE(model->isLoaded());
}

TEST_F(MtmdLlmContextTest, ProcessWithStringInput) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello, how are you?"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ProcessWithCallback) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<std::string> generatedTokens;

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  prompt.outputCallback = [&generatedTokens](const std::string& token) {
    generatedTokens.push_back(token);
  };

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    EXPECT_GT(generatedTokens.size(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ProcessAndGetRuntimeStats) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, LoadMediaBinary) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> imageData = {0xFF, 0xD8, 0xFF, 0xE0};
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "What is this?"}])";
  prompt.media.push_back(std::move(imageData));
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, LoadMediaFile) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"type": "media", "content": "nonexistent_image.jpg"}, {"role": "user", "content": "What is this?"}])";
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, ResetState) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  EXPECT_NO_THROW(model->reset());

  LlamaModel::Prompt prompt2;
  prompt2.input = R"([{"role": "user", "content": "Another hello"}])";
  EXPECT_NO_THROW({
    std::string output2 = model->processPrompt(prompt2);
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ResetMedia) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> imageData = {0xFF, 0xD8, 0xFF, 0xE0};
  LlamaModel::Prompt mediaPrompt;
  mediaPrompt.input = R"([{"role": "user", "content": "What is this?"}])";
  mediaPrompt.media.push_back(std::move(imageData));
  EXPECT_THROW(
      { model->processPrompt(mediaPrompt); }, qvac_errors::StatusError);

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, MultimodalMessages) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "content": "What do you see in this image?"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, CacheTokensMatchesLlamaMemoryTokenCount) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  const fs::path imagePath = multimodalTestImagePath();
  if (!fs::exists(imagePath)) {
    FAIL() << "Multimodal test image not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "type": "media", "content": ""},)"
      R"( {"role": "user", "content": "Describe this image briefly."}])";
  prompt.media.push_back(readBinaryFile(imagePath));

  std::string output = model->processPrompt(prompt);
  EXPECT_GE(output.length(), 0);

  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);

  const auto expectedCacheTokens =
      static_cast<double>(llama_memory_seq_token_count(mem, 0));
  const auto stats = model->runtimeStats();

  EXPECT_EQ(getStatValue(stats, "CacheTokens"), expectedCacheTokens);
}

TEST_F(MtmdLlmContextTest, Qwen35MultimodalReportsMemoryTokenCountAndPosMax) {
  if (!hasValidQwen35Model()) {
    FAIL() << "Qwen3.5 multimodal model or projection file not found";
  }

  const fs::path imagePath = multimodalTestImagePath();
  if (!fs::exists(imagePath)) {
    FAIL() << "Multimodal test image not found";
  }

  auto model = createQwen35Model();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "type": "media", "content": ""},)"
      R"( {"role": "user", "content": "Describe this image in one sentence."}])";
  prompt.prefill = true;
  prompt.media.push_back(readBinaryFile(imagePath));

  std::string output = model->processPrompt(prompt);
  EXPECT_TRUE(output.empty());

  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);

  const uint32_t sequenceCells = llama_memory_seq_token_count(mem, 0);
  const uint32_t totalCells = llama_memory_seq_token_count(mem, -1);
  const llama_pos posMax = llama_memory_seq_pos_max(mem, 0);
  SCOPED_TRACE(
      "sequenceCells=" + std::to_string(sequenceCells) +
      ", totalCells=" + std::to_string(totalCells) +
      ", posMax=" + std::to_string(posMax));

  EXPECT_EQ(sequenceCells, kQwen35MultimodalPrefillCells);
  EXPECT_EQ(totalCells, kQwen35MultimodalPrefillCells);
  EXPECT_EQ(posMax, kQwen35MultimodalPrefillPosMax);

  const auto stats = model->runtimeStats();
  EXPECT_EQ(
      getStatValue(stats, "CacheTokens"), static_cast<double>(sequenceCells));
}

TEST_F(
    MtmdLlmContextTest,
    Qwen35MultimodalGenerationWithCacheKeyKeepsMemoryAfterGeneration) {
  if (!hasValidQwen35Model()) {
    FAIL() << "Qwen3.5 multimodal model or projection file not found";
  }

  const fs::path imagePath = multimodalTestImagePath();
  if (!fs::exists(imagePath)) {
    FAIL() << "Multimodal test image not found";
  }

  auto model = createQwen35Model();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const fs::path cachePath =
      fs::temp_directory_path() / "qvac-qwen35-mtmd-generation-cache.bin";
  fs::remove(cachePath);

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "type": "media", "content": ""},)"
      R"( {"role": "user", "content": "Describe this image in one sentence."}])";
  prompt.cacheKey = cachePath.string();
  prompt.saveCacheToDisk = true;
  prompt.media.push_back(readBinaryFile(imagePath));

  std::string output = model->processPrompt(prompt);
  EXPECT_GE(output.length(), 0);

  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);

  const uint32_t sequenceCells = llama_memory_seq_token_count(mem, 0);
  const uint32_t totalCells = llama_memory_seq_token_count(mem, -1);
  const llama_pos posMax = llama_memory_seq_pos_max(mem, 0);
  SCOPED_TRACE(
      "sequenceCells=" + std::to_string(sequenceCells) +
      ", totalCells=" + std::to_string(totalCells) +
      ", posMax=" + std::to_string(posMax));

  EXPECT_GT(sequenceCells, kQwen35MultimodalPrefillCells);
  EXPECT_EQ(totalCells, sequenceCells);
  EXPECT_GT(posMax, kQwen35MultimodalPrefillPosMax);

  const auto stats = model->runtimeStats();
  EXPECT_EQ(
      getStatValue(stats, "CacheTokens"), static_cast<double>(sequenceCells));

  fs::remove(cachePath);
}

TEST_F(MtmdLlmContextTest, ProcessWithSessionCache) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt1;
  prompt1.input = R"([{"role": "user", "content": "Hello"}])";
  prompt1.cacheKey = "test_session.bin";
  EXPECT_NO_THROW({
    std::string output1 = model->processPrompt(prompt1);
    EXPECT_GE(output1.length(), 0);
    auto stats1 = model->runtimeStats();
    EXPECT_GE(stats1.size(), 0);
  });

  LlamaModel::Prompt prompt2;
  prompt2.input = R"([{"role": "user", "content": "Follow up message"}])";
  prompt2.cacheKey = "test_session.bin";
  EXPECT_NO_THROW({
    std::string output2 = model->processPrompt(prompt2);
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, InvalidMedia) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> invalidData = {0x00, 0x01, 0x02};
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "What is this?"}])";
  prompt.media.push_back(std::move(invalidData));
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, NonexistentFile) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"type": "media", "content": "nonexistent_image.jpg"}, {"role": "user", "content": "What is this?"}])";
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, ProcessWithTools) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([
    {"role": "user", "content": "What is the weather in Tokyo?"},
    {
      "type": "function",
      "name": "getWeather",
      "description": "Get weather forecast for a city",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {"type": "string", "description": "City name"},
          "date": {"type": "string", "description": "Date in YYYY-MM-DD"}
        },
        "required": ["city", "date"]
      }
    }
  ])";

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ProcessWithMultipleTools) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([
    {"role": "user", "content": "Search for products and add to cart"},
    {
      "type": "function",
      "name": "searchProducts",
      "description": "Search products",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {"type": "string", "description": "Search query"}
        },
        "required": ["query"]
      }
    },
    {
      "type": "function",
      "name": "addToCart",
      "description": "Add items to cart",
      "parameters": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {"type": "string"}
          }
        },
        "required": ["items"]
      }
    }
  ])";

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}
