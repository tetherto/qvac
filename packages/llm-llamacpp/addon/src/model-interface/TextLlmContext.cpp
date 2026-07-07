#include "TextLlmContext.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <filesystem>
#include <system_error>

#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "CacheManager.hpp"
#include "ContextSlider.hpp"
#include "GenerationParamsApply.hpp"
#include "ReasoningRecoveryHelpers.hpp"
#include "addon/LlmErrors.hpp"
#include "common/common.h"
#include "common/log.h"
#include "inference-addon-cpp/Logger.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ReasoningSnapshotPolicy.hpp"
#include "utils/ReasoningUtils.hpp"
#include "utils/RecurrentStateSnapshot.hpp"
#include "utils/ScopeGuard.hpp"

using namespace qvac_lib_inference_addon_llama;
using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_llama::reasoning_recovery;
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
    : tools_(tools), llamaInit_(std::move(llamaInit)), params_(commonParams),
      compactor_(rollbackState_, tools_), shifter_(compactor_, rollbackState_) {
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
      perSeqCtxCeiling_(perSeqCtxCeiling), compactor_(rollbackState_, tools_),
      shifter_(compactor_, rollbackState_) {
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

  // Models with recurrent state (Mamba / RWKV pure-recurrent) or
  // hybrid SSM + attention (Qwen3.5, Qwen3-Next, Jamba,
  // Granite-Hybrid, LFM2, Nemotron-H, Kimi-Linear) need the snapshot +
  // replay path in `compactThinkSpan` because the recurrent hidden
  // state isn't positionally indexed and `seq_rm` on an interior
  // range silently leaves the SSM inconsistent.
  //
  // We deliberately do NOT gate on `llama_memory_can_shift`: that
  // predicate is about RoPE-based K-shift (position shifting) and
  // returns `true` for all memory types in fabric today, including
  // recurrent and hybrid. The real architectural property we care
  // about is "does this model have a recurrent half?", which is
  // exactly what these two model predicates report.
  const auto* const model = modelCtx_.model;
  needsRecurrentSnapshot_ =
      (model != nullptr) &&
      (llama_model_is_recurrent(model) || llama_model_is_hybrid(model));
  compactor_.setNeedsRecurrentSnapshot(needsRecurrentSnapshot_);
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

LlmContext::EvalMessageResult TextLlmContext::evalMessage(
    const std::vector<common_chat_msg>& chatMsgs, bool isCacheLoaded,
    bool prefill) {
  return evalMessageWithTools(chatMsgs, {}, isCacheLoaded, prefill);
}

LlmContext::EvalMessageResult TextLlmContext::evalMessageWithTools(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, bool isCacheLoaded,
    bool prefill) {
  // Clear per-inference recurrent-rollback state at the START of each
  // inference. A stale snapshot from a previous turn (e.g. the prior
  // turn was interrupted by `stopGeneration_` before `compactThinkSpan`
  // ran) would otherwise block the new snapshot via the
  // `!snapshot.empty()` early-return in `snapshotForRecurrentRollback`.
  rollbackState_.reset();

  // Drop any stale user-visible perf snapshot from a prior turn so this
  // inference's `runtimeStats()` read sees either the new snapshot
  // (captured by `compactThinkSpan` before its potential replay decode)
  // or a live `llama_perf_context()` value — never a stale one.
  userVisiblePerf_.reset();

  const std::vector<llama_token> inputTokens =
      preparePrefill(chatMsgs, tools, {}, {}, isCacheLoaded, prefill).tokens;
  const auto nTokens = static_cast<llama_pos>(inputTokens.size());

  // Captured AFTER `preparePrefill` so a pure-attention in-prefill
  // slide (which lowers `nPast_` via `trySlidePrefill`) is reflected
  // in the anchor. Earlier capture would leave `preRequestNPast_` at
  // the pre-slide cursor and `removeLastNTokens` under-trims on
  // rollback, leaking cancelled prompt tokens into live KV. Recurrent
  // preparePrefill throws instead of sliding, so the ordering matches
  // for that path. The scheduler admission takes the same anchor
  // after its own `preparePrefill`.
  snapshotPreRequestCursor();
  LlamaBatch textBatch(params_.n_batch, 0, 1);

  // Snapshot the sequence state at prefill entry on recurrent / hybrid
  // memory so a mid-prefill cancellation can roll back to the exact
  // pre-prefill cache. Pure-attention models use `removeLastNTokens`
  // (which is a no-op for recurrent memory per PR #2808), so the
  // snapshot is skipped on that path.
  if (needsRecurrentSnapshot_) {
    if (!rollbackState_.capturePrefillEntry(modelCtx_.lctx, seqId_, nPast_)) {
      // Capture failed: the cancel path will be unable to roll back the
      // recurrent half of the cache. This is auxiliary bookkeeping for
      // cancel-time rollback, not part of the `remove_thinking_from_
      // context` cleanup contract, so we degrade to a warning rather
      // than hard-failing the request; cancel then falls back to the
      // no-op `removeLastNTokens` path.
      QLOG_IF(
          Priority::WARNING,
          "[TextLlm] failed to capture prefill-entry recurrent snapshot; "
          "mid-prefill cancel will not roll back recurrent state\n");
    }
  }

  // Snapshot boundary for the recurrent-rollback path. -1 disables
  // the snapshot (pure-attention memory, feature off, no reasoning
  // channel, or degenerate prompt where the boundary would fall
  // outside the prefill range). When set, we cap each batch chunk so
  // it never crosses the boundary, then take the snapshot exactly
  // once when prefill has consumed up to that index.
  const llama_pos snapBoundary = computeRecurrentSnapshotBoundary(nTokens);
  bool snapshotTaken = false;

  llama_pos count = nPast_;
  llama_pos tokenIndex = 0;
  while (tokenIndex < nTokens) {
    if (stopGeneration_.load()) {
      bool rollbackOk = true;
      if (rollbackState_.hasPrefillEntry()) {
        // Recurrent / hybrid path: full-state restore is the only way
        // to drop partially decoded tokens; `removeLastNTokens` is a
        // no-op on recurrent memory and `seq_rm` over a partial tail
        // is rejected by the recurrent module.
        const llama_pos restoredNPast = rollbackState_.prefillEntryNPast();
        const bool forceRestoreFailure =
            forcePrefillEntryRestoreFailureForTesting_;
        forcePrefillEntryRestoreFailureForTesting_ = false;
        if (!forceRestoreFailure &&
            rollbackState_.restorePrefillEntry(modelCtx_.lctx, seqId_)) {
          nPast_ = restoredNPast;
        } else {
          // Restore underflowed: the recurrent half is in an undefined
          // state. The fallback below is best-effort only and does not
          // touch recurrent memory; report rollbackOk=false so
          // processPromptImpl resets live state and invalidates the
          // active cache session before any later save can persist it.
          QLOG_IF(
              Priority::WARNING,
              string_format(
                  "[TextLlm] prefill-entry recurrent snapshot restore "
                  "failed on cancel (tokenIndex=%d, snapshotNPast=%d, "
                  "seqId=%d); recurrent state may be inconsistent until "
                  "the next full reset\n",
                  tokenIndex,
                  restoredNPast,
                  seqId_));
          removeLastNTokens(tokenIndex);
          nPast_ = restoredNPast;
          rollbackOk = false;
        }
      } else {
        removeLastNTokens(tokenIndex);
        if (needsRecurrentSnapshot_ && nPast_ > preRequestNPast_) {
          nPast_ = preRequestNPast_;
          rollbackOk = false;
        }
      }
      stopGeneration_.store(false);
      pendingBatchFirstMsg_ = false;
      return {.ok = false, .cancelled = true, .rollbackOk = rollbackOk};
    }
    // Cap the current chunk at the snapshot boundary so recurrent /
    // hybrid models can capture the exact end-of-prefill state before
    // generation starts.
    const llama_pos chunkEnd =
        (!snapshotTaken && snapBoundary > tokenIndex && snapBoundary < nTokens)
            ? snapBoundary
            : nTokens;
    textBatch->n_tokens = 0;
    // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,bugprone-narrowing-conversions,readability-implicit-bool-conversion,readability-identifier-naming)
    for (; tokenIndex < chunkEnd && textBatch->n_tokens < params_.n_batch;
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

    // Snapshot fires exactly once when prefill reaches the configured
    // recurrent rollback boundary.
    if (!snapshotTaken && snapBoundary >= 0 && tokenIndex == snapBoundary) {
      snapshotForRecurrentRollback();
      snapshotTaken = true;
    }
  }

  onPrefillComplete(nPast_, inputTokens.size());
  return {};
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

  // Set BEFORE `tokenizeChat` so `configureReasoningTags` can suppress
  // the "will hard-fail" preemptive warning for cache-warm requests that
  // will never enter generation.
  isPrefillOnlyRequest_ = isPrefillOnlyRequest;

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
        shifter_.discardBudget(),
        tools_,
        defaultContextSliderOps(),
        ceiling);
    switch (outcome.kind) {
    case ContextSlideOutcome::Kind::Slid:
      nPast_ = outcome.newNPast;
      shifter_.noteSlide();
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
  // Unified end-of-prefill snapshot point for recurrent / hybrid
  // generation requests. Both prefill drivers — the single-prompt loop
  // in `evalMessageWithTools` and `ContinuousBatchScheduler::stepLocked`
  // — funnel through here once the final prefill chunk is decoded, so
  // taking the snapshot here makes the rollback path work uniformly for
  // both. Idempotent (the underlying capture early-returns when a
  // boundary snapshot already exists) and a no-op when feature gates are
  // off or this is a prefill-only cache-warm request, so it's safe to
  // call unconditionally.
  snapshotForRecurrentRollback();
  if (pendingBatchFirstMsg_) {
    firstMsgTokens_ = nPast_;
    const llama_pos ctxSize = ctxCeiling();
    if (shifter_.discardBudget() >= ctxSize - firstMsgTokens_) {
      shifter_.setDiscardBudget(ctxSize - firstMsgTokens_ - 1);
    }
    pendingBatchFirstMsg_ = false;
  }
  tools_.onEvalComplete(nPast_, static_cast<llama_pos>(prefillTokenCount));

  // Reset per-inference reasoning detection state here (shared by the
  // single-prompt and continuous-batching paths).
  //
  // NOTE: do NOT reset `rollbackState_`'s reasoning-boundary snapshot
  // or post-reasoning buffers here — generation requests may have just
  // taken the snapshot above, and wiping it would render the recurrent-
  // rollback path dead.
  // Lifecycle: single-prompt path calls `rollbackState_.reset()` at
  // the start of `evalMessageWithTools`; the continuous-batching
  // scheduler constructs a fresh driver per slot so the state starts
  // empty. Subsequent invalidation happens on context slide
  // (`applyContextDiscard`) and consumption is via `compactThinkSpan`'s
  // RAII guard.
  reasoningState_.inside_reasoning = false;
  reasoningState_.recent_output_buffer.clear();
  compactor_.reset();

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
  const auto outcome = shifter_.applyGenerationDiscard(
      modelCtx_.lctx,
      seqId_,
      nPast_,
      firstMsgTokens_,
      ctxCeiling(),
      /*cacheTokens=*/-1,
      "[TextLlm]");
  if (outcome.kind == ContextShifter::Outcome::Kind::Slid) {
    nPast_ = outcome.newPos;
    return outcome.discarded;
  }
  return 0;
}

LlmContext::GenerateResponseResult TextLlmContext::generateResponse(
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
    return {
        .ok = true, .cancelled = true, .rollbackOk = onCancel(outputCallback)};
  }

  while (params_.n_predict <= 0 ||
         generatedAfterAccept < static_cast<unsigned>(params_.n_predict)) {
    if (stopGeneration_.load()) {
      stopGeneration_.store(false);
      return {
          .ok = true,
          .cancelled = true,
          .rollbackOk = onCancel(outputCallback)};
    }

    ++generatedAfterAccept;
    const SequenceStepResult step =
        onLogitsReady(-1, generatedAfterAccept, outputCallback, &batch);
    if (step.contextOverflow) {
      return {.ok = false};
    }
    if (step.decodedInline) {
      continue;
    }
    if (step.finished) {
      break;
    }

    common_batch_clear(*batch);
    if (stopGeneration_.load()) {
      // Route through the post-loop `onCancel` instead of injecting
      // EOT — EOT would advance `nPast_` past the rollback target.
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

  // Unified post-loop cancel for both hybrid/recurrent and pure-attention.
  // Mid-loop cancel exits leave `stopGeneration_` set and skip EOT.
  if (stopGeneration_.load()) {
    stopGeneration_.store(false);
    return {
        .ok = true, .cancelled = true, .rollbackOk = onCancel(outputCallback)};
  }
  onGenerationFinished(outputCallback);
  return {};
}

SequenceStepResult TextLlmContext::onLogitsReady(
    int logitIdx, unsigned generatedAfterAccept,
    const std::function<void(const std::string&)>& outputCallback,
    LlamaBatch* inlineDecodeBatch) {
  // Finalise the previous iteration's deferred close-position capture;
  // the close-marker token has been committed by now.
  capturePendingThinkClose();

  if (stopGeneration_.load()) {
    // Leave `stopGeneration_` set so the post-loop `onCancel` runs;
    // do NOT emit EOT since the rollback drops all sampled tokens.
    return {.finished = true};
  }
  generationStarted_ = true;

  if (nPast_ + 1 > ctxCeiling() && shifter_.discardBudget() == 0) {
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

  // Record post-reasoning tokens for replay. Post-reasoning capture
  // is started by the prior turn's `capturePendingThinkClose()`
  // (called at the top of this function), so the very first sampled
  // token after the close marker lands here.
  recordPostReasoningTokenIfActive(tokenId);

  if (reasoningEnabled_) {
    const bool wasInside = reasoningState_.inside_reasoning;
    // Seed the sampled token into the recurrent replay buffer BEFORE
    // running the reasoning detector: on generated-opener templates
    // (`thinkingForcedOpen == false`) every token sampled after
    // end-of-prefill and up to and including the token that flips
    // `inside_reasoning` from false to true is part of the pre-
    // reasoning span (template preamble + opener pieces). The
    // compactor's restored end-of-prefill snapshot does not contain
    // any of those tokens, so the replay must carry them or the SSM
    // would land in an unbalanced state on the next turn. No-op on
    // pure-attention paths, when the feature is off, or before the
    // boundary snapshot exists.
    if (!wasInside) {
      compactor_.recordPreReasoningToken(tokenId);
    }
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
      compactor_.requestCloseCapture();
      // Seed the recurrent replay buffer with the *canonical* close
      // vocab token, not the sampled `tokenId` that triggered the
      // detector flip.
      //
      // `updateReasoningBuffer` runs `find(state.tags.close)` against
      // the streamed text buffer, and `state.tags.close` for chat
      // templates like Qwen3's carries the surrounding whitespace
      // padding (e.g. `"\n</think>\n\n"`). The flip therefore fires on
      // the last piece that completes the padded string — typically a
      // template newline token — while the actual `</think>` vocab
      // entry was emitted 1–3 tokens earlier. Seeding that trailing
      // padding token would drive the recurrent replay through a
      // padding piece with no matching `</think>`, leaving the SSM
      // in an unbalanced `<think>...` state on the next turn.
      //
      // `cached_close_tag_token` is populated from tokenising the
      // stripped canonical close (`</think>`) at reasoning init and is
      // non-null whenever the recurrent-capture policy admits us
      // (both `close_is_single_token == true`), so it is always safe
      // on this branch. `recordCloseMarkerForReplay` additionally
      // no-ops on `LLAMA_TOKEN_NULL` and on non-recurrent paths.
      compactor_.recordCloseMarkerForReplay(
          reasoningState_.cached_close_tag_token);
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
      compactor_.requestCloseCapture();
      // EOS-substitution: original EOS reached
      // `recordPostReasoningTokenIfActive` above while capture was
      // still inactive, and the substituted close-tag token never
      // does. Seed the replay buffer here for the same reason as the
      // normal-close path.
      compactor_.recordCloseMarkerForReplay(tokenId);
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
  // Generation completed; cancel cannot fire anymore so the
  // prefill-entry rollback checkpoint is no longer reachable. Drop
  // its temp file now instead of waiting for the next inference.
  rollbackState_.clearPrefillEntry();
}

bool TextLlmContext::onCancel(
    const std::function<void(const std::string&)>& outputCallback) {
  // Cancel = "request never happened": roll back to the pre-request
  // cursor for both prefill- and decode-stage cancels.
  // `reasoningBoundary` is compaction-only and not used here — restoring
  // it would leak the cancelled prompt / generated-prefix state into
  // the cache.
  flushPendingUtf8ToCallback(outputCallback);

  const bool rollbackOk = rollbackCancelledRequest({
      .labelTag = "[TextLlm]",
      .ctx = modelCtx_.lctx,
      .seqId = seqId_,
      .needsRecurrentSnapshot = needsRecurrentSnapshot_,
      .currentPos = nPast_,
      .preRequestPos = preRequestNPast_,
      .rollback = rollbackState_,
      .onRecurrentRestored =
          [this](llama_pos restoredNPast) { nPast_ = restoredNPast; },
      .onRecurrentRestoreFailed =
          [this](llama_pos restoredNPast) { nPast_ = restoredNPast; },
      .onRecurrentMissingSnapshotAdvanced =
          [this]() { nPast_ = preRequestNPast_; },
      .removeLastNTokens =
          [this](llama_pos delta) { removeLastNTokens(delta); },
      .onPureAttentionRolledBack = [this]() { nPast_ = preRequestNPast_; },
  });

  firstMsgTokens_ = preRequestFirstMsgTokens_;
  rollbackState_.clearPrefillEntry();
  rollbackState_.clearReasoningBoundary();
  rollbackState_.clearPostReasoning();
  compactor_.clearSpan();
  assistantOutput_.clear();
  generationStarted_ = false;
  return rollbackOk;
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
  compactor_.setReasoningEnabled(false);
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
    compactor_.setReasoningEnabled(true);
    const bool reasoningCompactionActive = params_.reasoning_budget != 0;
    if (needsRecurrentSnapshot_ && removeThinkingFromContext_ &&
        reasoningCompactionActive && !isPrefillOnlyRequest_ &&
        !reasoningState_.close_is_single_token) {
      QLOG_IF(
          Priority::WARNING,
          string_format(
              "[TextLlm] recurrent reasoning compaction will hard-fail if "
              "this request emits reasoning: remove_thinking_from_context is "
              "enabled on a hybrid/recurrent model, but close marker '%s' "
              "must tokenise to one token\n",
              reasoningTags->close.c_str()));
    }
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

llama_pos
TextLlmContext::computeRecurrentSnapshotBoundary(llama_pos prefillLen) const {
  // Prefill-only (cache-warm) requests never enter generation and
  // cannot emit reasoning tokens, so the hard-fail contract for an
  // unsupported multi-token recurrent close marker does not apply.
  // Short-circuit to the "no boundary" sentinel before consulting the
  // policy so a cache warm on a model that would only fail at decode
  // time still succeeds.
  if (isPrefillOnlyRequest_) {
    return -1;
  }
  const auto decision = recurrentReasoningBoundaryDecision(
      needsRecurrentSnapshot_,
      removeThinkingFromContext_,
      reasoningEnabled_ && params_.reasoning_budget != 0,
      thinkingForcedOpen_,
      reasoningState_.close_is_single_token);
  switch (decision) {
  case RecurrentReasoningBoundaryDecision::Capture:
    break;
  case RecurrentReasoningBoundaryDecision::Disabled:
    return -1;
  case RecurrentReasoningBoundaryDecision::UnsupportedMultiTokenClose:
    throwUnsupportedRecurrentReasoningCompaction("[TextLlm]", decision);
  }
  // Snapshot at the END of prefill. For force-open templates the
  // restored prefix already contains the reasoning opener. For
  // generated-opener templates the restored prefix does NOT contain
  // `<think>`, so the decode loop seeds every sampled token up to the
  // open-detection flip into the replay buffer before the close marker
  // and visible tail. That gives the recurrent state the same compacted
  // structural shape (`preamble + <think> + </think> + answer`) without
  // replaying the reasoning body.
  //
  // Pure-attention models keep the existing `seq_rm` path, unaffected.
  const llama_pos boundary = prefillLen;
  // Degenerate templates whose entire prefill IS the forced opener
  // give a boundary of 0; snapshotting at nPast_ == 0 is a valid
  // empty-sequence snapshot. Boundaries outside `[0, prefillLen]`
  // would corrupt the chunk-cap logic — disable in that case.
  if (boundary < 0 || boundary > prefillLen) {
    return -1;
  }
  return boundary;
}

void TextLlmContext::snapshotForRecurrentRollback() {
  // Skip the boundary capture entirely on prefill-only (cache-warm)
  // requests: no generation follows, so there is no reasoning tail
  // that could ever be compacted or replayed. Matches the guard in
  // `computeRecurrentSnapshotBoundary` so the batch path (which
  // reaches this method via `onPrefillComplete`) and the single-
  // prompt path stay consistent.
  if (isPrefillOnlyRequest_) {
    return;
  }
  const auto decision = recurrentReasoningBoundaryDecision(
      needsRecurrentSnapshot_,
      removeThinkingFromContext_,
      reasoningEnabled_ && params_.reasoning_budget != 0,
      thinkingForcedOpen_,
      reasoningState_.close_is_single_token);
  if (decision == RecurrentReasoningBoundaryDecision::Disabled) {
    return;
  }
  try {
    if (decision != RecurrentReasoningBoundaryDecision::Capture) {
      throwUnsupportedRecurrentReasoningCompaction("[TextLlm]", decision);
    }
    compactor_.snapshotAtPrefillBoundary(
        modelCtx_.lctx, seqId_, nPast_, "[TextLlm]");
  } catch (const qvac_errors::StatusError&) {
    // Boundary capture failed. Live memory currently holds the fully
    // decoded prompt (including the forced-open reasoning marker),
    // and without a boundary snapshot the recurrent path cannot
    // compact at end-of-generation. Under the hard-fail contract we
    // roll back to the pre-prompt checkpoint (if we still have one)
    // so no subsequent turn on this driver observes the prompt
    // tokens, then re-throw. The batch scheduler's slot cleanup
    // additionally passes `SaveCachePolicy::Skip` so the last known-
    // good on-disk cache is preserved.
    const bool restoredPrefillEntry = restorePrefillEntryOrClearSequence({
        .ctx = modelCtx_.lctx,
        .seqId = seqId_,
        .rollback = rollbackState_,
        .onRestored =
            [this](llama_pos restoredNPast) { nPast_ = restoredNPast; },
        .onCleared = [this]() { nPast_ = 0; },
    });
    firstMsgTokens_ = restoredPrefillEntry ? preRequestFirstMsgTokens_ : 0;
    rollbackState_.clearPrefillEntry();
    rollbackState_.clearReasoningBoundary();
    rollbackState_.clearPostReasoning();
    compactor_.reset();
    generationStarted_ = false;
    assistantOutput_.clear();
    throw;
  }
}

void TextLlmContext::setOpenThinkSpan(llama_pos start) {
  compactor_.setOpenSpan(start);
}

void TextLlmContext::capturePendingThinkClose() {
  if (!compactor_.hasPendingCloseCapture()) {
    return;
  }
  compactor_.onCloseCommitted(nPast_);
}

void TextLlmContext::recordPostReasoningTokenIfActive(llama_token tokenId) {
  compactor_.recordPostReasoningToken(tokenId);
}

void TextLlmContext::compactThinkSpan() {
  // Freeze the user-visible perf counters before the compactor's
  // recurrent path runs `restore + llama_decode` to replay the post-
  // reasoning tail. Those replay decodes accumulate into `n_p_eval` /
  // `t_p_eval_ms` and would otherwise inflate prompt / TTFT / ppTPS.
  // Capture only when the recurrent replay path can actually fire;
  // pure-attention compaction has no extra `llama_decode`.
  if (needsRecurrentSnapshot_ && compactor_.hasOpenSpan() &&
      !userVisiblePerf_.has_value()) {
    userVisiblePerf_ = llama_perf_context(modelCtx_.lctx);
  }
  const ReasoningBlockCompactor::Outcome outcome =
      compactor_.compact(modelCtx_.lctx, seqId_, nPast_, "[TextLlm]");
  handleCompactionOutcome(
      outcome,
      {
          .onCompacted =
              [this](const ReasoningBlockCompactor::Outcome& compacted) {
                nPast_ = compacted.newPos;
                if (compacted.keptPrefixEnd < firstMsgTokens_) {
                  firstMsgTokens_ = compacted.keptPrefixEnd;
                }
              },
          .onFailedKvIntact =
              [this]() {
                const llama_pos delta = nPast_ - preRequestNPast_;
                if (delta > 0) {
                  removeLastNTokens(delta);
                }
                nPast_ = preRequestNPast_;
                firstMsgTokens_ = preRequestFirstMsgTokens_;
                generationStarted_ = false;
                assistantOutput_.clear();
                rollbackState_.reset();
                compactor_.reset();
              },
          .onFailedKvWiped =
              [this]() {
                nPast_ = 0;
                firstMsgTokens_ = 0;
                generationStarted_ = false;
                assistantOutput_.clear();
                rollbackState_.reset();
                compactor_.reset();
              },
      });
}

int32_t TextLlmContext::getThinkingBlockDiscards() const {
  return compactor_.blockDiscards();
}

void TextLlmContext::resetThinkingBlockDiscards() {
  compactor_.resetBlockDiscards();
}

std::optional<llama_perf_context_data>
TextLlmContext::takeUserVisiblePerfSnapshot() {
  auto snapshot = userVisiblePerf_;
  userVisiblePerf_.reset();
  return snapshot;
}

void TextLlmContext::setRemoveThinkingFromContext(bool value) {
  // Recurrent / hybrid SSM models (Qwen3.5, Qwen3-Next, Jamba, ...) are
  // supported via the snapshot + replay path in `compactThinkSpan` when
  // the close marker is a single token: a full-state snapshot is
  // captured at end-of-prefill, restored at end-of-generation, and the
  // generated pre-reasoning prefix (when any), close marker, and
  // post-reasoning tail are replayed through `llama_decode` so both KV
  // halves stay consistent.
  //
  // Uniform hard-fail contract (PR #2813): when the feature is on,
  // ANY inability to remove the reasoning span from cache surfaces to
  // the caller as `qvac_errors::StatusError`, thrown from
  // `compactThinkSpan` after local rollback so both driver metadata
  // and live KV agree on the recovery cursor:
  //   - Unsupported recurrent template shape (multi-token close
  //     marker) — thrown from
  //     `snapshotForRecurrentRollback`; the wrapper restores the
  //     pre-prompt checkpoint (or wipes the sequence and resets
  //     positional accounting on restore underflow), and rethrows.
  //   - Prefill-boundary snapshot capture failure — thrown from
  //     `ReasoningBlockCompactor::snapshotAtPrefillBoundary`; the
  //     `snapshotForRecurrentRollback` wrapper catches, restores the
  //     pre-prompt checkpoint (or wipes the sequence and resets
  //     positional accounting on restore underflow), and rethrows.
  //   - Pure-attention `seq_rm + seq_add` rejection — the compactor
  //     returns `Outcome::Kind::FailedKvIntact`. The primitive is
  //     all-or-nothing so live KV is unchanged; `compactThinkSpan`
  //     drops `[preRequestNPast_, nPast_)` from live memory via
  //     `removeLastNTokens`, restores `nPast_` / `firstMsgTokens_`
  //     to the pre-request cursor, resets per-inference reasoning
  //     bookkeeping, and throws.
  //   - Hybrid restore/replay failure — the compactor best-effort
  //     wipes the sequence memory and returns
  //     `Outcome::Kind::FailedKvWiped`. `compactThinkSpan` resets
  //     positional bookkeeping to zero to match the cleared
  //     sequence, drops per-inference state so no subsequent turn or
  //     late cache save can write into contaminated state, and
  //     throws.
  //
  // In every case the current turn's answer is NOT delivered; the
  // caller (single-prompt JS wrapper or the batch scheduler worker-
  // loop global catch) surfaces the error, and the batch error-
  // recovery path additionally skips saveCache
  // (`SaveCachePolicy::Skip`) so the last known-good on-disk cache is
  // preserved.
  removeThinkingFromContext_ = value;
  compactor_.setRemoveThinkingFromContext(value);
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
  shifter_.setDiscardBudget(configuredNDiscarded);
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

  const llama_pos restoredCacheTokens =
      static_cast<llama_pos>(llama_memory_seq_token_count(mem, seqId_));
  const llama_pos metadataCacheTokens =
      tokenCount >= SESSION_METADATA_FIELD_COUNT
          ? sessionTokens[static_cast<size_t>(
                SessionMetadataField::CacheTokens)]
          : metadataNPast;
  if (restoredCacheTokens != metadataCacheTokens) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        string_format(
            "TextLlmContext::loadCache: cache '%s' restored cacheTokens=%d, "
            "but metadata expected cacheTokens=%d",
            cacheKey.c_str(),
            restoredCacheTokens,
            metadataCacheTokens));
  }

  nPast_ = metadataNPast;
  firstMsgTokens_ = metadataFirstMsgTokens;
  // Clamp discard to the per-slot window (ctxCeiling), not the physical
  // context: in batch mode the slot ceiling is ctx / n_parallel.
  const llama_pos window = ctxCeiling();
  if (configuredNDiscarded > window - firstMsgTokens_) {
    shifter_.setDiscardBudget(window - firstMsgTokens_ - 1);
  } else {
    shifter_.setDiscardBudget(configuredNDiscarded);
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
  const std::string tmpCacheKey = cacheKey + ".tmp";
  const auto savedBytes = llama_state_seq_save_file(
      modelCtx_.lctx,
      tmpCacheKey.c_str(),
      seqId_,
      sessionTokens,
      SESSION_METADATA_FIELD_COUNT);
  if (savedBytes == 0) {
    std::error_code ec;
    std::filesystem::remove(tmpCacheKey, ec);
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToSaveSessionFile),
        "TextLlmContext::saveCache: failed to save cache '" + cacheKey + "'");
  }
  CacheManager::atomicPromoteFile(tmpCacheKey, cacheKey);
}

void TextLlmContext::snapshotPreRequestCursor() {
  preRequestNPast_ = nPast_;
  preRequestFirstMsgTokens_ = firstMsgTokens_;
}

void TextLlmContext::snapshotPreRequestRollbackAnchor() {
  // Pure-attention drivers rely on `removeLastNTokens` in `onCancel`;
  // no snapshot needed. The single-prompt path takes its own capture
  // after `preparePrefill` (see the mid-`evalMessageWithTools` site) —
  // this hook exists specifically so the batch path, which never runs
  // that site, has an equivalent rollback anchor.
  if (!needsRecurrentSnapshot_) {
    return;
  }
  if (!rollbackState_.capturePrefillEntry(modelCtx_.lctx, seqId_, nPast_)) {
    // Silent failure would make `hasPrefillEntry()` false at cancel
    // time, turn `onCancel`'s rollback into a no-op, and let peak
    // `nPast` leak back into `CacheTokens`. This is cancel-path
    // bookkeeping, unrelated to `remove_thinking_from_context`
    // cleanup, so we log a warning rather than hard-failing the
    // request.
    QLOG_IF(
        Priority::WARNING,
        "[TextLlm] failed to capture prefill-entry recurrent snapshot at "
        "batch admission; cancel rollback will be a no-op and CacheTokens "
        "may report the transient peak\n");
  }
}

std::function<void()>
TextLlmContext::applyGenerationParams(const GenerationParams& overrides) {
  // Apply the sampler / `params_` overrides first so a malformed
  // `json_schema` throws before we touch our local toggle (otherwise
  // we would need a second try/catch here to roll the toggle back).
  auto restoreSampler = applyGenerationParamsToContext(
      params_, smpl_, modelCtx_.model, overrides);

  // Snapshot + apply the thinking-block compaction toggle. Restored
  // alongside the sampler at end-of-request via the composite lambda
  // below.
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

  // On partial reset (resetStats=false), preserve the slide counter
  // and block discards so `runtimeStats()` can read the per-inference
  // values. On full reset (resetStats=true), clear them along with
  // perf stats.
  if (resetStats) {
    shifter_.resetSlides();
    compactor_.resetBlockDiscards();
  }

  // Clear UTF-8 buffer when resetting state
  utf8Buffer_.clear();
  forcedTokens_.clear();
  assistantOutput_.clear();
  generationStarted_ = false;
  thinkingForcedOpen_ = false;
  thinkingForcedOpenText_.clear();
  compactor_.reset();
  rollbackState_.reset();
  // Gated on `resetStats` — the partial reset between generation and
  // `runtimeStats()` must preserve the compactor's perf snapshot.
  if (resetStats) {
    userVisiblePerf_.reset();
  }

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
  shifter_.setDiscardBudget(nDiscarded);
}

llama_pos TextLlmContext::getNDiscarded() const {
  return shifter_.discardBudget();
}

int32_t TextLlmContext::getNSlides() const { return shifter_.slides(); }
void TextLlmContext::resetNSlides() { shifter_.resetSlides(); }

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

  if (needsRecurrentSnapshot_) {
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
  // Seed the replay buffer with the substituted close-tag token id
  // first so it lands ahead of the newlines that the loop below
  // records once `onCloseCommitted` flips capture on.
  //
  // `onCloseCommitted` is gated on `pendingThinkCloseCapture_`: that
  // flag is the finaliser for the iter-deferred "marker seen, commit
  // position next iter" handshake used by the normal buffer-transition
  // path. EOS substitution skips that handshake (there is no real
  // `</think>` token going through `updateReasoningBuffer` to trip
  // `requestCloseCapture`), so flip it here so the compactor actually
  // records the span end. Without this, the substituted close is
  // invisible to the compactor and `compactThinkSpan` later bails at
  // `end < 0` — observable as multi-turn reasoning blocks no longer
  // being compacted when the model emits EOS instead of `</think>`.
  compactor_.requestCloseCapture();
  compactor_.recordCloseMarkerForReplay(tokenId);
  compactor_.onCloseCommitted(nPast);

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
      recordPostReasoningTokenIfActive(reasoningState_.cached_newline_token);

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
