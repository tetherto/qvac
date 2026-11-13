#include <array>
#include <filesystem>
#include <functional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <gguf.h>
#include <gtest/gtest.h>
#include <llama.h>

#include "model-interface/LlmContext.hpp"
#include "model-interface/MultiRequestBatcher.hpp"
#include "model-interface/SpeculativeRuntime.hpp"
#include "model-interface/SpeculativeSequence.hpp"

using namespace qvac_lib_inference_addon_llama::batching;
using namespace qvac_lib_inference_addon_llama::speculative;

namespace {

using ConfigMap = std::unordered_map<std::string, std::string>;

SpeculativeConfig parse(ConfigMap config) {
  return parseSpeculativeConfig(config);
}

// Absolute on every platform: "/models/x" has no drive on Windows.
std::string absoluteModelPath(const char* name) {
  return (std::filesystem::temp_directory_path() / name).string();
}

// A header-only GGUF with `arch`'s widths and MTP layers (0 leaves a key out)
// and `vocab` tokens, written to a temporary file.
std::string writeHeadHeader(
    const char* name, const char* arch, uint32_t width, uint32_t widthOut,
    size_t vocab, uint32_t mtpLayers = 0) {
  gguf_context* ctx = gguf_init_empty();
  gguf_set_val_str(ctx, "general.architecture", arch);
  if (width != 0) {
    gguf_set_val_u32(
        ctx, (std::string(arch) + ".embedding_length").c_str(), width);
  }
  if (widthOut != 0) {
    gguf_set_val_u32(
        ctx, (std::string(arch) + ".embedding_length_out").c_str(), widthOut);
  }
  if (mtpLayers != 0) {
    gguf_set_val_u32(
        ctx, (std::string(arch) + ".nextn_predict_layers").c_str(), mtpLayers);
  }
  std::vector<const char*> tokens(vocab, "t");
  gguf_set_arr_str(ctx, "tokenizer.ggml.tokens", tokens.data(), tokens.size());
  const std::string path = absoluteModelPath(name);
  const bool written = gguf_write_to_file(ctx, path.c_str(), true);
  gguf_free(ctx);
  EXPECT_TRUE(written) << path;
  return path;
}

} // namespace

TEST(SpeculativeConfigTest, AbsentKeysLeaveSpeculationOff) {
  ConfigMap config{{"ctx_size", "4096"}};
  const SpeculativeConfig parsed = parseSpeculativeConfig(config);
  EXPECT_FALSE(parsed.enabled());
  // Unrelated keys stay for llama.cpp's parser.
  EXPECT_EQ(config.count("ctx_size"), 1u);
}

TEST(SpeculativeConfigTest, ParsesDraftMtpAndConsumesKeys) {
  ConfigMap config{
      {"spec-type", "draft-mtp"},
      {"spec_draft_n_max", "5"},
      {"spec-draft-n-min", "2"},
      {"spec_draft_p_min", "0.25"}};
  const SpeculativeConfig parsed = parseSpeculativeConfig(config);
  EXPECT_TRUE(parsed.enabled());
  EXPECT_EQ(parsed.type, COMMON_SPECULATIVE_TYPE_DRAFT_MTP);
  EXPECT_EQ(parsed.draftNMax, 5);
  EXPECT_EQ(parsed.draftNMin, 2);
  ASSERT_TRUE(parsed.draftPMin.has_value());
  EXPECT_FLOAT_EQ(*parsed.draftPMin, 0.25F);
  // Consumed, so llama.cpp's parser never sees them.
  EXPECT_TRUE(config.empty());
}

TEST(SpeculativeConfigTest, ParsesDraftDflashWithItsDraftModel) {
  const std::string draftPath = absoluteModelPath("dflash.gguf");
  ConfigMap config{
      {"spec_type", "draft-dflash"},
      {"spec-draft-model", draftPath},
      {"spec-draft-n-max", "15"}};
  const SpeculativeConfig parsed = parseSpeculativeConfig(config);
  EXPECT_TRUE(parsed.enabled());
  EXPECT_EQ(parsed.type, COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH);
  EXPECT_EQ(parsed.draftModelPath, draftPath);
  EXPECT_EQ(parsed.draftNMax, 15);
  EXPECT_TRUE(config.empty());
}

TEST(SpeculativeConfigTest, ParsesDraftDsparkWithItsDraftModel) {
  const std::string draftPath = absoluteModelPath("dspark.gguf");
  ConfigMap config{
      {"spec-type", "draft-dspark"},
      {"spec_draft_model", draftPath},
      {"spec-draft-n-max", "9"},
      {"spec-draft-p-min", "0.5"}};
  const SpeculativeConfig parsed = parseSpeculativeConfig(config);
  EXPECT_TRUE(parsed.enabled());
  EXPECT_EQ(parsed.type, COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK);
  EXPECT_EQ(parsed.draftModelPath, draftPath);
  EXPECT_EQ(parsed.draftNMax, 9);
  ASSERT_TRUE(parsed.draftPMin.has_value());
  EXPECT_FLOAT_EQ(*parsed.draftPMin, 0.5F);
  EXPECT_TRUE(config.empty());
}

