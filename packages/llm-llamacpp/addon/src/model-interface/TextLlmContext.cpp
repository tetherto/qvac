#include "TextLlmContext.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <filesystem>
#include <system_error>

#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "ContextSlider.hpp"
#include "GenerationParamsApply.hpp"
#include "addon/LlmErrors.hpp"
#include "common/common.h"
#include "common/log.h"
#include "inference-addon-cpp/Logger.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ReasoningUtils.hpp"
#include "utils/ScopeGuard.hpp"

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::utils;

namespace {

bool isFileInitialized(const std::filesystem::path& path) {
  std::error_code errorCode;
  const auto size = std::filesystem::file_size(path, errorCode);
  return !errorCode && size != 0;
}

} // namespace

// NOLINTNEXTLINE(readability-identifier-naming,readability-function-cognitive-complexity)
// NOLINTNEXTLINE(readability-function-cognitive-complexity)

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TextLlmContext::TextLlmContext(
    common_params& commonParams, common_init_result_ptr llamaInit,
    ToolsCompactController& tools)
    : tools_(tools), llamaInit_(std::move(llamaInit)), params_(commonParams) {
  modelCtx_.model = llamaInit_->model();
  modelCtx_.lctx = llamaInit_->context();
  initializeCommonState();
  initializeOwnedThreadpools();
}

TextLlmContext::TextLlmContext(
    const common_params& commonParams, const LlmModelContext& shared,
    ToolsCompactController& tools, llama_seq_id seqId,
    llama_pos perSeqCtxCeiling)
    : tools_(tools), modelCtx_(shared), params_(commonParams),
      perSeqCtxCeiling_(perSeqCtxCeiling) {
  seqId_ = seqId;
  initializeCommonState();
}

llama_pos TextLlmContext::ctxCeiling() const {
  return perSeqCtxCeiling_ > 0
             ? perSeqCtxCeiling_
             : static_cast<llama_pos>(llama_n_ctx(modelCtx_.lctx));
}

void TextLlmContext::initializeCommonState() {
  if (modelCtx_.model == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadModel), "Failed to initialize model");
  }

  if (modelCtx_.lctx == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadModel), "Failed to initialize context");
  }

  if (modelCtx_.vocab == nullptr) {
    modelCtx_.vocab = llama_model_get_vocab(modelCtx_.model);
  }

  // `llama_model_is_recurrent` only flags fully-recurrent models (Mamba,
  // RWKV). Hybrid SSM + attention models like Qwen3.5 — where the SSM
  // layers still carry recurrent state — return false from that
  // predicate but exhibit the same post-shift state contamination. Use
  // direct metadata probing: any `<arch>.ssm.*` key indicates SSM layers
  // in the model.
  hasRecurrentMemory_ = llama_model_is_recurrent(modelCtx_.model);
  if (!hasRecurrentMemory_) {
    const std::optional<std::string> arch =
        qvac_lib_inference_addon_llama::utils::getModelArchitecture(
            modelCtx_.model);
    if (arch.has_value()) {
      const std::string ssmKey = arch.value() + ".ssm.state_size";
      char buffer[32] = {0};
      if (llama_model_meta_val_str(
              modelCtx_.model, ssmKey.c_str(), buffer, sizeof(buffer)) > 0) {
        hasRecurrentMemory_ = true;
      }
    }
  }
  // EOS-inside-reasoning recovery (close-marker substitution +
  // trailing newlines) is a Qwen3-specific workaround. Gate it on the
  // explicit Qwen3-family predicate so the policy is documented at the
  // call site and cannot drift if `selectReasoningTagsForArchitecture`
  // is later extended to cover non-Qwen families. Other families with
  // a recognised channel (e.g. Gemma 4) still get detection / span
  // tracking / compaction via `reasoningEnabled_`, just not this
  // recovery.
  {
    const std::optional<std::string> arch =
        qvac_lib_inference_addon_llama::utils::getModelArchitecture(
            modelCtx_.model);
    isQwen3ReasoningFamily_ =
        arch.has_value() &&
        qvac_lib_inference_addon_llama::utils::
            isQwen3ReasoningFamilyArchitecture(arch.value());
  }
  isHarmonyModel_ =
      qvac_lib_inference_addon_llama::utils::isHarmonyModel(modelCtx_.model);
  if (isHarmonyModel_) {
    harmonyCallToken_ =
        qvac_lib_inference_addon_llama::utils::getHarmonyCallToken(
            modelCtx_.lctx);
    if (harmonyCallToken_ == LLAMA_TOKEN_NULL) {
      isHarmonyModel_ = false;
    }
  }
  QLOG_IF(
      Priority::DEBUG,
      string_format(
          "[TextLlm] Harmony detection: isHarmony=%d callToken=%d "
          "useJinja=%d\n",
          isHarmonyModel_,
          harmonyCallToken_,
          params_.use_jinja));

  const std::string chatTemplate =
      getChatTemplate(modelCtx_.model, params_, tools_.enabled());
  tmpls_ = common_chat_templates_init(modelCtx_.model, chatTemplate);

  smpl_.reset(common_sampler_init(modelCtx_.model, params_.sampling));
  if (!smpl_) {
    std::string errorMsg = string_format(
        "[TextLlm] %s: failed to initialize sampling subsystem\n", __func__);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToCreateSamplingSystem), errorMsg);
  }

  if (!llama_model_has_encoder(modelCtx_.model) &&
      llama_vocab_get_add_eos(modelCtx_.vocab)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "For decoder-only models, should NOT automatically add EOS tokens");
  }

  const int gaN = params_.grp_attn_n;
  const int gaW = params_.grp_attn_w;
  if (gaN != 1) {
    if (gaN <= 0) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          "grp_attn_n must be positive");
    }
    if (gaW % gaN != 0) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          "grp_attn_w must be a multiple of grp_attn_n");
    }
  }

  for (const std::string& antiprompt : params_.antiprompt) {
    auto ids = ::common_tokenize(modelCtx_.lctx, antiprompt, false, true);
    if (ids.size() == 1) {
      antipromptTokens_.push_back(ids[0]);
    }
  }
}

