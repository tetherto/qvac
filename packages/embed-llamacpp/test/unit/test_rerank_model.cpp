#include <algorithm>
#include <any>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <iterator>
#include <memory>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include <gguf.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "addon/BertErrors.hpp"
#include "model-interface/ModelMetadata.hpp"
#include "model-interface/RerankModel.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

namespace {

/// First existing candidate, relative to the working directory or the build
/// tree (build/test/unit), or empty.
std::string findModel(const std::string& relative) {
  fs::path backendDir;
#ifdef TEST_BINARY_DIR
  backendDir = fs::path(TEST_BINARY_DIR);
#else
  backendDir = fs::current_path() / "build" / "test" / "unit";
#endif
  for (const fs::path& path :
       {fs::path{relative},
        fs::path{"../../.."} / relative,
        backendDir.parent_path().parent_path().parent_path() / relative}) {
    if (fs::exists(path)) {
      return fs::absolute(path).string();
    }
  }
  return "";
}

std::string backendsDir() {
#ifdef TEST_BINARY_DIR
  return std::string(TEST_BINARY_DIR);
#else
  return (fs::current_path() / "build" / "test" / "unit").string();
#endif
}

std::unordered_map<std::string, std::string> deviceConfig() {
  return {
      {"device", test_common::getTestDevice()},
      {"gpu_layers", test_common::getTestGpuLayers()}};
}

std::string codeOf(const std::function<void()>& call) {
  try {
    call();
  } catch (const qvac_errors::StatusError& error) {
    return error.codeString();
  }
  return "no error";
}

/// A reranker GGUF: RERANK_TEST_MODEL, or models/unit-test/rerank-test.gguf
/// (jina-reranker-v1-tiny-en, the model llama-server's rerank tests use).
std::string rerankModelPath() {
  if (const char* env = std::getenv("RERANK_TEST_MODEL")) {
    return fs::exists(env) ? std::string(env) : std::string();
  }
  return findModel("models/unit-test/rerank-test.gguf");
}

std::unordered_map<std::string, double> statsOf(const RerankModel& model) {
  std::unordered_map<std::string, double> stats;
  for (const auto& [key, value] : model.runtimeStats()) {
    stats[key] =
        std::visit([](auto v) { return static_cast<double>(v); }, value);
  }
  return stats;
}

// llama-server's rerank test: document 2 answers the query, document 3 is in
// French about Paris.
const char* kQuery = "Machine learning is";
const std::vector<std::string> kDocuments = {
    "A machine is a physical system that uses power to apply forces and "
    "control movement to perform an action. The term is commonly applied to "
    "artificial devices, such as those employing engines or motors, but also "
    "to natural biological macromolecules, such as molecular machines.",
    "Learning is the process of acquiring new understanding, knowledge, "
    "behaviors, skills, values, attitudes, and preferences. The ability to "
    "learn is possessed by humans, non-human animals, and some machines; there "
    "is also evidence for some kind of learning in certain plants.",
    "Machine learning is a field of study in artificial intelligence concerned "
    "with the development and study of statistical algorithms that can learn "
    "from data and generalize to unseen data, and thus perform tasks without "
    "explicit instructions.",
    "Paris, capitale de la France, est une grande ville européenne et un "
    "centre mondial de l'art, de la mode, de la gastronomie et de la culture. "
    "Son paysage urbain du XIXe siècle est traversé par de larges boulevards "
    "et la Seine."};

} // namespace

TEST(RerankModelConfigTest, AcceptsRerankLoadOptions) {
  const std::unordered_map<std::string, std::string> config = {
      {"device", "gpu"},
      {"gpu_layers", "99"},
      {"batch_size", "1024"},
      {"verbosity", "1"},
      {"main-gpu", "0"},
      {"split-mode", "none"},
      {"flash_attn", "auto"},
      {"backend", "vulkan"},
      {"threads", "1"},
      {"threads-batch", "0"},
      {"poll", "0"},
      {"poll-batch", "50"},
      {"openclCacheDir", "/tmp"}};
  EXPECT_NO_THROW(RerankModel::checkConfig(config));
}