TEST(SpeculativeConfigTest, DsparkNeedsAnAbsoluteDraftModel) {
  EXPECT_THROW(parse({{"spec-type", "draft-dspark"}}), std::invalid_argument);
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-dspark"}, {"spec-draft-model", "dspark.gguf"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-dspark"}, {"spec_draft_model", ""}}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, ParsesDraftMtpWithAnExternalHead) {
  const std::string headPath = absoluteModelPath("mtp-head.gguf");
  ConfigMap config{{"spec-type", "draft-mtp"}, {"spec_draft_model", headPath}};
  const SpeculativeConfig parsed = parseSpeculativeConfig(config);
  EXPECT_EQ(parsed.type, COMMON_SPECULATIVE_TYPE_DRAFT_MTP);
  EXPECT_EQ(parsed.draftModelPath, headPath);
  EXPECT_TRUE(config.empty());
  // The head is optional for MTP: without one the model's own layers draft.
  EXPECT_TRUE(parse({{"spec-type", "draft-mtp"}}).draftModelPath.empty());
  // It is held to the same path rules as a DFlash model.
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-model", "mtp.gguf"}}),
      std::invalid_argument);
}

// Fabric's header check, which the load and `assessFit` run before fabric
// fits or loads the head next to the model.
std::string
mtpHeadMismatch(const std::string& head, const std::string& target) {
  common_params params;
  params.speculative.types = {COMMON_SPECULATIVE_TYPE_DRAFT_MTP};
  params.speculative.draft.mparams.path = head;
  return common_speculative_draft_mismatch(params, target);
}

TEST(SpeculativeConfigTest, AnMtpHeadIsComparedAtTheWidthItDraftsFrom) {
  const std::string target2048 =
      writeHeadHeader("qwen35-target-2048.gguf", "qwen35", 2048, 0, 8);
  const std::string target1024 =
      writeHeadHeader("qwen35-target-1024.gguf", "qwen35", 1024, 0, 8);
  // A Qwen MTP head has no `embedding_length_out`; its own width is read.
  const std::string qwen =
      writeHeadHeader("qwen35-head.gguf", "qwen35", 1024, 0, 8, 1);
  EXPECT_EQ(mtpHeadMismatch(qwen, target1024), "");
  EXPECT_EQ(
      mtpHeadMismatch(qwen, target2048), "hidden width 1024, the model's 2048");
  const std::string otherVocab =
      writeHeadHeader("qwen35-head-vocab.gguf", "qwen35", 1024, 0, 16, 1);
  EXPECT_EQ(
      mtpHeadMismatch(otherVocab, target2048),
      "16 tokens, the model's 8; hidden width 1024, the model's 2048");

  // A Gemma 4 assistant runs at its own width and reads the target's hidden
  // states, whose width is in `embedding_length_out`.
  const std::string gemma = writeHeadHeader(
      "gemma4-assistant.gguf", "gemma4-assistant", 1024, 2048, 8, 4);
  EXPECT_EQ(mtpHeadMismatch(gemma, target2048), "");
  EXPECT_EQ(
      mtpHeadMismatch(gemma, target1024),
      "hidden width 2048, the model's 1024");

  // An unreadable head is left to the load, which reports it.
  EXPECT_EQ(
      mtpHeadMismatch(absoluteModelPath("no-such-head.gguf"), target1024), "");

  for (const auto& path : {target2048, target1024, qwen, otherVocab, gemma}) {
    std::filesystem::remove(path);
  }
}