void TextLlmContext::initializeOwnedThreadpools() {
  auto* cpuDev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (cpuDev == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID, toString(NoCpuBackendFound), "no CPU backend found");
  }

  auto* reg = ggml_backend_dev_backend_reg(cpuDev);
  void* procAddr =
      ggml_backend_reg_get_proc_address(reg, "ggml_threadpool_new");
  if (procAddr == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToCreateThreadPool),
        "Failed to get ggml_threadpool_new function address");
  }
  // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
  auto* ggmlThreadpoolNewFn =
      reinterpret_cast<decltype(ggml_threadpool_new)*>(procAddr);

  struct ggml_threadpool_params tppBatch =
      ggml_threadpool_params_from_cpu_params(params_.cpuparams_batch);
  struct ggml_threadpool_params tpp =
      ggml_threadpool_params_from_cpu_params(params_.cpuparams_batch);

  set_process_priority(params_.cpuparams_batch.priority);

  if (!ggml_threadpool_params_match(&tpp, &tppBatch)) {
    threadpoolBatch_.reset(ggmlThreadpoolNewFn(&tppBatch));
    if (!threadpoolBatch_) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToCreateThreadPool),
          "batch threadpool create failed");
    }
    tpp.paused = true;
  }

  threadpool_.reset(ggmlThreadpoolNewFn(&tpp));
  if (!threadpool_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToCreateThreadPool),
        "threadpool create failed");
  }
  llama_attach_threadpool(
      modelCtx_.lctx, threadpool_.get(), threadpoolBatch_.get());

  QLOG_IF(Priority::DEBUG, [&]() {
    return string_format(
        "[TextLlm] %s\n", common_params_get_system_info(params_).c_str());
  }());
}

