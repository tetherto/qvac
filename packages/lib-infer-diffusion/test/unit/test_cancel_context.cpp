#include <any>
#include <atomic>
#include <chrono>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/SdModel.hpp"
#include "test_common.hpp"

using namespace qvac_lib_inference_addon_sd;

// ---------------------------------------------------------------------------
// Test fixture — loads the model once per suite (expensive)
// ---------------------------------------------------------------------------
class SdCancelContextTest : public ::testing::Test {
protected:
  static std::unique_ptr<SdModel> model;

  static void SetUpTestSuite() {
    const auto path = sd_test_helpers::getModelPath();
    if (path.empty())
      return;

    SdCtxConfig config{};
    config.modelPath = path;
    config.prediction = V_PRED;
    config.nThreads = sd_test_helpers::getTestThreads();
    config.device = sd_test_helpers::getTestDevice();
    // freeParamsImmediately defaults to false in our config — this is what
    // we're testing: the model must survive multiple generations and
    // cancel-then-rerun without segfaulting.

    model = std::make_unique<SdModel>(std::move(config));
    model->load();
  }

  static void TearDownTestSuite() {
    if (model) {
      model->unload();
      model.reset();
    }
  }

  void SetUp() override {
    if (!model)
      GTEST_SKIP() << "SD2.1 model not available — set SD_TEST_MODEL_PATH or "
                      "download to test/model/";
  }

  // Helper: build a GenerationJob with many steps (gives time to cancel)
  static SdModel::GenerationJob makeLongJob(
      std::atomic<int>& progressSteps,
      std::vector<std::vector<uint8_t>>& images) {
    SdModel::GenerationJob job;
    job.paramsJson = R"({
      "prompt": "a red fox in snow",
      "steps": 50,
      "width": 256,
      "height": 256,
      "cfg_scale": 7.5,
      "seed": 42
    })";
    job.progressCallback = [&](const std::string&) {
      progressSteps.fetch_add(1);
    };
    job.outputCallback = [&](const std::vector<uint8_t>& png) {
      images.push_back(png);
    };
    return job;
  }

  // Helper: build a short GenerationJob (quick completion)
  static SdModel::GenerationJob
  makeShortJob(std::vector<std::vector<uint8_t>>& images) {
    SdModel::GenerationJob job;
    job.paramsJson = R"({
      "prompt": "solid white",
      "steps": 2,
      "width": 256,
      "height": 256,
      "cfg_scale": 7.5,
      "seed": 1
    })";
    job.outputCallback = [&](const std::vector<uint8_t>& png) {
      images.push_back(png);
    };
    return job;
  }
};

std::unique_ptr<SdModel> SdCancelContextTest::model = nullptr;

// ---------------------------------------------------------------------------
// 1. Cancel on idle model is safe (no crash, no state corruption)
// ---------------------------------------------------------------------------
TEST_F(SdCancelContextTest, CancelWhenIdleIsNoop) {
  EXPECT_NO_THROW(model->cancel());
  // cancel() sets the flag even when idle — it is only cleared on process()
  // entry.  This is safe: the flag is reset before the next generation begins.
  EXPECT_TRUE(model->isCancelRequested());

  std::vector<std::vector<uint8_t>> images;
  auto job = makeShortJob(images);
  EXPECT_NO_THROW(model->process(std::any(job)));
  EXPECT_EQ(images.size(), 1u) << "Short job should produce 1 image";
}

// ---------------------------------------------------------------------------
// 2. Cancel during generation throws "Job cancelled" (cancel-as-error)
// ---------------------------------------------------------------------------
TEST_F(SdCancelContextTest, CancelDuringGenerationThrowsJobCancelled) {
  std::atomic<int> progressSteps{0};
  std::vector<std::vector<uint8_t>> images;
  auto job = makeLongJob(progressSteps, images);

  // Fire cancel from another thread after the first progress tick
  std::thread cancelThread([&] {
    while (progressSteps.load() < 1)
      std::this_thread::sleep_for(std::chrono::milliseconds{5});
    model->cancel();
  });

  try {
    model->process(std::any(job));
    FAIL() << "process() should have thrown on cancel";
  } catch (const std::runtime_error& e) {
    EXPECT_STREQ(e.what(), "Job cancelled");
  } catch (...) {
    cancelThread.join();
    FAIL() << "Unexpected exception type";
  }

  cancelThread.join();

  // No output images should have been emitted (buffers freed, not encoded)
  EXPECT_EQ(images.size(), 0u) << "Cancelled generation should not emit images";
}