TEST(SpeculativeConfigTest, DflashNeedsAnAbsoluteDraftModel) {
  EXPECT_THROW(parse({{"spec-type", "draft-dflash"}}), std::invalid_argument);
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-dflash"}, {"spec-draft-model", "dflash.gguf"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-dflash"}, {"spec_draft_model", ""}}),
      std::invalid_argument);
  // A draft model needs a speculative type.
  EXPECT_THROW(
      parse({{"spec-draft-model", "/m/d.gguf"}}), std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "none"}, {"spec-draft-model", "/m/d.gguf"}}),
      std::invalid_argument);
  // Network shares and device paths are not local files.
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-dflash"},
           {"spec-draft-model", "//host/share/d.gguf"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-dflash"},
           {"spec-draft-model", "\\\\host\\share\\d.gguf"}}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, DraftModelMustBeARegularFile) {
  EXPECT_NO_THROW(requireDraftModelFile(SpeculativeConfig{}));
  EXPECT_THROW(
      requireDraftModelFile(
          SpeculativeConfig{
              .type = COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH,
              .draftModelPath = "/nonexistent/qvac-dflash.gguf"}),
      std::invalid_argument);
  // A directory is not a model file.
  EXPECT_THROW(
      requireDraftModelFile(
          SpeculativeConfig{
              .type = COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH,
              .draftModelPath =
                  std::filesystem::temp_directory_path().string()}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, NoneIsAcceptedAndDisables) {
  EXPECT_FALSE(parse({{"spec_type", "none"}}).enabled());
}

TEST(SpeculativeConfigTest, RejectsOtherTypes) {
  EXPECT_THROW(parse({{"spec-type", "ngram-simple"}}), std::invalid_argument);
  EXPECT_THROW(parse({{"spec-type", "draft-simple"}}), std::invalid_argument);
  EXPECT_THROW(parse({{"spec-type", ""}}), std::invalid_argument);
}

TEST(SpeculativeConfigTest, RejectsBothSpellings) {
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec_type", "draft-mtp"}}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, RejectsOutOfRangeValues) {
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-n-max", "0"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-mtp"},
           {"spec-draft-n-max", std::to_string(MAX_SPEC_DRAFT_N_MAX + 1)}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-n-max", "3x"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-p-min", "1.5"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-p-min", "abc"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-p-min", ""}}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, RejectsMinAboveMax) {
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-mtp"},
           {"spec-draft-n-max", "2"},
           {"spec-draft-n-min", "3"}}),
      std::invalid_argument);
  // Against llama.cpp's default n_max when only n_min is given.
  const int32_t defaultNMax = common_params_speculative_draft{}.n_max;
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-mtp"},
           {"spec-draft-n-min", std::to_string(defaultNMax + 1)}}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, DraftOptionsNeedAType) {
  EXPECT_THROW(parse({{"spec-draft-n-max", "4"}}), std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "none"}, {"spec-draft-p-min", "0.5"}}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, ApplySizesOutputsLikeLlamaServer) {
  common_params params;
  params.n_batch = 2048;
  params.n_parallel = 4;
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_MTP, .draftNMax = 3},
      params);
  ASSERT_EQ(params.speculative.types.size(), 1u);
  EXPECT_EQ(params.speculative.types[0], COMMON_SPECULATIVE_TYPE_DRAFT_MTP);
  EXPECT_EQ(params.speculative.draft.n_max, 3);
  // A verification step reads the sample plus every draft token, per slot.
  EXPECT_EQ(params.n_outputs_max_per_seq, 4);
  EXPECT_EQ(params.n_outputs_max, 16);
  // MTP keeps recurrent-state snapshots for rolling back rejected drafts.
  EXPECT_EQ(params.speculative.need_n_rs_seq(), 3u);
}

TEST(SpeculativeConfigTest, ApplyFitsTheDraftToOneUbatch) {
  common_params params;
  params.n_batch = 2048;
  params.n_ubatch = 8;
  params.n_parallel = 1;
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_MTP,
          .draftNMax = 16,
          .draftNMin = 12},
      params);
  // The sample and the draft share one ubatch.
  EXPECT_EQ(params.speculative.draft.n_max, 7);
  EXPECT_EQ(params.speculative.draft.n_min, 7);
  EXPECT_EQ(params.n_outputs_max_per_seq, 8);
}

TEST(SpeculativeConfigTest, ApplyFitsEverySequenceDraftInOneBatch) {
  common_params params;
  params.n_batch = 64;
  params.n_ubatch = 64;
  params.n_parallel = 8;
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH,
          .draftNMax = 15,
          .draftModelPath = "/models/dflash.gguf"},
      params);
  // DFlash drafts all eight sequences in one batch of n_batch tokens.
  EXPECT_EQ(params.speculative.draft.n_max, 7);
  EXPECT_LE(
      params.n_parallel * (params.speculative.draft.n_max + 1), params.n_batch);
}

TEST(SpeculativeConfigTest, ApplyKeepsADraftThatFits) {
  common_params params;
  params.n_batch = 2048;
  params.n_ubatch = 512;
  params.n_parallel = 4;
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_MTP, .draftNMax = 7},
      params);
  EXPECT_EQ(params.speculative.draft.n_max, 7);
}