bool TextLlmContext::checkAntiprompt() {
  if (!params_.antiprompt.empty()) {
    constexpr int kNPrev = 32;
    std::string lastOutput =
        common_sampler_prev_str(smpl_.get(), modelCtx_.lctx, kNPrev);

    // Check if each of the reverse prompts appears anywhere in the recent
    // output. We search the full kNPrev-token window because a single token
    // can decode to many characters, and a short antiprompt like "\n" may
    // appear at the start of such a token, far from the string's tail.
    // Matching is case-insensitive so callers don't have to list every
    // casing variant the model might emit.
    std::string lastOutputLower = lastOutput;
    std::transform(
        lastOutputLower.begin(),
        lastOutputLower.end(),
        lastOutputLower.begin(),
        [](unsigned char c) { return std::tolower(c); });
    for (const std::string& antiprompt : params_.antiprompt) {
      std::string antipromptLower = antiprompt;
      std::transform(
          antipromptLower.begin(),
          antipromptLower.end(),
          antipromptLower.begin(),
          [](unsigned char c) { return std::tolower(c); });
      if (lastOutputLower.find(antipromptLower) != std::string::npos) {
        return true;
      }
    }

    // check for reverse prompt using special tokens
    llama_token lastToken = common_sampler_last(smpl_.get());
    for (auto token : antipromptTokens_) {
      if (token == lastToken) {
        return true;
      }
    }
  }
  return false;
}
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void TextLlmContext::tokenizeChat(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools,
    std::vector<llama_token>& inputTokens, bool isCacheLoaded) {
  if (chatMsgs.empty()) {
    std::string errorMsg =
        string_format("[TextLlm] %s: no chat messages provided\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }

  std::string prompt;
  common_chat_templates_inputs inputs;

  bool isLastMessageFromUser = false;
  bool addSpecial = false;

  if (nPast_ == 0 && !isCacheLoaded) {
    tools_.reset();
    const auto& lastRole = chatMsgs.back().role;
    isLastMessageFromUser = lastRole == "user" || lastRole == "tool";
    addSpecial = true;
  } else if (nPast_ > 0) {
    isLastMessageFromUser =
        chatMsgs.back().role == "user" || chatMsgs.back().role == "tool";
    common_sampler_reset(smpl_.get());
    addSpecial = false;
  }

  inputs.use_jinja = params_.use_jinja;
  inputs.enable_thinking = params_.reasoning_budget != 0;
  inputs.messages = chatMsgs;
  inputs.add_generation_prompt = isLastMessageFromUser;

  if (!tools.empty()) {
    inputs.tools = tools;
  }
  std::string thinkingStartTag;
  std::string thinkingEndTag;
  std::string generationPrompt;
  prompt = getPrompt(
      tmpls_.get(),
      inputs,
      &thinkingForcedOpen_,
      &thinkingStartTag,
      &thinkingEndTag,
      &generationPrompt);
  thinkingForcedOpenText_ =
      thinkingForcedOpen_
          ? getThinkingForcedOpenText(generationPrompt, thinkingStartTag)
          : std::string{};
  configureReasoningTags(
      thinkingStartTag, thinkingEndTag, thinkingForcedOpenText_);
  if (configureReasoningBudgetSampling(
          params_,
          modelCtx_.lctx,
          thinkingStartTag,
          thinkingEndTag,
          generationPrompt)) {
    smpl_.reset(common_sampler_init(modelCtx_.model, params_.sampling));
    if (!smpl_) {
      std::string errorMsg = string_format(
          "[TextLlm] %s: failed to initialize sampling subsystem\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(UnableToCreateSamplingSystem), errorMsg);
    }
  }

  QLOG_IF(
      Priority::DEBUG,
      string_format(
          "[TextLlm] tokenizeChat: nPast=%d lastRole=%s "
          "nMsgs=%zu nTools=%zu addGenPrompt=%d\n",
          nPast_,
          chatMsgs.empty() ? "empty" : chatMsgs.back().role.c_str(),
          chatMsgs.size(),
          tools.size(),
          inputs.add_generation_prompt));
  QLOG_IF(
      Priority::DEBUG,
      string_format("[TextLlm] formatted prompt: %s\n", prompt.c_str()));

  if (!prompt.empty()) {
    inputTokens = common_tokenize(modelCtx_.lctx, prompt, addSpecial, true);

    if (tools_.enabled() && !tools.empty()) {
      inputs.tools = {};
      inputs.add_generation_prompt = false;
      inputs.use_jinja = params_.use_jinja;
      inputs.enable_thinking = params_.reasoning_budget != 0;
      auto promptNoTools = getPrompt(tmpls_.get(), inputs);
      auto tokensNoTools =
          common_tokenize(modelCtx_.lctx, promptNoTools, addSpecial, true);
      tools_.onTokenize(inputTokens.size(), tokensNoTools.size());
    } else {
      tools_.onTokenize(inputTokens.size(), 0);
    }
  } else {
    std::string errorMsg = string_format(
        "[TextLlm] %s: formatted chat prompt is empty\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }

  if (inputTokens.empty()) {
    std::string errorMsg =
        string_format("[TextLlm] %s: tokenized input is empty\n", __func__);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(EmptyTokenizedInput), errorMsg);
  }

  // Encode the input if model has encoder
  if (llama_model_has_encoder(modelCtx_.model) && nPast_ == 0 &&
      !isCacheLoaded) {
    int encInputSize = static_cast<int>(inputTokens.size());
    llama_token* encInputBuf = inputTokens.data();

    if (llama_encode(
            modelCtx_.lctx, llama_batch_get_one(encInputBuf, encInputSize)) !=
        0) {
      std::string errorMsg =
          string_format("[TextLlm] %s : failed to eval encoder\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(EncoderFailed), errorMsg);
    }

    llama_token decoderStartTokenId =
        llama_model_decoder_start_token(modelCtx_.model);
    if (decoderStartTokenId == LLAMA_TOKEN_NULL) {
      decoderStartTokenId = llama_vocab_bos(modelCtx_.vocab);
    }

    inputTokens.clear();
    inputTokens.push_back(decoderStartTokenId);
  }
};

bool TextLlmContext::evalMessage(
    const std::vector<common_chat_msg>& chatMsgs, bool isCacheLoaded,
    bool prefill) {
  return evalMessageWithTools(chatMsgs, {}, isCacheLoaded, prefill);
}

bool TextLlmContext::evalMessageWithTools(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, bool isCacheLoaded,
    bool prefill) {
  const std::vector<llama_token> inputTokens =
      preparePrefill(chatMsgs, tools, {}, {}, isCacheLoaded, prefill).tokens;
  const auto nTokens = static_cast<llama_pos>(inputTokens.size());
  LlamaBatch textBatch(params_.n_batch, 0, 1);

  llama_pos count = nPast_;
  llama_pos tokenIndex = 0;
  while (tokenIndex < nTokens) {
    if (stopGeneration_.load()) {
      // [TODO] Temporary recurrent-memory fix: removeLastNTokens() may no-op
      // for hybrid/SSM models. A proper cancellation rollback needs llama.cpp
      // sequence checkpoint save + restore so partially evaluated tokens can
      // be restored without corrupting recurrent state.
      removeLastNTokens(tokenIndex);
      stopGeneration_.store(false);
      pendingBatchFirstMsg_ = false;
      return false;
    }
    textBatch->n_tokens = 0;
    // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,bugprone-narrowing-conversions,readability-implicit-bool-conversion,readability-identifier-naming)
    for (; tokenIndex < nTokens && textBatch->n_tokens < params_.n_batch;
         tokenIndex++) {
      llama_pos batchTokenIndex = textBatch->n_tokens;
      // NOLINTNEXTLINE(clang-analyzer-core.NullDereference)
      textBatch->token[batchTokenIndex] = inputTokens[tokenIndex];
      textBatch->pos[batchTokenIndex] = (count++);
      textBatch->n_seq_id[batchTokenIndex] = 1;
      textBatch->seq_id[batchTokenIndex][0] = seqId_;
      textBatch->logits[batchTokenIndex] = static_cast<int8_t>(false);

      textBatch->n_tokens++;
    }
    bool isLastToken = (tokenIndex == nTokens);
    if (isLastToken && !prefill) {
      textBatch->logits[textBatch->n_tokens - 1] = static_cast<int8_t>(true);
    }
    // NOLINTNEXTLINE(clang-analyzer-core.CallAndMessage)
    int ret = llama_decode(modelCtx_.lctx, *textBatch);
    if (ret != 0) {
      std::string errorMsg = string_format(
          "[TextLlm] %s: failed to decode input tokens\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(FailedToDecode), errorMsg);
    }

    nPast_ += textBatch->n_tokens;
    // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,bugprone-narrowing-conversions,readability-implicit-bool-conversion,readability-identifier-naming)
  }

  onPrefillComplete(nPast_, inputTokens.size());
  return true;
}

PrefillPlan TextLlmContext::preparePrefill(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools,
    const std::vector<std::vector<uint8_t>>& media,
    const std::vector<PlannedMedia>& mediaPlan, bool isCacheLoaded,
    bool isPrefillOnlyRequest) {
  if (!media.empty() || !mediaPlan.empty()) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "TextLlmContext::preparePrefill: media requires a multimodal model");
  }

  std::vector<llama_token> inputTokens;
  tokenizeChat(chatMsgs, tools, inputTokens, isCacheLoaded);

  const size_t nTokens = inputTokens.size();
  pendingBatchFirstMsg_ = nPast_ == 0;

  // Per-slot usable window: the partitioned per-sequence cap in batch mode,
  // else the full context. Sliding/overflow must measure against this so a
  // cached prompt larger than its slot can be discarded to fit instead of
  // being rejected by the scheduler.
  const llama_pos ceiling = ctxCeiling();

  // exceedsContextWindow mirrors the scheduler's admission, so the driver never
  // rejects a prompt the scheduler already let in.
  if (exceedsContextWindow(
          static_cast<llama_pos>(nTokens), ceiling, isPrefillOnlyRequest)) {
    std::string errorMsg = string_format(
        "[TextLlm] context overflow at batch prefill step: prompt tokens %ld, "
        "max context tokens %d\n",
        nTokens,
        ceiling);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextOverflow), errorMsg);
  }
  if (exceedsContextWindow(
          nPast_ + static_cast<llama_pos>(nTokens),
          ceiling,
          isPrefillOnlyRequest)) {
    auto outcome = trySlidePrefill(
        modelCtx_.lctx,
        seqId_,
        nPast_,
        firstMsgTokens_,
        static_cast<llama_pos>(nTokens),
        nDiscarded_,
        tools_,
        defaultContextSliderOps(),
        ceiling);
    switch (outcome.kind) {
    case ContextSlideOutcome::Kind::Slid:
      nPast_ = outcome.newNPast;
      ++nSlides_;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[TextLlm] Batch prefill step: discarded %d tokens after the "
              "first message\n",
              outcome.discarded));
      break;
    case ContextSlideOutcome::Kind::Overflow: {
      std::string errorMsg = string_format(
          "[TextLlm] context overflow at batch prefill step (%ld tokens, max "
          "%d)\n",
          nPast_ + nTokens,
          ceiling);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextOverflow), errorMsg);
    }
    case ContextSlideOutcome::Kind::MemoryOperationFailed: {
      std::string errorMsg = string_format(
          "[TextLlm] failed to slide context memory at prefill step "
          "(nPast=%d, append=%ld, max=%d)\n",
          nPast_,
          nTokens,
          llama_n_ctx(modelCtx_.lctx));
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextSlideFailed), errorMsg);
    }
    case ContextSlideOutcome::Kind::NotNeeded:
      break;
    }
  }

  return PrefillPlan{.tokens = std::move(inputTokens)};
}

