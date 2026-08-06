#include <gtest/gtest.h>

#include "model-interface/LlamaFinetuningParams.hpp"

using qvac_lib_inference_addon_llama::LlamaFinetuningParams;

// Guards the inline defaults that now drive omitted-option parse behavior:
// FinetuneParamHandlers only assigns fields the caller provides, so a change to
// any default here silently changes what an omitted option resolves to.
TEST(LlamaFinetuningParamsDefaults, MatchDocumentedValues) {
  LlamaFinetuningParams p;
  EXPECT_EQ(p.numberOfEpochs, 1);
  EXPECT_DOUBLE_EQ(p.learningRate, 1e-4);
  EXPECT_EQ(p.contextLength, 128);
  EXPECT_EQ(p.microBatchSize, 128);
  EXPECT_FALSE(p.assistantLossOnly);
  EXPECT_EQ(p.loraRank, 8);
  EXPECT_DOUBLE_EQ(p.loraAlpha, 16.0);
  EXPECT_DOUBLE_EQ(p.loraInitStd, 0.02);
  EXPECT_EQ(p.loraSeed, 42u);
  EXPECT_EQ(p.checkpointSaveSteps, 0);
  EXPECT_DOUBLE_EQ(p.lrMin, 0.0);
  EXPECT_EQ(p.lrScheduler, "cosine");
  EXPECT_DOUBLE_EQ(p.warmupRatio, 0.1);
  EXPECT_EQ(p.batchSize, 128);
  EXPECT_DOUBLE_EQ(p.weightDecay, 0.01);
  EXPECT_FALSE(p.warmupStepsSet);
  EXPECT_EQ(p.warmupSteps, 0);
  EXPECT_FALSE(p.warmupRatioSet);
  EXPECT_DOUBLE_EQ(p.validationSplit, 0.05);
  EXPECT_FALSE(p.useEvalDatasetForValidation);
  EXPECT_FALSE(p.flashAttn);
  EXPECT_TRUE(p.outputParametersDir.empty());
  EXPECT_TRUE(p.trainDatasetDir.empty());
  EXPECT_TRUE(p.evalDatasetPath.empty());
  EXPECT_TRUE(p.checkpointSaveDir.empty());
  EXPECT_TRUE(p.loraModules.empty());
  EXPECT_TRUE(p.chatTemplatePath.empty());
}