TEST(SpeculativeConfigTest, ApplyRejectsABatchWithNoRoomToDraft) {
  common_params params;
  params.n_batch = 4;
  params.n_ubatch = 4;
  params.n_parallel = 4;
  EXPECT_THROW(
      applySpeculativeConfig(
          SpeculativeConfig{.type = COMMON_SPECULATIVE_TYPE_DRAFT_MTP}, params),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, ApplyLeavesParamsAloneWhenOff) {
  common_params params;
  const auto outputsMax = params.n_outputs_max;
  const auto outputsPerSeq = params.n_outputs_max_per_seq;
  applySpeculativeConfig(SpeculativeConfig{}, params);
  ASSERT_EQ(params.speculative.types.size(), 1u);
  EXPECT_EQ(params.speculative.types[0], COMMON_SPECULATIVE_TYPE_NONE);
  EXPECT_EQ(params.n_outputs_max, outputsMax);
  EXPECT_EQ(params.n_outputs_max_per_seq, outputsPerSeq);
}

TEST(SpeculativeConfigTest, FitCountsTheMtpContextLikeTheLoad) {
  common_params params;
  EXPECT_EQ(SpeculativeFitModel::create(params), nullptr);

  params.model.path = "/models/target.gguf";
  applySpeculativeConfig(
      SpeculativeConfig{.type = COMMON_SPECULATIVE_TYPE_DRAFT_MTP}, params);
  const auto fit = SpeculativeFitModel::create(params);
  ASSERT_NE(fit, nullptr);
  const common_fit_extra_model* extra = fit->extra();
  // The MTP context runs on the target's own weights.
  EXPECT_TRUE(extra->shares_model);
  EXPECT_STREQ(extra->path_model, "/models/target.gguf");
  EXPECT_EQ(extra->cparams->ctx_type, LLAMA_CONTEXT_TYPE_MTP);
  EXPECT_EQ(extra->cparams->n_rs_seq, 0u);
}

TEST(SpeculativeConfigTest, ApplyPlacesTheDraftModelLikeTheTarget) {
  common_params params;
  params.n_gpu_layers = 12;
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH,
          .draftModelPath = "/models/dflash.gguf"},
      params);
  ASSERT_EQ(params.speculative.types.size(), 1u);
  EXPECT_EQ(params.speculative.types[0], COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH);
  EXPECT_TRUE(params.speculative.has_dft());
  EXPECT_EQ(params.speculative.draft.mparams.path, "/models/dflash.gguf");
  EXPECT_EQ(params.speculative.draft.n_gpu_layers, 12);
}

TEST(SpeculativeConfigTest, FitCountsTheDflashModelOnItsOwn) {
  common_params params;
  params.model.path = "/models/target.gguf";
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH,
          .draftModelPath = "/models/dflash.gguf"},
      params);
  const auto fit = SpeculativeFitModel::create(params);
  ASSERT_NE(fit, nullptr);
  const common_fit_extra_model* extra = fit->extra();
  // The draft model has weights of its own and a plain context.
  EXPECT_FALSE(extra->shares_model);
  EXPECT_STREQ(extra->path_model, "/models/dflash.gguf");
  EXPECT_NE(extra->cparams->ctx_type, LLAMA_CONTEXT_TYPE_MTP);
  EXPECT_FALSE(fit->isMtp());
  EXPECT_EQ(extra->cparams->n_rs_seq, 0u);
}

TEST(SpeculativeConfigTest, FitCountsTheDsparkModelOnItsOwn) {
  common_params params;
  params.model.path = "/models/target.gguf";
  params.n_gpu_layers = 12;
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK,
          .draftModelPath = "/models/dspark.gguf"},
      params);
  EXPECT_EQ(params.speculative.types[0], COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK);
  // Placed like the target, as llama-server's -md.
  EXPECT_EQ(params.speculative.draft.mparams.path, "/models/dspark.gguf");
  EXPECT_EQ(params.speculative.draft.n_gpu_layers, 12);
  const auto fit = SpeculativeFitModel::create(params);
  ASSERT_NE(fit, nullptr);
  const common_fit_extra_model* extra = fit->extra();
  EXPECT_FALSE(extra->shares_model);
  EXPECT_STREQ(extra->path_model, "/models/dspark.gguf");
  EXPECT_FALSE(fit->isMtp());
}

TEST(SpeculativeConfigTest, FitCountsAnExternalMtpHeadOnItsOwn) {
  common_params params;
  params.model.path = "/models/target.gguf";
  params.n_gpu_layers = 12;
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_MTP,
          .draftModelPath = "/models/mtp-head.gguf"},
      params);
  // Placed like the target, as llama-server's -md.
  EXPECT_EQ(params.speculative.draft.mparams.path, "/models/mtp-head.gguf");
  EXPECT_EQ(params.speculative.draft.n_gpu_layers, 12);
  const auto fit = SpeculativeFitModel::create(params);
  ASSERT_NE(fit, nullptr);
  const common_fit_extra_model* extra = fit->extra();
  // An MTP context on the head's own weights, as fabric's load fits it.
  EXPECT_FALSE(extra->shares_model);
  EXPECT_STREQ(extra->path_model, "/models/mtp-head.gguf");
  EXPECT_EQ(extra->cparams->ctx_type, LLAMA_CONTEXT_TYPE_MTP);
  EXPECT_TRUE(fit->isMtp());
  EXPECT_EQ(extra->cparams->n_rs_seq, 0u);
}