void TextLlmContext::syncPosition(llama_pos currentPos) { nPast_ = currentPos; }

void TextLlmContext::onPrefillComplete(
    llama_pos currentPos, size_t prefillTokenCount) {
  nPast_ = currentPos;
  if (pendingBatchFirstMsg_) {
    firstMsgTokens_ = nPast_;
    const llama_pos ctxSize = ctxCeiling();
    if (nDiscarded_ >= ctxSize - firstMsgTokens_) {
      nDiscarded_ = ctxSize - firstMsgTokens_ - 1;
    }
    pendingBatchFirstMsg_ = false;
  }
  tools_.onEvalComplete(nPast_, static_cast<llama_pos>(prefillTokenCount));

  // Reset per-inference reasoning detection state here (shared by the
  // single-prompt and continuous-batching paths).
  reasoningState_.inside_reasoning = false;
  reasoningState_.recent_output_buffer.clear();
  thinkSpan_.reset();
  pendingThinkCloseCapture_ = false;

  // Template force-opened the reasoning channel (e.g. Qwen3 / DeepSeek-R1
  // assistant prefix ends with `<think>\n`): the opening tokens are
  // already in the KV cache, record their span so compactThinkSpan
  // can drop them at end-of-generation.
  if (thinkingForcedOpen_ && reasoningEnabled_) {
    setOpenThinkSpan(
        nPast_ - static_cast<llama_pos>(reasoningState_.forcedOpenTokenCount));
    reasoningState_.inside_reasoning = true;
  }
}

void TextLlmContext::flushPendingUtf8ToCallback(
    const std::function<void(const std::string&)>& outputCallback) {
  if (!utf8Buffer_.hasPendingBytes()) {
    return;
  }
  std::string remaining = utf8Buffer_.flush();
  if (!remaining.empty()) {
    emitOutputPiece(outputCallback, remaining);
  }
}

void TextLlmContext::emitOutputPiece(
    const std::function<void(const std::string&)>& outputCallback,
    const std::string& text) {
  if (text.empty()) {
    return;
  }
  assistantOutput_ += text;
  if (outputCallback) {
    outputCallback(text);
  }
}

llama_pos TextLlmContext::applyContextDiscard() {
  auto outcome = trySlideGeneration(
      modelCtx_.lctx,
      seqId_,
      nPast_,
      firstMsgTokens_,
      nDiscarded_,
      tools_,
      defaultContextSliderOps(),
      ctxCeiling());
  if (outcome.kind == ContextSlideOutcome::Kind::Slid) {
    nPast_ = outcome.newNPast;
    ++nSlides_;
    // Recorded span positions are no longer valid after the shift;
    // drop them rather than try to fix them up.
    thinkSpan_.reset();
    pendingThinkCloseCapture_ = false;
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[TextLlm] discarded %d tokens after the first message\n",
            outcome.discarded));
    return outcome.discarded;
  }
  if (outcome.kind == ContextSlideOutcome::Kind::MemoryOperationFailed) {
    std::string errorMsg = string_format(
        "[TextLlm] failed to slide context memory during generation "
        "(nPast=%d, nDiscarded=%d)\n",
        nPast_,
        nDiscarded_);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextSlideFailed), errorMsg);
  }
  return 0;
}

void TextLlmContext::handleStopRequestAndAddEot(LlamaBatch& batch) {
  stopGeneration_.store(false);
  llama_token eot = llama_vocab_eot(modelCtx_.vocab);
  common_batch_add(
      *batch,
      eot == LLAMA_TOKEN_NULL ? llama_vocab_eos(modelCtx_.vocab) : eot,
      nPast_,
      {seqId_},
      true);
  if (llama_decode(modelCtx_.lctx, *batch) != 0) {
    const char* errorMsg = "[TextLlm] failed to decode EOT token\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(FailedToDecode), errorMsg);
  }
  ++nPast_;
}

bool TextLlmContext::generateResponse(
    const std::function<void(const std::string&)>& outputCallback) {

  LlamaBatch batch(1, 0, 1); // batch for next token generation
  unsigned generatedAfterAccept = 0;

  forcedTokens_.clear();
  assistantOutput_.clear();
  generationStarted_ = false;

  // The chat template force-opened the reasoning channel in the prompt (e.g.
  // Qwen3 / DeepSeek-R1 templates end with "<think>\n"). Emit the matching
  // opener to the visible stream so consumers see a balanced tag pair;
  // `inside_reasoning` and the span capture were already set in
  // `onPrefillComplete`.
  if (thinkingForcedOpen_ && outputCallback) {
    outputCallback(thinkingForcedOpenText_);
    reasoningState_.inside_reasoning = true;
  }

  if (stopGeneration_.load()) {
    stopGeneration_.store(false);
    onCancel(outputCallback);
    return true;
  }

  while (params_.n_predict <= 0 ||
         generatedAfterAccept < static_cast<unsigned>(params_.n_predict)) {
    if (stopGeneration_.load()) {
      stopGeneration_.store(false);
      onCancel(outputCallback);
      return true;
    }

    ++generatedAfterAccept;
    const SequenceStepResult step =
        onLogitsReady(-1, generatedAfterAccept, outputCallback, &batch);
    if (step.contextOverflow) {
      return false;
    }
    if (step.decodedInline) {
      continue;
    }
    if (step.finished) {
      break;
    }

    common_batch_clear(*batch);
    if (stopGeneration_.load()) {
      handleStopRequestAndAddEot(batch);
      break;
    }
    common_batch_add(*batch, step.token, nPast_, {seqId_}, true);

    // NOLINT(clang-analyzer-core.CallAndMessage)
    if (llama_decode(modelCtx_.lctx, *batch) != 0) {
      const char* errorMsg = "[TextLlm] failed to decode next token\n";
      throw qvac_errors::StatusError(
          ADDON_ID, toString(FailedToDecode), errorMsg);
    }
    ++nPast_;
  }

  onGenerationFinished(outputCallback);
  return true;
}

