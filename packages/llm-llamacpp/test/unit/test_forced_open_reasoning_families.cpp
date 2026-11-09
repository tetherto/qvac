// The forced-open reasoning opener across model families.
//
// A template that ends its generation prompt inside the reasoning block
// (`<think>` / `<think>\n`) leaves the model nothing to open, so the addon
// streams the opener itself, first and once, on the single-prompt and the
// batch (`parallel >= 2`) path alike; consumers that split reasoning on the
// tags read it as content otherwise. Covered per family:
//
// - model-free: which templates force the block open, and with what opener;
// - Qwen3.5-0.8B driven through each family's template on the text and the
//   multimodal batch drivers, so CI covers every family's opener;
// - real GLM / DeepSeek / other GGUFs, opt-in by env var, on both paths.

#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include <gtest/gtest.h>
#include <llama.h>

#include "model-interface/ContinuousBatchScheduler.hpp"
#include "model-interface/LlamaModel.hpp"
#include "reasoning_family_templates.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"

namespace fixtures = qvac_lib_inference_addon_llama::test;
using qvac_lib_inference_addon_llama::batching::DriverFactory;

namespace {

namespace fs = std::filesystem;

constexpr std::string_view K_WHITESPACE = " \t\r\n";

std::string trim(std::string_view text) {
  const size_t first = text.find_first_not_of(K_WHITESPACE);
  if (first == std::string_view::npos) {
    return {};
  }
  const size_t last = text.find_last_not_of(K_WHITESPACE);
  return std::string(text.substr(first, last - first + 1));
}

bool hasTextFrom(const std::string& text, size_t from) {
  return text.find_first_not_of(K_WHITESPACE, from) != std::string::npos;
}

/// @p text starts with @p opener, and does not open a second block right
/// after it.
::testing::AssertionResult
opensOnceWith(const std::string& text, const std::string& opener) {
  if (text.rfind(opener, 0) != 0) {
    return ::testing::AssertionFailure() << "does not start with the opener \""
                                         << opener << "\": \"" << text << "\"";
  }
  const std::string tag = trim(opener);
  const size_t next = text.find_first_not_of(K_WHITESPACE, opener.size());
  if (next != std::string::npos && text.compare(next, tag.size(), tag) == 0) {
    return ::testing::AssertionFailure()
           << "streams the opener twice: \"" << text << "\"";
  }
  return ::testing::AssertionSuccess();
}

/// What a request rendered with @p opener streams first: the opener once, or,
/// when the render does not force the block open, no @p onOpener tag.
::testing::AssertionResult startsAsRendered(
    const std::string& text, const std::string& opener,
    const std::string& onOpener) {
  if (!opener.empty()) {
    return opensOnceWith(text, opener);
  }
  if (text.rfind(trim(onOpener), 0) == 0) {
    return ::testing::AssertionFailure()
           << "a request whose render does not force the block open starts "
              "with \""
           << trim(onOpener) << "\": \"" << text << "\"";
  }
  return ::testing::AssertionSuccess();
}

/// The openers one family's template forces: thinking on, and thinking off
/// (empty unless the template opens the block regardless).
struct ForcedOpeners {
  std::string on;
  std::string off;
};

ForcedOpeners openersOfSource(const char* source) {
  common_chat_templates_ptr tmpls = common_chat_templates_init(nullptr, source);
  if (tmpls == nullptr) {
    return {};
  }
  return {
      fixtures::forcedOpenerOf(tmpls.get(), true),
      fixtures::forcedOpenerOf(tmpls.get(), false)};
}

/// The openers of the template embedded in the GGUF at @p path (a first shard
/// for a split model), read with the vocabulary only.
ForcedOpeners openersOfGguf(const std::string& path) {
  auto params = llama_model_default_params();
  params.vocab_only = true;
  params.n_gpu_layers = 0;
  std::unique_ptr<llama_model, decltype(&llama_model_free)> model(
      llama_model_load_from_file(path.c_str(), params), llama_model_free);
  if (model == nullptr) {
    return {};
  }
  common_chat_templates_ptr tmpls = common_chat_templates_init(model.get(), "");
  if (tmpls == nullptr) {
    return {};
  }
  return {
      fixtures::forcedOpenerOf(tmpls.get(), true),
      fixtures::forcedOpenerOf(tmpls.get(), false)};
}

LlamaModel::Prompt makePrompt(const char* input, std::string* streamed) {
  LlamaModel::Prompt prompt;
  prompt.input = input;
  if (streamed != nullptr) {
    prompt.outputCallback = [streamed](const std::string& piece) {
      *streamed += piece;
    };
  }
  return prompt;
}

constexpr const char* K_FIRST =
    R"([{"role":"user","content":"What is 17 * 23?"}])";
constexpr const char* K_SECOND =
    R"([{"role":"user","content":"What is 12 * 11?"}])";

/// The batch half of the contract for one set of openers: a
/// one-prompt batch (the route of a single `run()`), a two-prompt batch, and
/// a batch with a `reasoning_budget: 0` sibling each start with the opener
/// their render forces, once, and stream exactly what they return.
/// @p requireGeneratedText also requires text after the opener; leave it off
/// when the model is driven through a template it was not trained on.
void expectBatchStreamsOpener(
    LlamaModel& model, const ForcedOpeners& openers,
    bool requireGeneratedText) {
  ASSERT_NE(LlamaModelTestPeer::scheduler(model), nullptr)
      << "test requires the continuous-batching scheduler";
  ASSERT_FALSE(openers.on.empty());
  const auto opensAndGenerates = [&](const std::string& text) {
    EXPECT_TRUE(opensOnceWith(text, openers.on));
    if (requireGeneratedText) {
      EXPECT_TRUE(hasTextFrom(text, openers.on.size())) << text;
    }
  };

  std::string streamedAlone;
  const auto alone = model.processPromptBatch(
      std::vector<LlamaModel::Prompt>{makePrompt(K_FIRST, &streamedAlone)});
  ASSERT_EQ(alone.size(), 1u);
  opensAndGenerates(alone[0]);
  EXPECT_EQ(streamedAlone, alone[0]);

  std::string streamed;
  const auto pair = model.processPromptBatch(
      std::vector<LlamaModel::Prompt>{
          makePrompt(K_FIRST, &streamed), makePrompt(K_SECOND, nullptr)});
  ASSERT_EQ(pair.size(), 2u);
  opensAndGenerates(pair[0]);
  opensAndGenerates(pair[1]);
  EXPECT_EQ(streamed, pair[0]);

  std::string streamedOn;
  std::string streamedOff;
  auto thinkingOff = makePrompt(K_SECOND, &streamedOff);
  thinkingOff.generationParams.reasoning_budget = 0;
  const auto mixed = model.processPromptBatch(
      std::vector<LlamaModel::Prompt>{
          makePrompt(K_FIRST, &streamedOn), std::move(thinkingOff)});
  ASSERT_EQ(mixed.size(), 2u);
  opensAndGenerates(mixed[0]);
  EXPECT_TRUE(startsAsRendered(mixed[1], openers.off, openers.on));
  EXPECT_EQ(streamedOn, mixed[0]);
  EXPECT_EQ(streamedOff, mixed[1]);
}

/// Swaps @p chatTemplate into every driver the scheduler builds from here on.
/// An empty template keeps the one embedded in the GGUF.
void overrideDriverTemplate(
    LlamaModel& model, std::shared_ptr<std::string> chatTemplate) {
  auto* scheduler = LlamaModelTestPeer::scheduler(model);
  ASSERT_NE(scheduler, nullptr)
      << "test requires the continuous-batching scheduler";
  const DriverFactory original =
      ContinuousBatchSchedulerTestPeer::driverFactory(*scheduler);
  ContinuousBatchSchedulerTestPeer::setDriverFactory(
      *scheduler,
      [original, chatTemplate](
          const common_params& params, uint32_t seqId, llama_pos ceiling) {
        common_params withTemplate = params;
        withTemplate.chat_template = *chatTemplate;
        return original(withTemplate, seqId, ceiling);
      });
}

/// Runs the batch contract for the GGUF's own template and then for every
/// family that forces its reasoning block open, on whichever driver
/// @p model's scheduler builds.
void expectEveryFamilyStreamsItsOpener(
    LlamaModel& model, const std::string& ggufPath) {
  auto chatTemplate = std::make_shared<std::string>();
  overrideDriverTemplate(model, chatTemplate);
  if (::testing::Test::HasFatalFailure()) {
    return;
  }
  {
    SCOPED_TRACE("template embedded in " + ggufPath);
    const ForcedOpeners openers = openersOfGguf(ggufPath);
    ASSERT_FALSE(openers.on.empty())
        << "the fixture's own template must force the block open";
    expectBatchStreamsOpener(model, openers, /*requireGeneratedText=*/true);
  }
  for (const auto& family : fixtures::REASONING_FAMILY_TEMPLATES) {
    if (!family.forcesOpen) {
      continue;
    }
    SCOPED_TRACE(family.name);
    *chatTemplate = family.source;
    const ForcedOpeners openers = openersOfSource(family.source);
    ASSERT_FALSE(openers.on.empty())
        << family.name << " must force the reasoning block open";
    expectBatchStreamsOpener(model, openers, /*requireGeneratedText=*/false);
  }
}

class ForcedOpenReasoningFamiliesTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_["device"] = test_common::getTestDevice();
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["ctx_size"] = "4096";
    config_["parallel"] = "2";
    config_["batch_size"] = "256";
    config_["n_predict"] = "8";
    config_["temp"] = "0";
    config_["backendsDir"] = test_common::getTestBackendsDir().string();
  }

  std::unique_ptr<LlamaModel>
  load(std::string path, std::string projection = {}) {
    auto cfg = config_;
    auto model = std::make_unique<LlamaModel>(
        std::move(path), std::move(projection), std::move(cfg));
    model->waitForLoadInitialization();
    return model;
  }

  /// The single-prompt and batch halves of the contract on a real model with
  /// its own template. False, with nothing asserted, when that template does
  /// not force the reasoning block open.
  bool expectRealModelStreamsOpener(const std::string& path) {
    const ForcedOpeners openers = openersOfGguf(path);
    if (openers.on.empty()) {
      return false;
    }
    SCOPED_TRACE(path + ", opener \"" + openers.on + "\"");
    auto model = load(path);
    EXPECT_TRUE(model->isLoaded());
    if (!model->isLoaded()) {
      return true;
    }
    const std::string single =
        model->processPrompt(makePrompt(K_FIRST, nullptr));
    EXPECT_TRUE(opensOnceWith(single, openers.on));
    EXPECT_TRUE(hasTextFrom(single, openers.on.size())) << single;
    expectBatchStreamsOpener(*model, openers, /*requireGeneratedText=*/true);
    return true;
  }

  std::unordered_map<std::string, std::string> config_;
};

} // namespace