namespace {

// Device handles are only compared, never dereferenced.
ggml_backend_dev_t fakeDevice(size_t index) {
  static std::array<char, 3> handles{};
  return reinterpret_cast<ggml_backend_dev_t>(&handles.at(index));
}

common_device_memory_data
memoryRow(size_t model, size_t context, size_t compute) {
  return {
      .total = 0,
      .free = 0,
      .model = model,
      .context = context,
      .compute = compute};
}

void expectRow(
    const common_device_memory_data& row, size_t model, size_t context,
    size_t compute) {
  EXPECT_EQ(row.model, model);
  EXPECT_EQ(row.context, context);
  EXPECT_EQ(row.compute, compute);
}

} // namespace

namespace {

// A header-only GGUF built by `fill`, which sets keys on the gguf context and
// creates tensors (metadata only) in the ggml context.
using GgufFill = std::function<void(gguf_context*, ggml_context*)>;

void addTensor(gguf_context* ctx, ggml_context* meta, const char* name) {
  ggml_tensor* tensor = ggml_new_tensor_1d(meta, GGML_TYPE_F32, 4);
  ggml_set_name(tensor, name);
  gguf_add_tensor(ctx, tensor);
}

std::string writeGguf(const char* name, const GgufFill& fill) {
  gguf_context* ctx = gguf_init_empty();
  ggml_init_params init{
      .mem_size = 8 * ggml_tensor_overhead(),
      .mem_buffer = nullptr,
      .no_alloc = true};
  ggml_context* meta = ggml_init(init);
  fill(ctx, meta);
  const std::string path = absoluteModelPath(name);
  EXPECT_TRUE(gguf_write_to_file(ctx, path.c_str(), true)) << path;
  gguf_free(ctx);
  ggml_free(meta);
  return path;
}

// The type `auto` resolves for the file `fill` writes, or NONE when the
// load would fail with InvalidArgument.
common_speculative_type autoType(const char* name, const GgufFill& fill) {
  const std::string path = writeGguf(name, fill);
  common_params params;
  common_speculative_type type = COMMON_SPECULATIVE_TYPE_NONE;
  try {
    applySpeculativeConfig(
        SpeculativeConfig{.autoDetect = true, .draftModelPath = path}, params);
    type = params.speculative.types[0];
  } catch (const std::invalid_argument&) {
  }
  std::filesystem::remove(path);
  return type;
}

} // namespace

TEST(SpeculativeAutoTest, ResolvesTheTypeBeforeTheLoad) {
  EXPECT_EQ(
      autoType(
          "auto-dspark.gguf",
          [](gguf_context* ctx, ggml_context* m) {
            gguf_set_val_str(ctx, "general.architecture", "dflash");
            addTensor(ctx, m, "markov_w1.weight");
          }),
      COMMON_SPECULATIVE_TYPE_DRAFT_DSPARK);
  EXPECT_EQ(
      autoType(
          "auto-dflash.gguf",
          [](gguf_context* ctx, ggml_context*) {
            gguf_set_val_str(ctx, "general.architecture", "dflash");
          }),
      COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH);
  EXPECT_EQ(
      autoType(
          "auto-mtp.gguf",
          [](gguf_context* ctx, ggml_context* m) {
            gguf_set_val_str(ctx, "general.architecture", "qwen35");
            gguf_set_val_u32(ctx, "qwen35.block_count", 3);
            addTensor(ctx, m, "blk.2.nextn.eh_proj.weight");
          }),
      COMMON_SPECULATIVE_TYPE_DRAFT_MTP);
}

TEST(SpeculativeAutoTest, NoTypeFailsTheLoadInsteadOfAborting) {
  // A plain model has nothing to draft with.
  EXPECT_EQ(
      autoType(
          "auto-plain.gguf",
          [](gguf_context* ctx, ggml_context*) {
            gguf_set_val_str(ctx, "general.architecture", "llama");
            gguf_set_val_u32(ctx, "llama.block_count", 2);
          }),
      COMMON_SPECULATIVE_TYPE_NONE);
  // fabric's detection asserted on a missing or non-u32 block_count.
  EXPECT_EQ(
      autoType(
          "auto-no-block-count.gguf",
          [](gguf_context* ctx, ggml_context*) {
            gguf_set_val_str(ctx, "general.architecture", "qwen35");
          }),
      COMMON_SPECULATIVE_TYPE_NONE);
  EXPECT_EQ(
      autoType(
          "auto-block-count-u16.gguf",
          [](gguf_context* ctx, ggml_context*) {
            gguf_set_val_str(ctx, "general.architecture", "qwen35");
            gguf_set_val_u16(ctx, "qwen35.block_count", 3);
          }),
      COMMON_SPECULATIVE_TYPE_NONE);
  common_params params;
  EXPECT_THROW(
      applySpeculativeConfig(
          SpeculativeConfig{
              .autoDetect = true,
              .draftModelPath = absoluteModelPath("auto-missing.gguf")},
          params),
      std::invalid_argument);
  // Speculation stays off in the params it could not resolve for.
  EXPECT_EQ(params.speculative.types[0], COMMON_SPECULATIVE_TYPE_NONE);
}