SequenceStepResult TextLlmContext::onLogitsReady(
    int logitIdx, unsigned generatedAfterAccept,
    const std::function<void(const std::string&)>& outputCallback,
    LlamaBatch* inlineDecodeBatch) {
  // Finalise the previous iteration's deferred close-position capture;
  // the close-marker token has been committed by now.
  capturePendingThinkClose();

  if (stopGeneration_.load()) {
    stopGeneration_.store(false);
    flushPendingUtf8ToCallback(outputCallback);
    const llama_token eot = llama_vocab_eot(modelCtx_.vocab);
    return {
        .token =
            eot == LLAMA_TOKEN_NULL ? llama_vocab_eos(modelCtx_.vocab) : eot,
        .finished = true};
  }
  generationStarted_ = true;

  if (nPast_ + 1 > ctxCeiling() && nDiscarded_ == 0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[TextLlm] generation overflow: context is full and nDiscarded "
            "is 0 (nPast=%d, nCtx=%d, firstMsgTokens=%d, nPastBeforeTools=%d, "
            "toolsCompact=%s)\n",
            nPast_,
            ctxCeiling(),
            firstMsgTokens_,
            tools_.anchor(),
            tools_.enabled() ? "true" : "false"));
    return {.finished = true, .contextOverflow = true};
  }
  const llama_pos discarded = applyContextDiscard();
  // Batch path only: the scheduler cannot retry a full window, so a slot
  // that is still at its ceiling after the slide attempt must stop here.
  // Single-prompt keeps its legacy behavior (warn inside the slider and
  // continue).
  if (inlineDecodeBatch == nullptr && nPast_ + 1 > ctxCeiling()) {
    return {.finished = true, .contextOverflow = true, .discarded = discarded};
  }

  bool sampledToken = forcedTokens_.empty();
  llama_token tokenId = LLAMA_TOKEN_NULL;
  if (sampledToken) {
    tokenId = common_sampler_sample(smpl_.get(), modelCtx_.lctx, logitIdx);
    common_sampler_accept(smpl_.get(), tokenId, true);
  } else {
    tokenId = forcedTokens_.front();
    forcedTokens_.erase(forcedTokens_.begin());
  }

  std::string tokenStr =
      common_token_to_piece(modelCtx_.lctx, tokenId, params_.special);
  const std::string completeChars = utf8Buffer_.addToken(tokenStr);
  if (!completeChars.empty()) {
    emitOutputPiece(outputCallback, completeChars);
  }

  if (reasoningEnabled_) {
    const bool wasInside = reasoningState_.inside_reasoning;
    qvac_lib_inference_addon_llama::utils::updateReasoningBuffer(
        tokenStr, reasoningState_);
    const bool nowInside = reasoningState_.inside_reasoning;
    if (!wasInside && nowInside) {
      // The current sampled token is the LAST piece of the open marker;
      // earlier pieces (openTokenCount - 1) are already in the cache.
      setOpenThinkSpan(
          nPast_ - static_cast<llama_pos>(reasoningState_.openTokenCount - 1));
    }
    if (wasInside && !nowInside) {
      // Defer end capture — the close-marker token has not yet been
      // committed to the cache.
      pendingThinkCloseCapture_ = true;
    }
  }

  const bool isEos = llama_vocab_is_eog(modelCtx_.vocab, tokenId);
  if (sampledToken && isEos && isQwen3ReasoningFamily_) {
    if (inlineDecodeBatch != nullptr) {
      if (handleReasoningEOS(
              tokenId, tokenStr, **inlineDecodeBatch, nPast_, outputCallback)) {
        return {
            .token = tokenId,
            .finished = false,
            .decodedInline = true,
            .discarded = discarded};
      }
    } else if (
        reasoningState_.inside_reasoning &&
        reasoningState_.cached_close_tag_token != LLAMA_TOKEN_NULL) {
      tokenId = reasoningState_.cached_close_tag_token;
      tokenStr =
          common_token_to_piece(modelCtx_.lctx, tokenId, params_.special);
      reasoningState_.inside_reasoning = false;
      pendingThinkCloseCapture_ = true;
      if (reasoningState_.cached_newline_token != LLAMA_TOKEN_NULL) {
        forcedTokens_.push_back(reasoningState_.cached_newline_token);
        forcedTokens_.push_back(reasoningState_.cached_newline_token);
      }
      const std::string completeChars = utf8Buffer_.addToken(tokenStr);
      if (!completeChars.empty()) {
        emitOutputPiece(outputCallback, completeChars);
      }
      return {.token = tokenId, .finished = false, .discarded = discarded};
    }
  }
  // Batch path only: scheduler stops solely on `finished`. Single-prompt's
  // own while-loop caps generation; firing here drops its n_eval by one.
  const bool reachedBudget =
      inlineDecodeBatch == nullptr && params_.n_predict > 0 &&
      generatedAfterAccept >= static_cast<unsigned>(params_.n_predict);
  if (isEos && isHarmonyModel_ && params_.use_jinja &&
      tokenId == harmonyCallToken_) {
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[TextLlm] Harmony <|call|> stop: tokenId=%d\n", tokenId));
    const std::string callMarker =
        common_token_to_piece(modelCtx_.lctx, tokenId, true);
    emitOutputPiece(outputCallback, callMarker);
    flushPendingUtf8ToCallback(outputCallback);
    return {.token = tokenId, .finished = true, .discarded = discarded};
  }
  const bool finished = isEos || reachedBudget || checkAntiprompt();
  if (finished) {
    flushPendingUtf8ToCallback(outputCallback);
  }

  return {.token = tokenId, .finished = finished, .discarded = discarded};
}