TEST(
    ReasoningFamilyTemplateTest, ThinkingOnForceOpensExactlyTheForcedFamilies) {
  for (const auto& family : fixtures::REASONING_FAMILY_TEMPLATES) {
    SCOPED_TRACE(family.name);
    const ForcedOpeners openers = openersOfSource(family.source);
    if (family.forcesOpen) {
      EXPECT_EQ(trim(openers.on), "<think>") << '"' << openers.on << '"';
    } else {
      EXPECT_EQ(openers.on, "") << "the model opens its own block";
    }
  }
}

TEST(
    ReasoningFamilyTemplateTest, ThinkingOffForceOpensOnlyTheAlwaysOpenFamily) {
  for (const auto& family : fixtures::REASONING_FAMILY_TEMPLATES) {
    SCOPED_TRACE(family.name);
    const ForcedOpeners openers = openersOfSource(family.source);
    if (family.forcesOpenWithThinkingOff) {
      EXPECT_EQ(trim(openers.off), "<think>") << '"' << openers.off << '"';
    } else {
      EXPECT_EQ(openers.off, "") << '"' << openers.off << '"';
    }
  }
}

// The 0.8B Qwen3.5 model is driven through each family's template, so the
// opener under test is that family's; what the model generates after it is
// not asserted.
TEST_F(
    ForcedOpenReasoningFamiliesTest, TextBatchStreamsEveryFamilysForcedOpener) {
  const test_common::TestModelPath modelPath(
      "Qwen3.5-0.8B-Q8_0.gguf",
      "QWEN35_BATCH_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF");
  REQUIRE_MODEL(modelPath);
  auto model = load(modelPath.path);
  ASSERT_TRUE(model->isLoaded());
  expectEveryFamilyStreamsItsOpener(*model, modelPath.path);
}