TEST(SpeculativeAutoTest, AutoNeedsADraftModel) {
  EXPECT_THROW(parse({{"spec-type", "auto"}}), std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "auto"}, {"spec-draft-model", "d.gguf"}}),
      std::invalid_argument);
  const SpeculativeConfig parsed = parse(
      {{"spec-type", "auto"},
       {"spec-draft-model", absoluteModelPath("d.gguf")},
       {"spec-draft-p-min", "0.5"}});
  EXPECT_TRUE(parsed.autoDetect);
  EXPECT_TRUE(parsed.enabled());
  EXPECT_EQ(parsed.type, COMMON_SPECULATIVE_TYPE_NONE);
}

TEST(SpeculativeFitMemoryTest, DraftRowsAddToTheTargetRowOfTheirDevice) {
  const std::vector<ggml_backend_dev_t> devices{fakeDevice(0), fakeDevice(1)};
  common_device_memory_data_vec breakdown{
      memoryRow(100, 10, 1), memoryRow(200, 20, 2), memoryRow(300, 30, 3)};
  // The draft side runs on the second device and on one the target does not
  // use, listed in another order.
  const std::vector<ggml_backend_dev_t> draftDevices{
      fakeDevice(1), fakeDevice(2)};
  const common_device_memory_data_vec measured{
      memoryRow(5, 6, 7), memoryRow(50, 60, 70), memoryRow(8, 9, 10)};
  ASSERT_TRUE(addDraftMemory(devices, breakdown, draftDevices, measured, true));
  expectRow(breakdown[0], 100, 10, 1);
  expectRow(breakdown[1], 205, 26, 9);
  // The host row is added whole.
  expectRow(breakdown[2], 308, 39, 13);
}

TEST(SpeculativeFitMemoryTest, SharedWeightsAreLeftOut) {
  const std::vector<ggml_backend_dev_t> devices{fakeDevice(0)};
  common_device_memory_data_vec breakdown{
      memoryRow(100, 10, 1), memoryRow(300, 30, 3)};
  const common_device_memory_data_vec measured{
      memoryRow(100, 4, 5), memoryRow(300, 6, 7)};
  // An MTP context on the target's own layers: its weights are the target's.
  ASSERT_TRUE(addDraftMemory(devices, breakdown, devices, measured, false));
  expectRow(breakdown[0], 100, 14, 6);
  expectRow(breakdown[1], 300, 36, 10);
}

TEST(SpeculativeFitMemoryTest, RowsWithoutAHostRowAreRefused) {
  const std::vector<ggml_backend_dev_t> devices{fakeDevice(0)};
  common_device_memory_data_vec breakdown{
      memoryRow(100, 10, 1), memoryRow(300, 30, 3)};
  // A draft measurement missing its host row.
  EXPECT_FALSE(
      addDraftMemory(devices, breakdown, devices, {memoryRow(1, 1, 1)}, true));
  // A target breakdown missing its host row.
  common_device_memory_data_vec noHostRow{memoryRow(100, 10, 1)};
  EXPECT_FALSE(addDraftMemory(
      devices,
      noHostRow,
      devices,
      {memoryRow(1, 1, 1), memoryRow(1, 1, 1)},
      true));
  expectRow(breakdown[0], 100, 10, 1);
  expectRow(breakdown[1], 300, 30, 3);
  expectRow(noHostRow[0], 100, 10, 1);
}

TEST(SpeculativeSequenceTest, MaxDraftLeavesRoomAndRespectsBudget) {
  // Window: two positions stay free (the sample and one spare).
  EXPECT_EQ(SpeculativeSequence::maxDraft(100, 90, -1), 8);
  EXPECT_EQ(SpeculativeSequence::maxDraft(100, 98, -1), 0);
  // Budget: the sample takes one of the remaining tokens.
  EXPECT_EQ(SpeculativeSequence::maxDraft(100, 10, 4), 3);
  EXPECT_EQ(SpeculativeSequence::maxDraft(100, 10, 1), 0);
}

TEST(SpeculativeSequenceTest, UnboundSequenceNeverDrafts) {
  SpeculativeSequence sequence;
  EXPECT_FALSE(sequence.enabled());
  EXPECT_FALSE(sequence.prepareDraft(4, 10, 42, {}));
  EXPECT_FALSE(sequence.hasDraft());
}

namespace {

/// One slot at the generation phase: prompt {10, 11} decoded, first token
/// 50 sampled and not fed yet.
struct GeneratingSlot {
  static constexpr unsigned kMaxChunk = 8;
  static constexpr unsigned kMaxTokens = 100;