void TextLlmContext::onSequenceEnd(
    const std::function<void(const std::string&)>& outputCallback) {
  flushPendingUtf8ToCallback(outputCallback);
}

void TextLlmContext::onGenerationFinished(
    const std::function<void(const std::string&)>& outputCallback) {
  capturePendingThinkClose();
  onSequenceEnd(outputCallback);
  if (generationStarted_) {
    onGenerationCompletePolicy(assistantOutput_);
    assistantOutput_.clear();
    generationStarted_ = false;
  }
  // Compact after the tools-compact tail trim so that pass sees the
  // pre-compaction `nPast_` (its offsets are computed against
  // `assistantOutput_`).
  compactThinkSpan();
}

void TextLlmContext::onCancel(
    const std::function<void(const std::string&)>& outputCallback) {
  onGenerationFinished(outputCallback);
}

void TextLlmContext::configureReasoningTags(
    const std::string& thinkingStartTag, const std::string& thinkingEndTag,
    const std::string& forcedOpenText) {
  // Family-default tags act as both the fallback when the active chat
  // template does not expose reasoning tags, and as the source for the
  // Qwen-family single-token close marker used by EOS-inside-reasoning
  // recovery. Resolved once so the lookup runs at most once per
  // prompt render.
  const std::optional<ReasoningTags> fallbackTags =
      selectReasoningTagsForModel(modelCtx_.model);

  const std::optional<ReasoningTags> reasoningTags =
      selectReasoningTagSource(thinkingStartTag, thinkingEndTag, fallbackTags);

  reasoningState_ = ReasoningState{};
  reasoningEnabled_ = false;
  if (!reasoningTags.has_value()) {
    return;
  }

  std::string eosRecoveryCloseTag;
  if (isQwen3ReasoningFamily_ && fallbackTags.has_value()) {
    eosRecoveryCloseTag = fallbackTags->close;
  }

  // Gate on the init return: if the open marker's first piece is not
  // a CONTROL / USER_DEFINED special token, prior context could
  // BPE-merge into the marker at runtime, the span-start math would
  // silently drift, and the recorded range would drop the wrong KV
  // window. Disable detection and surface a warning in that case.
  const bool reasoningInitOk = initializeReasoningState(
      modelCtx_.lctx,
      reasoningState_,
      *reasoningTags,
      forcedOpenText,
      eosRecoveryCloseTag);
  if (reasoningInitOk) {
    reasoningEnabled_ = true;
    return;
  }

  QLOG_IF(
      Priority::WARNING,
      string_format(
          "[TextLlm] reasoning detection disabled: first piece of open "
          "marker '%s' is not a special token under this vocab; "
          "thinking-block compaction will be skipped\n",
          reasoningTags->open.c_str()));
}

void TextLlmContext::setOpenThinkSpan(llama_pos start) {
  // `start < 0` only for degenerate templates whose entire rendered
  // prompt is the forced-open suffix; drop the span and leave the
  // tokens in cache.
  if (!removeThinkingFromContext_ || !reasoningEnabled_ || start < 0) {
    return;
  }
  // Single-block policy: only the first `<think>...</think>` is tracked.
  // Any later open marker emitted in the same inference is ignored.
  if (thinkSpan_.has_value()) {
    return;
  }
  thinkSpan_ = std::make_pair(start, static_cast<llama_pos>(-1));
}

void TextLlmContext::capturePendingThinkClose() {
  if (!pendingThinkCloseCapture_) {
    return;
  }
  pendingThinkCloseCapture_ = false;
  if (!removeThinkingFromContext_ || !thinkSpan_.has_value()) {
    return;
  }
  if (thinkSpan_->second < 0) {
    thinkSpan_->second = nPast_;
  }
}

void TextLlmContext::compactThinkSpan() {
  if (!removeThinkingFromContext_ || !thinkSpan_.has_value()) {
    thinkSpan_.reset();
    return;
  }
  const llama_pos start = thinkSpan_->first;
  const llama_pos end = thinkSpan_->second;
  thinkSpan_.reset();

  // Skip open (close never captured) or degenerate spans without
  // touching the cache. This is the single validation backstop for all
  // close-capture sites — none validate `end > start` themselves.
  if (end < 0 || end <= start) {
    return;
  }

  const CompactRangeOutcome outcome =
      compactKvRange(modelCtx_.lctx, seqId_, start, end, nPast_);
  if (outcome.kind == CompactRangeOutcome::Kind::Compacted) {
    nPast_ = outcome.newNPast;
    if (start < firstMsgTokens_) {
      firstMsgTokens_ = start;
    }
    if (tools_.enabled()) {
      tools_.onSlide(outcome.discarded, start);
    }
    ++thinkingBlockDiscards_;
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[TextLlm] thinking-block compaction: dropped %d tokens "
            "[%d, %d), nPast=%d, firstMsgTokens=%d\n",
            outcome.discarded,
            start,
            end,
            nPast_,
            firstMsgTokens_));
  } else if (outcome.kind == CompactRangeOutcome::Kind::MemoryOperationFailed) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[TextLlm] thinking-block compaction failed: seqRm rejected "
            "range [%d, %d) (nPast=%d, seqId=%d)\n",
            start,
            end,
            nPast_,
            seqId_));
  }
}

int32_t TextLlmContext::getThinkingBlockDiscards() const {
  return thinkingBlockDiscards_;
}

void TextLlmContext::resetThinkingBlockDiscards() {
  thinkingBlockDiscards_ = 0;
}

void TextLlmContext::setRemoveThinkingFromContext(bool value) {
  // Reject opt-in for recurrent-memory models (Mamba / RWKV / hybrid
  // SSM such as Qwen3.5). `seq_rm + seq_add` succeeds on the attention
  // KV but the SSM hidden state still carries the dropped tokens, so
  // subsequent turns read contaminated state. Surface a hard error
  // here rather than silently dropping the flag so callers know the
  // feature is unavailable for this model.
  if (value && hasRecurrentMemory_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "remove_thinking_from_context is not supported on models with "
        "recurrent memory (SSM / hybrid SSM such as Qwen3.5)");
  }
  removeThinkingFromContext_ = value;
}