TEST_F(
    ForcedOpenReasoningFamiliesTest, MtmdBatchStreamsEveryFamilysForcedOpener) {
  const std::string vlmPath =
      test_common::BaseTestModelPath::get("Qwen3.5-0.8B-Q8_0.gguf");
  const std::string mmprojPath =
      test_common::BaseTestModelPath::get("mmproj-Qwen3.5-0.8B-F16.gguf");
  if (!fs::exists(vlmPath) || !fs::exists(mmprojPath)) {
    GTEST_SKIP() << "Qwen3.5 M-RoPE fixture not found";
  }
  auto model = load(vlmPath, mmprojPath);
  ASSERT_TRUE(model->isLoaded());
  expectEveryFamilyStreamsItsOpener(*model, vlmPath);
}

// Real GLM / DeepSeek GGUFs are too large for the unit-test model set. Point
// the env var at a GGUF (the first shard of a split model) to run one.

TEST_F(ForcedOpenReasoningFamiliesTest, RealGlm47FlashStreamsTheOpener) {
  const test_common::TestModelPath modelPath(
      "GLM-4.7-Flash-Q4_K_M.gguf",
      "GLM47_FLASH_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/unsloth/GLM-4.7-Flash-GGUF");
  REQUIRE_MODEL(modelPath);
  config_["n_predict"] = "16";
  config_["split_mode"] = "layer";
  ASSERT_TRUE(expectRealModelStreamsOpener(modelPath.path))
      << "the GGUF's template does not force the reasoning block open";
}