  MultiRequestBatcher batcher{kMaxChunk, kMaxTokens, 2};
  LlamaBatch batch{kMaxChunk * 2, 0, 2};
  uint32_t seqId = 0;

  GeneratingSlot() {
    EXPECT_EQ(
        batcher.addRequest({10, 11}, seqId),
        MultiRequestBatcher::AddStatus::Ok);
    EXPECT_EQ(batcher.fillBatch(batch).totalTokens, 2u);
    batcher.advance();
    batcher.sampleAndAppendIdle([](uint32_t, int) { return 50; });
  }

  [[nodiscard]] const Request& req() const { return *batcher.requestAt(seqId); }
};

} // namespace

TEST(SpeculativeBatcherTest, FeedsSampleAndDraftWithLogitsOnEach) {
  GeneratingSlot slot;
  slot.batcher.setDraft(slot.seqId, {51, 52, 53});
  const auto result = slot.batcher.fillBatch(slot.batch);
  EXPECT_EQ(result.totalTokens, 4u);
  EXPECT_EQ(result.decodeTokens, 4u);
  EXPECT_FALSE(slot.batcher.draftDropped(slot.seqId));

  const llama_batch& lBatch = *slot.batch;
  ASSERT_EQ(lBatch.n_tokens, 4);
  const std::vector<llama_token> expected{50, 51, 52, 53};
  for (int i = 0; i < 4; i++) {
    EXPECT_EQ(lBatch.token[i], expected[i]);
    EXPECT_EQ(lBatch.pos[i], 2 + i);
    EXPECT_EQ(lBatch.logits[i], 1);
    EXPECT_EQ(lBatch.seq_id[i][0], static_cast<llama_seq_id>(slot.seqId));
  }
  EXPECT_EQ(slot.req().draftLogitStart, 0);
  EXPECT_EQ(slot.req().draftBasePos, 2);
}

TEST(SpeculativeBatcherTest, VerifiedTokensAreCountedAndLastIsUnfed) {
  GeneratingSlot slot;
  slot.batcher.setDraft(slot.seqId, {51, 52, 53});
  (void)slot.batcher.fillBatch(slot.batch);
  slot.batcher.advance();
  EXPECT_EQ(slot.req().currentPos, 6);

  int seenFirst = -1;
  llama_pos seenBase = -1;
  slot.batcher.verifyDrafted([&](uint32_t, int first, llama_pos base) {
    seenFirst = first;
    seenBase = base;
    // Two drafts accepted plus the target's own next token; the rejected
    // third draft is trimmed, so memory ends after 50, 51, 52.
    return MultiRequestBatcher::DraftOutcome{
        .newPos = 5, .tokens = {51, 52, 60}};
  });
  EXPECT_EQ(seenFirst, 0);
  EXPECT_EQ(seenBase, 2);
  const Request& req = slot.req();
  EXPECT_EQ(req.currentPos, 5);
  EXPECT_EQ(req.generatedTokens, (std::vector<llama_token>{50, 51, 52, 60}));
  EXPECT_TRUE(req.hasUnfedSample);
  EXPECT_TRUE(req.draftTokens.empty());
  EXPECT_EQ(req.draftLogitStart, -1);

  // The verified slot is not sampled again; the next step feeds 60 alone.
  int sampled = 0;
  slot.batcher.sampleAndAppendIdle([&](uint32_t, int) {
    ++sampled;
    return 70;
  });
  EXPECT_EQ(sampled, 0);
  (void)slot.batcher.fillBatch(slot.batch);
  ASSERT_EQ((*slot.batch).n_tokens, 1);
  EXPECT_EQ((*slot.batch).token[0], 60);
  EXPECT_EQ((*slot.batch).pos[0], 5);
}

TEST(SpeculativeBatcherTest, ReplayFeedsTheSampleAndDraftAgain) {
  GeneratingSlot slot;
  slot.batcher.setDraft(slot.seqId, {51, 52});
  (void)slot.batcher.fillBatch(slot.batch);
  slot.batcher.advance();
  slot.batcher.verifyDrafted([](uint32_t, int, llama_pos base) {
    return MultiRequestBatcher::DraftOutcome{
        .replay = true, .draft = {51, 61}, .newPos = base};
  });
  const Request& req = slot.req();
  EXPECT_EQ(req.currentPos, 2);
  EXPECT_EQ(req.generatedTokens, (std::vector<llama_token>{50}));
  EXPECT_TRUE(req.hasUnfedSample);

  (void)slot.batcher.fillBatch(slot.batch);
  const llama_batch& lBatch = *slot.batch;
  ASSERT_EQ(lBatch.n_tokens, 3);
  EXPECT_EQ(lBatch.token[0], 50);
  EXPECT_EQ(lBatch.token[1], 51);
  EXPECT_EQ(lBatch.token[2], 61);
  EXPECT_EQ(lBatch.pos[0], 2);
}