void TextLlmContext::validatePromptPolicy(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, const PromptLayout& layout,
    bool hasKvCacheContext) const {
  tools_.validatePrompt(chatMsgs, tools, layout, hasKvCacheContext);
}

void TextLlmContext::onGenerationCompletePolicy(
    std::string_view assistantOutput) {
  const auto decision =
      tools_.onGenerationComplete(assistantOutput, nPast_, firstMsgTokens_);
  if (decision.trim) {
    // Safe here: dynamic tools are only supported by Qwen3, which does not
    // use recurrent memory, so tail removal does not hit the recurrent
    // rollback limitation.
    removeLastNTokens(decision.tokensToRemoveFromTail);
    if (decision.clampFirstMsgTokensToNPast && firstMsgTokens_ > nPast_) {
      firstMsgTokens_ = nPast_;
    }
  }
}

bool TextLlmContext::loadCache(
    const std::string& cacheKey, llama_pos configuredNDiscarded) {
  nDiscarded_ = configuredNDiscarded;
  if (cacheKey.empty() || !isFileInitialized(cacheKey)) {
    return false;
  }

  // Read the shared four-field metadata contract (SessionMetadataField order)
  // so this path round-trips caches written by CacheManager and the MTMD
  // driver. Text has no positional/cache divergence, so the last two fields
  // mirror the first two and are not applied separately.
  size_t tokenCount = 0;
  llama_token sessionTokens[SESSION_METADATA_FIELD_COUNT] = {0, 0, 0, 0};
  const auto loadedBytes = llama_state_seq_load_file(
      modelCtx_.lctx,
      cacheKey.c_str(),
      seqId_,
      sessionTokens,
      SESSION_METADATA_FIELD_COUNT,
      &tokenCount);
  if (loadedBytes == 0) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        "TextLlmContext::loadCache: failed to load cache '" + cacheKey + "'");
  }

  // load already wrote KV; roll back unless we accept
  ScopeGuard restoredKvGuard([this]() noexcept {
    try {
      clearSequenceMemory(modelCtx_.lctx);
    } catch (...) {
      QLOG_IF(
          Priority::ERROR,
          "[TextLlm] failed to clear sequence after invalid cache load\n");
    }
    nPast_ = 0;
    firstMsgTokens_ = 0;
    tools_.reset();
  });

  if (tokenCount <= 1) {
    return false;
  }
  const llama_pos metadataNPast = sessionTokens[0];
  const llama_pos metadataFirstMsgTokens = sessionTokens[1];
  if (metadataNPast > llama_n_ctx(modelCtx_.lctx)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(ContextLengthExeeded),
        "TextLlmContext::loadCache: cache '" + cacheKey +
            "' exceeds current context size");
  }

  auto* mem = llama_get_memory(modelCtx_.lctx);
  if (mem == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        "TextLlmContext::loadCache: llama memory is null after loading "
        "cache '" +
            cacheKey + "'");
  }

  const llama_pos restoredNPast = llama_memory_seq_pos_max(mem, seqId_) + 1;
  if (restoredNPast != metadataNPast) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "TextLlmContext::loadCache: cache '%s' restored nPast=%d, but "
            "metadata expected nPast=%d",
            cacheKey.c_str(),
            restoredNPast,
            metadataNPast));
  }

  nPast_ = metadataNPast;
  firstMsgTokens_ = metadataFirstMsgTokens;
  // Clamp discard to the per-slot window (ctxCeiling), not the physical
  // context: in batch mode the slot ceiling is ctx / n_parallel.
  const llama_pos window = ctxCeiling();
  if (configuredNDiscarded > window - firstMsgTokens_) {
    nDiscarded_ = window - firstMsgTokens_ - 1;
  } else {
    nDiscarded_ = configuredNDiscarded;
  }
  restoredKvGuard.dismiss();
  return true;
}

void TextLlmContext::saveCache(const std::string& cacheKey) const {
  if (cacheKey.empty()) {
    return;
  }

  // Persist the full four-field metadata contract so the file is loadable by
  // every path (CacheManager, MTMD). For text the cache-token counts equal the
  // positional counts, so the getters supply mirrored values.
  const llama_token sessionTokens[SESSION_METADATA_FIELD_COUNT] = {
      static_cast<llama_token>(getNPast()),
      static_cast<llama_token>(getFirstMsgTokens()),
      static_cast<llama_token>(getCacheTokens()),
      static_cast<llama_token>(getFirstMsgCacheTokens())};
  const auto savedBytes = llama_state_seq_save_file(
      modelCtx_.lctx,
      cacheKey.c_str(),
      seqId_,
      sessionTokens,
      SESSION_METADATA_FIELD_COUNT);
  if (savedBytes == 0) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidInputFormat),
        "TextLlmContext::saveCache: failed to save cache '" + cacheKey + "'");
  }
}

std::function<void()>
TextLlmContext::applyGenerationParams(const GenerationParams& overrides) {
  // Validate the recurrent-memory invariant BEFORE mutating any
  // sampler / common params state. `setRemoveThinkingFromContext`
  // throws on hybrid SSM models; if we let it throw after
  // `applyGenerationParamsToContext` has already committed the sampler
  // overrides, the throw escapes without returning the restore lambda
  // and those mutations leak into subsequent requests. This duplicates
  // the check in `setRemoveThinkingFromContext` but keeps that one as
  // a backstop for direct callers (e.g. the batch path).
  if (overrides.remove_thinking_from_context &&
      *overrides.remove_thinking_from_context && hasRecurrentMemory_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "remove_thinking_from_context is not supported on models with "
        "recurrent memory (SSM / hybrid SSM such as Qwen3.5)");
  }

  // Apply the sampler / `params_` overrides first so a malformed
  // `json_schema` throws before we touch our local toggle (otherwise
  // we would need a second try/catch here to roll the toggle back).
  auto restoreSampler = applyGenerationParamsToContext(
      params_, smpl_, modelCtx_.model, overrides);

  // Snapshot + apply the thinking-block compaction toggle. Restored
  // alongside the sampler at end-of-request via the composite lambda
  // below. The setRemoveThinkingFromContext call cannot throw here
  // because the recurrent-memory invariant was validated above.
  const bool savedRemoveThinking = removeThinkingFromContext_;
  bool toggled = false;
  if (overrides.remove_thinking_from_context) {
    setRemoveThinkingFromContext(*overrides.remove_thinking_from_context);
    toggled = true;
  }

  if (!toggled) {
    return restoreSampler;
  }

  return [this,
          restoreSampler = std::move(restoreSampler),
          savedRemoveThinking]() {
    restoreSampler();
    setRemoveThinkingFromContext(savedRemoveThinking);
  };
}