TEST_F(ForcedOpenReasoningFamiliesTest, RealDeepSeekR1DistillStreamsTheOpener) {
  const test_common::TestModelPath modelPath(
      "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
      "DEEPSEEK_R1_DISTILL_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF");
  REQUIRE_MODEL(modelPath);
  config_["n_predict"] = "16";
  ASSERT_TRUE(expectRealModelStreamsOpener(modelPath.path))
      << "the GGUF's template does not force the reasoning block open";
}

TEST_F(ForcedOpenReasoningFamiliesTest, RealDeepSeekV4FlashStreamsTheOpener) {
  const test_common::TestModelPath modelPath(
      "DeepSeek-V4-Flash-0731-UD-IQ1_M-00001-of-00003.gguf",
      "DSV4_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF");
  REQUIRE_MODEL(modelPath);
  config_["n_predict"] = "16";
  config_["split_mode"] = "layer";
  ASSERT_TRUE(expectRealModelStreamsOpener(modelPath.path))
      << "the GGUF's template does not force the reasoning block open";
}

// Any other model, such as the Qwen3.6 / Qwen3.8 / Bonsai GGUFs the registry
// ships: `QVAC_FORCED_OPENER_MODELS` takes comma-separated GGUF paths. A model
// whose template does not force the block open is reported and left out.
TEST_F(ForcedOpenReasoningFamiliesTest, ModelsFromEnvStreamTheOpener) {
  const char* list = std::getenv("QVAC_FORCED_OPENER_MODELS");
  if (list == nullptr || *list == '\0') {
    GTEST_SKIP() << "opt-in: set QVAC_FORCED_OPENER_MODELS to GGUF paths";
  }
  config_["n_predict"] = "16";
  config_["split_mode"] = "layer";
  std::vector<std::string> notForced;
  size_t tested = 0;
  std::stringstream paths(list);
  std::string path;
  while (std::getline(paths, path, ',')) {
    path = trim(path);
    if (path.empty()) {
      continue;
    }
    ASSERT_TRUE(fs::exists(path)) << path << " not found";
    if (expectRealModelStreamsOpener(path)) {
      ++tested;
    } else {
      notForced.push_back(path);
    }
  }
  for (const std::string& skipped : notForced) {
    std::cout << "[ INFO ] template does not force the reasoning block open: "
              << skipped << '\n';
  }
  if (tested == 0) {
    GTEST_SKIP() << "no listed model forces the reasoning block open";
  }
}