TEST(SpeculativeBatcherTest, TerminalTokenIsNotCountedUnlessPredictionLimit) {
  {
    GeneratingSlot slot;
    slot.batcher.setDraft(slot.seqId, {51, 52});
    (void)slot.batcher.fillBatch(slot.batch);
    slot.batcher.advance();
    slot.batcher.verifyDrafted([](uint32_t, int, llama_pos) {
      return MultiRequestBatcher::DraftOutcome{
          .newPos = 4, .tokens = {51, 2}, .finished = true};
    });
    EXPECT_EQ(slot.req().generatedTokens, (std::vector<llama_token>{50, 51}));
    EXPECT_EQ(slot.req().stopReason, StopReason::Finished);
    EXPECT_FALSE(slot.req().hasUnfedSample);
  }
  {
    GeneratingSlot slot;
    slot.batcher.setDraft(slot.seqId, {51, 52});
    (void)slot.batcher.fillBatch(slot.batch);
    slot.batcher.advance();
    slot.batcher.verifyDrafted([](uint32_t, int, llama_pos) {
      return MultiRequestBatcher::DraftOutcome{
          .newPos = 4,
          .tokens = {51, 52},
          .finished = true,
          .stopReason = StopReason::PredictionLimit};
    });
    EXPECT_EQ(
        slot.req().generatedTokens, (std::vector<llama_token>{50, 51, 52}));
    EXPECT_EQ(slot.req().stopReason, StopReason::PredictionLimit);
  }
  {
    // A full window stops before the next token: 51 was streamed, nothing
    // after it was, so 51 is counted.
    GeneratingSlot slot;
    slot.batcher.setDraft(slot.seqId, {51, 52});
    (void)slot.batcher.fillBatch(slot.batch);
    slot.batcher.advance();
    slot.batcher.verifyDrafted([](uint32_t, int, llama_pos) {
      return MultiRequestBatcher::DraftOutcome{
          .newPos = 4,
          .tokens = {51},
          .finished = true,
          .stopReason = StopReason::ContextOverflow};
    });
    EXPECT_EQ(slot.req().generatedTokens, (std::vector<llama_token>{50, 51}));
    EXPECT_EQ(slot.req().stopReason, StopReason::ContextOverflow);
  }
}

TEST(SpeculativeBatcherTest, DraftWithoutRoomIsDropped) {
  constexpr unsigned kMaxChunk = 8;
  MultiRequestBatcher batcher(kMaxChunk, 100, 2);
  // Room for three tokens: both slots get at least one, the draft does not
  // fit whole.
  LlamaBatch prefillBatch(kMaxChunk * 2, 0, 2);
  LlamaBatch tightBatch(3, 0, 2);
  uint32_t seqA = 0;
  uint32_t seqB = 0;
  ASSERT_EQ(batcher.addRequest({10}, seqA), MultiRequestBatcher::AddStatus::Ok);
  ASSERT_EQ(batcher.addRequest({20}, seqB), MultiRequestBatcher::AddStatus::Ok);
  (void)batcher.fillBatch(prefillBatch);
  batcher.advance();
  batcher.sampleAndAppendIdle(
      [](uint32_t seqId, int) { return static_cast<llama_token>(50 + seqId); });

  batcher.setDraft(seqA, {60, 61, 62});
  const auto result = batcher.fillBatch(tightBatch);
  EXPECT_TRUE(batcher.draftDropped(seqA));
  EXPECT_FALSE(batcher.draftDropped(seqB));
  EXPECT_EQ(batcher.chunkSizeFor(seqA), 1u);
  EXPECT_EQ(batcher.chunkSizeFor(seqB), 1u);
  EXPECT_EQ(result.totalTokens, 2u);
  EXPECT_EQ(result.decodeTokens, 2u);
  EXPECT_EQ(batcher.requestAt(seqA)->draftLogitStart, -1);
  EXPECT_TRUE(batcher.requestAt(seqA)->draftTokens.empty());
}

TEST(SpeculativeStatsTest, AddSumsCountersAndPositions) {
  SpeculativeStats total;
  SpeculativeStats one{
      .draftTokens = 6,
      .draftAccepted = 4,
      .verifySteps = 2,
      .acceptedPerPos = {2, 2}};
  SpeculativeStats two{
      .draftTokens = 3,
      .draftAccepted = 3,
      .verifySteps = 1,
      .acceptedPerPos = {1, 1, 1}};
  total.add(one);
  total.add(two);
  EXPECT_EQ(total.draftTokens, 9u);
  EXPECT_EQ(total.draftAccepted, 7u);
  EXPECT_EQ(total.verifySteps, 3u);
  EXPECT_EQ(total.acceptedPerPos, (std::vector<uint64_t>{3, 3, 1}));
}