void TextLlmContext::stop() { stopGeneration_.store(true); }

void TextLlmContext::resetState(bool resetStats) {
  // Reset the n_past

  tools_.reset();
  nPast_ = 0;

  // Reset the first msg token length
  firstMsgTokens_ = 0;

  // On partial reset (resetStats=false), preserve nSlides_ and
  // thinkingBlockDiscards_ so runtimeStats() can read the per-
  // inference values. On full reset (resetStats=true), clear them
  // along with perf stats.
  if (resetStats) {
    nSlides_ = 0;
    thinkingBlockDiscards_ = 0;
  }

  // Clear UTF-8 buffer when resetting state
  utf8Buffer_.clear();
  forcedTokens_.clear();
  assistantOutput_.clear();
  generationStarted_ = false;
  thinkingForcedOpen_ = false;
  thinkingForcedOpenText_.clear();
  thinkSpan_.reset();
  pendingThinkCloseCapture_ = false;

  clearSequenceMemory(modelCtx_.lctx);

  // Reset performance metrics
  if (resetStats) {
    llama_perf_context_reset(modelCtx_.lctx);
  }

  // Reset sampler if available
  common_sampler_reset(smpl_.get());

  // Synchronize to ensure all operations are complete
  llama_synchronize(modelCtx_.lctx);
}

llama_context* TextLlmContext::getCtx() { return modelCtx_.lctx; }

llama_pos TextLlmContext::getNPast() const { return nPast_; }

void TextLlmContext::setNPast(llama_pos nPast) { this->nPast_ = nPast; }

llama_pos TextLlmContext::getFirstMsgTokens() const { return firstMsgTokens_; }

void TextLlmContext::setFirstMsgTokens(llama_pos firstMsgTokens) {
  this->firstMsgTokens_ = firstMsgTokens;
}

void TextLlmContext::setNDiscarded(llama_pos nDiscarded) {
  this->nDiscarded_ = nDiscarded;
}

llama_pos TextLlmContext::getNDiscarded() const { return nDiscarded_; }

int32_t TextLlmContext::getNSlides() const { return nSlides_; }
void TextLlmContext::resetNSlides() { nSlides_ = 0; }

llama_pos TextLlmContext::removeLastNTokens(llama_pos count) {
  // Validate input
  if (count <= 0) {
    return 0;
  }

  // Calculate how many tokens we can actually remove
  llama_pos tokensToRemove = std::min(count, nPast_);

  if (tokensToRemove == 0) {
    return 0;
  }

  if (hasRecurrentMemory_) {
    // TODO: Re-enable tail-token removal for recurrent / hybrid SSM models
    // once QVAC supports llama.cpp sequence checkpoint save + restore. Until
    // then, partial `llama_memory_seq_rm` can fail because recurrent state
    // does not keep full per-token history (for example Qwen3.5 with
    // n_rs_seq=0).
    return 0;
  }

  clearSequenceMemory(modelCtx_.lctx, nPast_ - tokensToRemove, -1);

  // Decrement the token count by the number of tokens removed
  nPast_ -= tokensToRemove;

  // Note: The sampler doesn't have an "undo" function, so we leave it as is.
  // The sampler maintains its own history, but the removed tokens won't affect
  // future sampling since they're no longer in the KV cache.

  return tokensToRemove;
}

bool TextLlmContext::handleReasoningEOS(
    llama_token& tokenId, std::string& tokenStr, llama_batch& batch,
    llama_pos& nPast,
    const std::function<void(const std::string&)>& outputCallback) {

  if (!reasoningState_.inside_reasoning) {
    return false;
  }

  if (reasoningState_.cached_close_tag_token == LLAMA_TOKEN_NULL) {
    QLOG_IF(
        Priority::WARNING,
        "[TextLlm] EOS detected inside reasoning but no cached closing tag!\n");
    return false;
  }

  // Replace EOS with closing tag
  tokenId = reasoningState_.cached_close_tag_token;
  tokenStr = common_token_to_piece(modelCtx_.lctx, tokenId, params_.special);
  reasoningState_.inside_reasoning = false;

  // Stream closing tag to user
  std::string completeChars = utf8Buffer_.addToken(tokenStr);
  if (!completeChars.empty()) {
    emitOutputPiece(outputCallback, completeChars);
  }

  // Decode closing tag
  common_batch_clear(batch);
  common_batch_add(batch, tokenId, nPast, {seqId_}, true);
  if (llama_decode(modelCtx_.lctx, batch) != 0) {
    QLOG_IF(
        Priority::ERROR,
        "[TextLlm] Failed to decode closing tag during replacement\n");
    return true;
  }
  ++nPast;

  // Close marker just committed — record span end before injecting
  // the trailing newlines (they are excluded from the span).
  if (removeThinkingFromContext_ && thinkSpan_.has_value() &&
      thinkSpan_->second < 0) {
    thinkSpan_->second = nPast;
  }
  pendingThinkCloseCapture_ = false;

  // Inject 2 newlines after closing tag
  if (reasoningState_.cached_newline_token != LLAMA_TOKEN_NULL) {
    for (int i = 0; i < 2; i++) {
      common_batch_clear(batch);
      common_batch_add(
          batch, reasoningState_.cached_newline_token, nPast, {seqId_}, true);

      if (llama_decode(modelCtx_.lctx, batch) != 0) {
        QLOG_IF(
            Priority::ERROR,
            "[TextLlm] Failed to decode newline token during forced "
            "injection\n");
        break;
      }
      ++nPast;

      std::string newlineStr = common_token_to_piece(
          modelCtx_.lctx,
          reasoningState_.cached_newline_token,
          params_.special);
      std::string completeChars = utf8Buffer_.addToken(newlineStr);
      if (!completeChars.empty()) {
        emitOutputPiece(outputCallback, completeChars);
      }
    }
  }

  return true;
}