// ---------------------------------------------------------------------------
// 3. Model is reusable after cancel (freeParamsImmediately = false)
//    This is the exact scenario that caused the SIGSEGV before the fix.
// ---------------------------------------------------------------------------
TEST_F(SdCancelContextTest, RunAfterCancelProducesValidOutput) {
  // First: start and cancel a long job
  std::atomic<int> progressSteps{0};
  std::vector<std::vector<uint8_t>> cancelledImages;
  auto longJob = makeLongJob(progressSteps, cancelledImages);

  std::thread cancelThread([&] {
    while (progressSteps.load() < 1)
      std::this_thread::sleep_for(std::chrono::milliseconds{5});
    model->cancel();
  });

  try {
    model->process(std::any(longJob));
  } catch (const std::runtime_error&) {
    // expected — "Job cancelled"
  }
  cancelThread.join();

  // Second: run a short job on the same model instance.
  // Before the fix, this would segfault because:
  //   1. freeParamsImmediately=true freed weight buffers after first run
  //   2. compute buffer was freed on wrong model (diffusion_model vs
  //      work_diffusion_model), corrupting sd_ctx state
  std::vector<std::vector<uint8_t>> images;
  auto shortJob = makeShortJob(images);

  EXPECT_NO_THROW(model->process(std::any(shortJob)));
  ASSERT_EQ(images.size(), 1u) << "Rerun after cancel should produce 1 image";
  EXPECT_TRUE(sd_test_helpers::isPng(images[0])) << "Output must be valid PNG";
}

// ---------------------------------------------------------------------------
// 4. Multiple sequential generations work (model reuse without cancel)
//    Verifies freeParamsImmediately=false doesn't break normal reuse.
// ---------------------------------------------------------------------------
TEST_F(SdCancelContextTest, MultipleSequentialGenerationsSucceed) {
  for (int i = 0; i < 3; ++i) {
    std::vector<std::vector<uint8_t>> images;
    auto job = makeShortJob(images);

    EXPECT_NO_THROW(model->process(std::any(job)))
        << "Generation " << i << " should not throw";
    ASSERT_EQ(images.size(), 1u)
        << "Generation " << i << " should produce 1 image";
    EXPECT_TRUE(sd_test_helpers::isPng(images[0]))
        << "Generation " << i << " output must be valid PNG";
  }
}

// ---------------------------------------------------------------------------
// 5. Cancel flag is reset at the start of each process() call
// ---------------------------------------------------------------------------
TEST_F(SdCancelContextTest, CancelFlagResetOnProcessEntry) {
  // Set cancel flag manually
  model->cancel();
  ASSERT_TRUE(model->isCancelRequested());

  // process() should reset it at entry, then run normally
  std::vector<std::vector<uint8_t>> images;
  auto job = makeShortJob(images);

  // With only 2 steps and the flag reset at entry, this should complete
  // normally — the abort callback only fires during denoising, and
  // cancelRequested_ is false by then.
  EXPECT_NO_THROW(model->process(std::any(job)));
  EXPECT_EQ(images.size(), 1u) << "Should produce 1 image";
}

// ---------------------------------------------------------------------------
// 6. process() on unloaded model throws (not crash/segfault)
// ---------------------------------------------------------------------------
TEST_F(SdCancelContextTest, ProcessOnUnloadedModelThrows) {
  SdCtxConfig config{};
  SdModel unloadedModel(std::move(config));

  std::vector<std::vector<uint8_t>> images;
  auto job = makeShortJob(images);

  EXPECT_THROW(unloadedModel.process(std::any(job)), std::exception);
}

// ---------------------------------------------------------------------------
// 7. Runtime stats are populated after successful generation
// ---------------------------------------------------------------------------
TEST_F(SdCancelContextTest, RuntimeStatsPopulatedAfterGeneration) {
  std::vector<std::vector<uint8_t>> images;
  auto job = makeShortJob(images);

  model->process(std::any(job));

  auto stats = model->runtimeStats();
  EXPECT_FALSE(stats.empty()) << "Stats should be populated after generation";

  // Check expected stat keys exist
  bool hasGenerationTime = false;
  bool hasOutputCount = false;
  for (const auto& [key, value] : stats) {
    if (key == "generation_time")
      hasGenerationTime = true;
    if (key == "output_count")
      hasOutputCount = true;
  }
  EXPECT_TRUE(hasGenerationTime) << "Stats must include generation_time";
  EXPECT_TRUE(hasOutputCount) << "Stats must include output_count";
}