TEST(RerankModelConfigTest, RejectsOptionsThatDoNotApply) {
  for (const char* key :
       {"pooling",
        "ctx_size",
        "ctx-size",
        "embd_normalize",
        "attention",
        "ubatch-size",
        "parallel"}) {
    try {
      RerankModel::checkConfig({{"device", "cpu"}, {key, "1"}});
      FAIL() << key << " must be rejected";
    } catch (const qvac_errors::StatusError& error) {
      EXPECT_EQ(error.codeString(), "[ GTE :: InvalidConfiguration ]");
      EXPECT_NE(
          std::string(error.what()).find("is not a rerank load option"),
          std::string::npos)
          << error.what();
    }
  }
}

TEST(RerankModelConfigTest, ThreadsAreChecked) {
  EXPECT_EQ(
      codeOf([] {
        RerankModel::checkConfig({{"device", "cpu"}, {"threads", "abc"}});
      }),
      "[ GTE :: InvalidConfiguration ]");
}

TEST(RerankModelConfigTest, ConstructorRejectsOptionsThatDoNotApply) {
  EXPECT_EQ(
      codeOf([] {
        RerankModel model(
            "unused.gguf", {{"device", "cpu"}, {"pooling", "rank"}}, "");
      }),
      "[ GTE :: InvalidConfiguration ]");
}

// A placeholder inside the query or the document is text, not a slot to fill.
TEST(RerankModelTemplateTest, FillsBothPlaceholdersInOnePass) {
  const std::string tmpl =
      "<s>Query: {query}\nDocument: {document}\nRelevant ({query})?";
  EXPECT_EQ(
      RerankModel::fillTemplate(tmpl, "what is {document}?", "a {query} doc"),
      "<s>Query: what is {document}?\nDocument: a {query} doc\nRelevant "
      "(what is {document}?)?");
  EXPECT_EQ(RerankModel::fillTemplate("{query}{document}", "", ""), "");
  EXPECT_EQ(
      RerankModel::fillTemplate("no slots {quer} {doc}", "q", "d"),
      "no slots {quer} {doc}");
}

TEST(RerankModelLoadTest, RejectsEmbeddingModel) {
  const std::string path = findModel("models/unit-test/test-model.gguf");
  if (path.empty()) {
    FAIL() << "Test model not found: models/unit-test/test-model.gguf";
  }
  RerankModel model(path, {{"device", "cpu"}}, "");
  model.initializeBackend(backendsDir());
  try {
    model.waitForLoadInitialization();
    FAIL() << "an embedding model must be rejected";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_EQ(error.codeString(), "[ GTE :: UnsupportedModel ]");
    EXPECT_NE(
        std::string(error.what()).find("not a reranker"), std::string::npos)
        << error.what();
  }
  EXPECT_FALSE(model.isLoaded());
}

// A GGUF that declares no pooling and has no classifier head, as a chat
// model's: header only, written here so the test needs no download.
TEST(RerankModelLoadTest, RejectsModelWithoutClassifierHead) {
  const fs::path path =
      fs::temp_directory_path() / "rerank-test-no-classifier.gguf";
  gguf_context* gguf = gguf_init_empty();
  gguf_set_val_str(gguf, "general.architecture", "bert");
  ASSERT_TRUE(gguf_write_to_file(gguf, path.string().c_str(), false));
  gguf_free(gguf);

  RerankModel model(path.string(), {{"device", "cpu"}}, "");
  model.initializeBackend(backendsDir());
  try {
    model.waitForLoadInitialization();
    FAIL() << "a model without a classifier head must be rejected";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_EQ(error.codeString(), "[ GTE :: UnsupportedModel ]");
    EXPECT_NE(
        std::string(error.what()).find("no classifier head"), std::string::npos)
        << error.what();
  }
  EXPECT_FALSE(model.isLoaded());
  fs::remove(path);
}

TEST(RerankModelLoadTest, RerankerDeclaresNoPoolingButHasAClassifier) {
  const std::string path = rerankModelPath();
  if (path.empty()) {
    FAIL() << "Rerank test model not found (set RERANK_TEST_MODEL or add "
              "models/unit-test/rerank-test.gguf)";
  }
  ModelMetaData meta;
  meta.parse(path, GGUFShards{}, false, "Test");
  EXPECT_FALSE(meta.tryGetPoolingType().has_value());
  EXPECT_EQ(meta.hasAnyTensor({"cls.weight"}), true);
}

/// Needs the reranker GGUF, see rerankModelPath().
class RerankModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    modelPath_ = rerankModelPath();
    if (modelPath_.empty()) {
      FAIL() << "Rerank test model not found (set RERANK_TEST_MODEL or add "
                "models/unit-test/rerank-test.gguf)";
    }
  }

  std::unique_ptr<RerankModel>
  load(std::unordered_map<std::string, std::string> extra = {}) {
    auto config = deviceConfig();
    config.merge(extra);
    auto model = std::make_unique<RerankModel>(modelPath_, config, "");
    model->initializeBackend(backendsDir());
    model->waitForLoadInitialization();
    return model;
  }

  std::string modelPath_;
};

TEST_F(RerankModelTest, RanksTheAnsweringDocumentFirst) {
  auto model = load();
  ASSERT_TRUE(model->isLoaded());

  const std::vector<float> scores = model->rerank(kQuery, kDocuments).scores;
  ASSERT_EQ(scores.size(), kDocuments.size());
  for (float score : scores) {
    EXPECT_TRUE(std::isfinite(score));
  }
  EXPECT_EQ(std::distance(scores.begin(), std::ranges::max_element(scores)), 2);
  EXPECT_EQ(std::distance(scores.begin(), std::ranges::min_element(scores)), 3);
}

TEST_F(RerankModelTest, RepeatedRequestsScoreTheSame) {
  auto model = load();
  const std::vector<float> first = model->rerank(kQuery, kDocuments).scores;
  const std::vector<float> second = model->rerank(kQuery, kDocuments).scores;
  EXPECT_EQ(first, second);
}

TEST_F(RerankModelTest, ScoresDoNotDependOnBatching) {
  auto model = load();
  const std::vector<float> together = model->rerank(kQuery, kDocuments).scores;
  EXPECT_EQ(statsOf(*model)["forward_passes"], 1);

  for (std::size_t i = 0; i < kDocuments.size(); ++i) {
    const std::vector<float> alone =
        model->rerank(kQuery, std::vector{kDocuments[i]}).scores;
    ASSERT_EQ(alone.size(), 1U);
    EXPECT_NEAR(alone[0], together[i], 1e-2F) << "document " << i;
  }

  // A batch that holds one pair at a time: one pass per document.
  auto small = load({{"batch_size", "96"}});
  const std::vector<float> split = small->rerank(kQuery, kDocuments).scores;
  EXPECT_EQ(statsOf(*small)["forward_passes"], kDocuments.size());
  ASSERT_EQ(split.size(), together.size());
  for (std::size_t i = 0; i < split.size(); ++i) {
    EXPECT_NEAR(split[i], together[i], 1e-2F) << "document " << i;
  }
}

TEST_F(RerankModelTest, NoDocumentsGiveNoScores) {
  auto model = load();
  EXPECT_TRUE(model->rerank(kQuery, {}).scores.empty());
  EXPECT_EQ(statsOf(*model)["forward_passes"], 0);
}

TEST_F(RerankModelTest, PairLongerThanTheBatchIsRejected) {
  auto model = load({{"batch_size", "32"}});
  try {
    model->rerank(kQuery, std::vector{kDocuments[0]});
    FAIL() << "a pair longer than batch_size must be rejected";
  } catch (const qvac_errors::StatusError& error) {
    EXPECT_EQ(error.codeString(), "[ GTE :: InputTokensExceedBatchSize ]");
    EXPECT_NE(
        std::string(error.what()).find("increase batch_size"),
        std::string::npos)
        << error.what();
  }
}

TEST_F(RerankModelTest, ProcessTakesTheQueryThenTheDocuments) {
  auto model = load();
  std::vector<std::string> input = {kQuery};
  input.insert(input.end(), kDocuments.begin(), kDocuments.end());
  const auto result =
      std::any_cast<RerankScores>(model->process(std::any(input)));
  EXPECT_EQ(result.scores, model->rerank(kQuery, kDocuments).scores);

  EXPECT_EQ(
      codeOf([&] { model->process(std::any(std::vector<std::string>{})); }),
      "[ GTE :: InvalidRequest ]");
  EXPECT_NE(
      codeOf([&] { model->process(std::any(std::string(kQuery))); }),
      "no error");
}

TEST_F(RerankModelTest, RuntimeStatsDescribeTheLastRequest) {
  auto model = load();
  model->rerank(kQuery, kDocuments);
  auto stats = statsOf(*model);
  EXPECT_EQ(stats["documents"], kDocuments.size());
  EXPECT_EQ(stats["forward_passes"], 1);
  EXPECT_GT(stats["total_tokens"], 0);
  EXPECT_GT(stats["batch_size"], 0);
  EXPECT_GT(stats["context_size"], 0);
}
