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
#include "GenerationParamsApply.hpp"
#include "RequestRecoveryHelpers.hpp"
#include "addon/LlmErrors.hpp"
#include "common/common.h"
#include "common/log.h"
#include "inference-addon-cpp/Logger.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LogSafeString.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ModelMemoryPolicy.hpp"
#include "utils/ReasoningUtils.hpp"
#include "utils/ScopeGuard.hpp"
#include "utils/SequenceStateSnapshot.hpp"
#include "utils/StopStringMatch.hpp"

using namespace qvac_lib_inference_addon_llama;
using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_llama::request_recovery;
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
    common_params& commonParams, common_init_result_ptr llamaInit)
    : llamaInit_(std::move(llamaInit)), params_(commonParams) {
  modelCtx_.model = llamaInit_->model();
  modelCtx_.lctx = llamaInit_->context();
  initializeCommonState();
  initializeOwnedThreadpools();
}

TextLlmContext::TextLlmContext(
    const common_params& commonParams, const LlmModelContext& shared,
    llama_seq_id seqId, llama_pos perSeqCtxCeiling)
    : modelCtx_(shared), params_(commonParams),
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

  // Any model whose memory is not a plain positionally indexed KV cache
  // needs full-state snapshots, because `seq_rm` cannot remove an
  // arbitrary tail safely. Today that is recurrent state, hybrid SSM +
  // attention, and DeepSeek V4's compressed cache; the list lives in
  // `needsFullStateSnapshot` (ModelMemoryPolicy.hpp).
  //
  // We deliberately do NOT gate on `llama_memory_can_shift`: that
  // predicate is about RoPE-based K-shift (position shifting) and
  // returns `true` for all memory types in fabric today, including
  // recurrent and hybrid. The real architectural property we care
  // about is "does this model need full-state restore?" DeepSeek V4 needs
  // that path as well even though its compressed cache is not reported by
  // either model predicate.
  const auto* const model = modelCtx_.model;
  const std::optional<std::string> architecture =
      qvac_lib_inference_addon_llama::utils::getModelArchitecture(model);
  const bool isDeepSeekV4 =
      architecture.has_value() &&
      qvac_lib_inference_addon_llama::utils::isDeepSeekV4Architecture(
          architecture.value());
  needsFullStateSnapshot_ =
      (model != nullptr) &&
      qvac_lib_inference_addon_llama::utils::needsFullStateSnapshot(
          llama_model_is_recurrent(model),
          llama_model_is_hybrid(model),
          isDeepSeekV4);
  // EOS-inside-reasoning recovery (close-marker substitution +
  // trailing newlines) is a Qwen3-specific workaround. Gate it on the
  // explicit Qwen3-family predicate so the policy is documented at the
  // call site and cannot drift if `selectReasoningTagsForArchitecture`
  // is later extended to cover non-Qwen families. Other families with
  // a recognised channel (e.g. Gemma 4) still get detection, just not this
  // recovery.
  {
    isQwen3ReasoningFamily_ =
        architecture.has_value() &&
        qvac_lib_inference_addon_llama::utils::
            isQwen3ReasoningFamilyArchitecture(architecture.value());
  }
  // Generated reasoning stays resident. A later authoritative full prompt
  // either includes it (and reuses it) or omits it (and prefix reconciliation
  // removes it), matching llama-server's lazy behavior.

  // Precompute the EOG token id set used by the EOS-inside-reasoning recovery
  // (see `banEogAfterReasoningRecovery_`). Only the Qwen3 family arms that
  // ban, so the scan is gated on it. Computed once here so the recovery path
  // never does an O(nVocab) scan mid-stream, matching this file's
  // compute-once-at-load convention. Valid for the instance lifetime because
  // `modelCtx_` (copy/move deleted) is never reassigned.
  if (isQwen3ReasoningFamily_) {
    const int32_t nVocab = llama_vocab_n_tokens(modelCtx_.vocab);
    eogTokens_.reserve(8);
    for (llama_token t = 0; t < nVocab; ++t) {
      if (llama_vocab_is_eog(modelCtx_.vocab, t)) {
        eogTokens_.push_back(t);
      }
    }
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

  const std::string chatTemplate = getChatTemplate(modelCtx_.model, params_);
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

  antipromptLower_.reserve(params_.antiprompt.size());
  for (const std::string& antiprompt : params_.antiprompt) {
    antipromptLower_.push_back(
        qvac_lib_inference_addon_llama::utils::toLowerAscii(antiprompt));
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
  if (antipromptLower_.empty() && templateStops_.empty()) {
    return false;
  }
  constexpr int kNPrev = 32;
  std::string lastOutput =
      common_sampler_prev_str(smpl_.get(), modelCtx_.lctx, kNPrev);

  // Caller antiprompts fold case; template stops are compared raw. See
  // `matchesAnyStopString` for why the two must not share one rule, and
  // `MtmdLlmContext::checkAntiprompt`, which calls the same function so the
  // two contexts cannot drift.
  if (qvac_lib_inference_addon_llama::utils::matchesAnyStopString(
          lastOutput, antipromptLower_, templateStops_)) {
    return true;
  }

  // check for reverse prompt using special tokens
  llama_token lastToken = common_sampler_last(smpl_.get());
  for (auto token : antipromptTokens_) {
    if (token == lastToken) {
      return true;
    }
  }
  for (auto token : templateStopTokens_) {
    if (token == lastToken) {
      return true;
    }
  }
  return false;
}
void TextLlmContext::requireSampler() {
  if (smpl_) {
    return;
  }
  // One rebuild attempt before giving up. The only other assignment sites are
  // the constructor and the two inside `tokenizeChat`, and this check runs
  // ahead of both — so without this attempt a single failed restore would
  // brick the context for every later request, not just the next one, and
  // recovery would mean reloading the model.
  try {
    smpl_.reset(common_sampler_init(modelCtx_.model, params_.sampling));
  } catch (const std::exception& ex) {
    // Surfaces below as a StatusError rather than escaping as a fabric
    // exception; the message keeps the reason.
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[TextLlm] sampler rebuild threw: %s\n",
            forLogMessage(ex.what(), K_MAX_LOG_DIAGNOSTIC).c_str()));
  }
  if (smpl_) {
    QLOG_IF(
        Priority::WARNING,
        "[TextLlm] rebuilt the sampler after an earlier restore failure\n");
    return;
  }
  std::string errorMsg = string_format(
      "[TextLlm] %s: no sampler is installed and it could not be rebuilt from "
      "the current sampling parameters\n",
      __func__);
  throw qvac_errors::StatusError(
      ADDON_ID, toString(UnableToCreateSamplingSystem), errorMsg);
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
  // A previous request's generation-params restore can fail to rebuild the
  // sampler and leave it null (see GenerationParamsApply). Reject the request
  // here: fabric's `common_sampler_sample` dereferences without a null check,
  // so without this the failure surfaces as a SIGSEGV that takes the whole
  // runtime down instead of one request.
  requireSampler();

  std::string prompt;
  common_chat_templates_inputs inputs;

  bool isLastMessageFromUser = false;
  bool addSpecial = false;

  if (cacheReconciliationEnabled_) {
    const auto& lastRole = chatMsgs.back().role;
    isLastMessageFromUser = lastRole == "user" || lastRole == "tool";
    addSpecial = true;
  } else if (nPast_ == 0 && !isCacheLoaded) {
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

  // `tool_choice` may narrow the tool list (named function) and decides
  // whether the template emits an eager, lazy or no tool grammar. A
  // per-request `json_schema` is deliberately NOT handed to the template:
  // fabric's handlers return a response-format-only parser and exclude tool
  // calls, so composing gains nothing over the sampler-side OUTPUT_FORMAT
  // grammar and silently yields a never-arming lazy grammar on several
  // model families.
  // Not const: `tools` is moved into `inputs` below. Only `.choice` is read
  // afterwards.
  ResolvedToolChoice toolChoice =
      resolveToolChoice(renderOverrides_.toolChoice, tools);
  if (!toolChoice.tools.empty()) {
    inputs.tools = std::move(toolChoice.tools);
    inputs.tool_choice = toolChoice.choice;
  }
  // Not const: `prompt` and `additionalStops` are moved out below. On base
  // `getPrompt` returned `std::string` and this assignment moved; binding the
  // struct by const value turned it into a copy of the whole formatted chat
  // history, reallocated every turn. Everything read from `rendered`
  // afterwards is a different field.
  PromptRenderResult rendered = getPrompt(tmpls_.get(), inputs);
  prompt = std::move(rendered.prompt);
  if (rendered.toolDefinitionsDropped) {
    ++toolDefinitionsDropped_;
  }
  thinkingForcedOpen_ = rendered.thinkingForcedOpen;
  thinkingForcedOpenText_ = thinkingForcedOpen_ ? getThinkingForcedOpenText(
                                                      rendered.generationPrompt,
                                                      rendered.thinkingStartTag)
                                                : std::string{};
  // Resolved once and shared by the reasoning detector below and the
  // reasoning-budget markers in `configureTemplateDerivedSampling`. Those two
  // must agree on the tag source or fabric builds no reasoning-budget sampler
  // for a family-fallback model — see `selectReasoningBudgetTags`.
  const std::optional<ReasoningTags> fallbackReasoningTags =
      selectReasoningTagsForModel(modelCtx_.model);
  configureReasoningTags(
      rendered.thinkingStartTag,
      rendered.thinkingEndTag,
      fallbackReasoningTags);
  const Tokenizer tokenize = [this](const std::string& text) {
    return ::common_tokenize(modelCtx_.lctx, text, false, true);
  };
  // Template stop strings are per request: replace, never accumulate. No
  // template any qvac package ships populates `additional_stops`, so these
  // lists are empty for those models. It is not empty by construction —
  // fabric's PEG auto-parser pushes `"</assistant>"` for laguna_glm_thinking
  // templates — so a user-supplied model can legitimately land stops here and
  // generation will honour them.
  // Stored as the template produced them, with no case-folded twin: these are
  // protocol delimiters and `checkAntiprompt` compares them byte-for-byte.
  templateStops_ = std::move(rendered.additionalStops);
  templateStopTokens_.clear();
  for (const std::string& stop : templateStops_) {
    const auto ids = tokenize(stop);
    if (ids.size() == 1) {
      templateStopTokens_.push_back(ids[0]);
    }
  }
  // Snapshot before configuring: `common_sampler_init` *throws* on a grammar
  // it cannot parse, and the new sampling block is already committed by then.
  // Without this rollback a template- or caller-derived grammar that fails to
  // build stays resident in `params_` for the life of the loaded model, so
  // every later request rebuilding the sampler fails too.
  common_params_sampling savedSampling = params_.sampling;
  // `inputs.tools`, not the caller's `tools`: `getPrompt` clears the former on
  // a drop, and that strip is what must stop a tool grammar being armed for
  // definitions the model never read. Reading the caller's list here left that
  // contract documented and unenforced.
  if (configureTemplateDerivedSampling(
          params_,
          tokenize,
          rendered,
          !inputs.tools.empty(),
          fallbackReasoningTags)) {
    try {
      CommonSamplerPtr nextSmpl(
          common_sampler_init(modelCtx_.model, params_.sampling));
      if (!nextSmpl) {
        std::string errorMsg = string_format(
            "[TextLlm] %s: failed to initialize sampling subsystem\n",
            __func__);
        throw qvac_errors::StatusError(
            ADDON_ID, toString(UnableToCreateSamplingSystem), errorMsg);
      }
      smpl_ = std::move(nextSmpl);
    } catch (...) {
      params_.sampling = std::move(savedSampling);
      throw;
    }
  }
  // An explicit `tool_choice` is a demand: fail rather than silently answer
  // in prose when the template dropped the tools or refused a grammar.
  requireToolChoiceHonoured(
      toolChoice.choice,
      rendered.toolDefinitionsDropped,
      params_.sampling.grammar.type == COMMON_GRAMMAR_TYPE_TOOL_CALLS,
      "[TextLlm]");

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
  // Clear per-inference rollback state before capturing this request's generic
  // prefill-entry checkpoint.
  requestRollback_.clear();
  lastGeneratedTokenCount_ = 0;

  const std::vector<llama_token> inputTokens =
      preparePrefill(chatMsgs, tools, {}, {}, isCacheLoaded, prefill).tokens;
  const auto nTokens = static_cast<llama_pos>(inputTokens.size());

  // Captured AFTER `preparePrefill` so the anchor reflects any position
  // change that preparation made. The scheduler admission takes the same
  // anchor after its own `preparePrefill`.
  snapshotPreRequestCursor();
  LlamaBatch textBatch(params_.n_batch, 0, 1);

  // Snapshot the sequence state at prefill entry on full-state-snapshot
  // memory so a mid-prefill cancellation can roll back to the exact
  // pre-prefill cache. Pure-attention models use `removeLastNTokens`
  // (which is a no-op for recurrent memory per PR #2808), so the
  // snapshot is skipped on that path. A cached request rolls back through
  // its own transaction snapshot (cancel during prefill, failures), so it
  // skips this capture too.
  if (needsFullStateSnapshot_ && !cacheRequestActive_) {
    if (!requestRollback_.capture(modelCtx_.lctx, seqId_, nPast_)) {
      // Capture failed: the cancel path will be unable to roll back the
      // recurrent half of the cache, so degrade to a warning.
      QLOG_IF(
          Priority::WARNING,
          "[TextLlm] failed to capture prefill-entry full-state snapshot; "
          "mid-prefill cancel will not roll back recurrent state\n");
    }
  }

  llama_pos count = nPast_;
  llama_pos tokenIndex = 0;
  while (tokenIndex < nTokens) {
    if (stopGeneration_.load()) {
      if (cacheRequestActive_) {
        // Cached request cancelled before it produced anything: restore the
        // state from before the prompt was sent. `nPast_` already counts the
        // decoded batches, so the transaction rollback trims or restores
        // exactly what this request added.
        stopGeneration_.store(false);
        return {
            .ok = false,
            .cancelled = true,
            .rollbackOk = rollbackCurrentRequest([](const std::string&) {})};
      }
      // A prior chunk's llama_decode may have queued GPU work whose logits are
      // never read on the cancel path. Finish it before rolling KV back.
      llama_synchronize(modelCtx_.lctx);
      bool rollbackOk = true;
      if (requestRollback_.hasSnapshot()) {
        // Recurrent / hybrid path: full-state restore is the only way
        // to drop partially decoded tokens; `removeLastNTokens` is a
        // no-op on recurrent memory and `seq_rm` over a partial tail
        // is rejected by the recurrent module.
        const llama_pos restoredNPast = requestRollback_.nPast();
        if (requestRollback_.restore(modelCtx_.lctx, seqId_)) {
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
                  "[TextLlm] prefill-entry full-state snapshot restore "
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
        if (needsFullStateSnapshot_ && nPast_ > preRequestNPast_) {
          nPast_ = preRequestNPast_;
          rollbackOk = false;
        }
      }
      stopGeneration_.store(false);
      return {.ok = false, .cancelled = true, .rollbackOk = rollbackOk};
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
  prefillComplete_ = false;

  std::vector<llama_token> inputTokens;
  tokenizeChat(chatMsgs, tools, inputTokens, isCacheLoaded);

  if (cacheReconciliationEnabled_) {
    beginCacheRequest();
    inputTokens = reconcilePrompt(inputTokens, isPrefillOnlyRequest);
  }

  const size_t nTokens = inputTokens.size();

  // Per-slot usable window: the partitioned per-sequence cap in batch mode,
  // else the full context. Overflow must measure against this so the driver
  // agrees with the scheduler about what fits.
  const llama_pos ceiling = ctxCeiling();

  // exceedsContextWindow mirrors the scheduler's admission, so the driver never
  // rejects a prompt the scheduler already let in.
  if (exceedsContextWindow(
          static_cast<llama_pos>(nTokens), ceiling, isPrefillOnlyRequest)) {
    std::string errorMsg = string_format(
        "[TextLlm] context overflow at batch prefill step: prompt tokens %zu, "
        "max context tokens %d\n",
        nTokens,
        ceiling);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextOverflow), errorMsg);
  }
  // Cached conversation plus this prompt: the context is full, and there is
  // nothing to evict any more, so the request cannot proceed.
  if (exceedsContextWindow(
          nPast_ + static_cast<llama_pos>(nTokens),
          ceiling,
          isPrefillOnlyRequest)) {
    std::string errorMsg = string_format(
        "[TextLlm] context overflow at batch prefill step: cached tokens %d "
        "plus prompt tokens %zu exceed the max context tokens %d\n",
        nPast_,
        nTokens,
        ceiling);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextOverflow), errorMsg);
  }

  return PrefillPlan{.tokens = std::move(inputTokens)};
}

void TextLlmContext::syncPosition(llama_pos currentPos) { nPast_ = currentPos; }

void TextLlmContext::onPrefillComplete(
    llama_pos currentPos, size_t prefillTokenCount) {
  nPast_ = currentPos;
  prefillComplete_ = true;
  if (cacheRequestActive_) {
    residentLedger_ = pendingPromptLedger_;
    // Match llama-server's sampler initialization: after prefill, rebuild
    // history from the complete authoritative prompt, not only the reused
    // prefix or decoded suffix.
    rebuildSamplerFromLedger(residentLedger_);
    capturePendingCheckpoint();
    if (isPrefillOnlyRequest_) {
      commitCacheRequest();
    }
  }
  // Reset per-inference reasoning detection state here (shared by the
  // single-prompt and continuous-batching paths).
  reasoningState_.inside_reasoning = false;
  reasoningState_.recent_output_buffer.clear();
  // Template force-opened the reasoning channel (e.g. Qwen3 / DeepSeek-R1
  // assistant prefix ends with `<think>\n`). Mark the parser as already
  // inside reasoning; the tokens remain resident until prompt reconciliation.
  if (thinkingForcedOpen_ && reasoningEnabled_) {
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
  if (outputCallback) {
    outputCallback(text);
  }
}

LlmContext::GenerateResponseResult TextLlmContext::generateResponse(
    const std::function<void(const std::string&)>& outputCallback) {

  LlamaBatch batch(1, 0, 1); // batch for next token generation
  unsigned generatedAfterAccept = 0;

  forcedTokens_.clear();
  banEogAfterReasoningRecovery_ = false;
  generationStopReason_ = GenerationStopReason::None;

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
      generationStopReason_ = GenerationStopReason::ContextOverflow;
      break;
    }
    if (step.decodedInline) {
      // handleReasoningEOS counts the tokens it commits itself: it decodes the
      // substituted close tag plus up to two newlines, so one increment here
      // would undercount by up to two.
      continue;
    }
    if (step.finished) {
      generationStopReason_ = step.stopReason;
      break;
    }

    common_batch_clear(*batch);
    if (stopGeneration_.load()) {
      // Route through the post-loop `onCancel` instead of injecting
      // EOT — EOT would advance `nPast_` past the rollback target.
      //
      // `onLogitsReady` already streamed this token, so the caller saw it.
      ++lastGeneratedTokenCount_;
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
    appendResidentToken(step.token);
    ++lastGeneratedTokenCount_;
  }

  // Unified post-loop cancel for both hybrid/recurrent and pure-attention.
  // Mid-loop cancel exits leave `stopGeneration_` set and skip EOT.
  if (stopGeneration_.load()) {
    stopGeneration_.store(false);
    return {
        .ok = true, .cancelled = true, .rollbackOk = onCancel(outputCallback)};
  }
  if (generationStopReason_ == GenerationStopReason::None &&
      params_.n_predict > 0 &&
      generatedAfterAccept >= static_cast<unsigned>(params_.n_predict)) {
    generationStopReason_ = GenerationStopReason::PredictionLimit;
  }
  const bool rollbackOk =
      onGenerationFinished(outputCallback, generationStopReason_);
  return {.rollbackOk = rollbackOk};
}

SequenceStepResult TextLlmContext::onLogitsReady(
    int logitIdx, unsigned generatedAfterAccept,
    const std::function<void(const std::string&)>& outputCallback,
    LlamaBatch* inlineDecodeBatch) {
  if (stopGeneration_.load()) {
    // Leave `stopGeneration_` set so the post-loop `onCancel` runs;
    // do NOT emit EOT since the rollback drops all sampled tokens.
    return {.finished = true};
  }

  // The context is 100% full: no room for even one more token, and nothing
  // is evicted to make room any more. Stop here and report why, so the
  // caller can tell a full context from a prediction-limit cutoff.
  if (contextWindowFull(nPast_, ctxCeiling())) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[TextLlm] generation stopped: context is full, no space left for "
            "another token (nPast=%d, nCtx=%d)\n",
            nPast_,
            ctxCeiling()));
    return {
        .finished = true,
        .contextOverflow = true,
        .stopReason = GenerationStopReason::ContextOverflow};
  }

  bool sampledToken = forcedTokens_.empty();
  llama_token tokenId = LLAMA_TOKEN_NULL;
  if (sampledToken) {
    if (banEogAfterReasoningRecovery_) {
      banEogAfterReasoningRecovery_ = false;
      // Ban EOG for exactly this one token. Unconditional: the generation
      // loop only reaches this sample while the n_predict budget allows it,
      // so banning EOG on the final budgeted sample yields one content
      // token and never extends generation past the budget.
      float* logits = llama_get_logits_ith(modelCtx_.lctx, logitIdx);
      if (logits != nullptr) {
        // `eogTokens_` is precomputed in initializeCommonState().
        for (const llama_token t : eogTokens_) {
          logits[t] = -INFINITY;
        }
      }
    }
    tokenId = common_sampler_sample(smpl_.get(), modelCtx_.lctx, logitIdx);
    // Test-only substitution, never armed in production: the only writer is
    // `forceNextSampledTokenInsideReasoningForTesting`, which exists so a
    // test can drive the EOS-inside-reasoning recovery deterministically
    // instead of waiting for a small model to emit a premature EOS.
    //
    // Gated on `inside_reasoning` rather than firing on the first sample, and
    // that is the whole point of the arming rule: no template this package
    // ships force-opens the reasoning channel (Qwen3 emits `<think>` itself as
    // its first generated token), so an unconditional substitution would land
    // *before* the block opens and the recovery would never run.
    // `inside_reasoning` still describes the state before this token, which is
    // exactly the "EOS sampled while the block is open" case.
    //
    // Placed BEFORE the accept so the sampler's history records what a genuine
    // sample of this token would have recorded, which is what makes the branch
    // below a faithful rehearsal rather than an approximation.
    if (forcedNextSampledTokenForTesting_ != LLAMA_TOKEN_NULL &&
        reasoningState_.inside_reasoning) {
      tokenId = forcedNextSampledTokenForTesting_;
      forcedNextSampledTokenForTesting_ = LLAMA_TOKEN_NULL;
    }
    common_sampler_accept(smpl_.get(), tokenId, true);
  } else {
    tokenId = forcedTokens_.front();
    forcedTokens_.erase(forcedTokens_.begin());
    // Forced tokens are emitted output, so the sampler's history must see
    // them: `prev` is what `common_sampler_prev_str` returns and
    // `checkAntiprompt` scans, and the chain owns the penalty state.
    //
    // Scope: this is the batch path. The single-prompt path substitutes in
    // `handleReasoningEOS`, which injects the same tokens without accepting
    // them at all — a pre-existing asymmetry this comment does not claim to
    // have fixed. See the note at that injection site.
    //
    // `is_generated = false` is load-bearing, not a default. A forced token
    // was never grammar-sampled, so the grammar may not accept it — and
    // `llama_grammar_accept_impl` assigns the emptied stack *before* it
    // throws (fabric src/llama-grammar.cpp:1516-1522), so feeding one both
    // breaks the grammar and throws from a call `common_sampler_accept` does
    // not guard. That throw would escape to ContinuousBatchScheduler's step
    // handler, which fails every co-scheduled request, not just this one.
    // `false` skips `grmr` and `rbudget` and cannot throw; the grammar
    // stays out of step with the substituted text, which is the KNOWN
    // LIMITATION recorded at the substitution site below.
    common_sampler_accept(smpl_.get(), tokenId, false);
  }

  std::string tokenStr =
      common_token_to_piece(modelCtx_.lctx, tokenId, params_.special);
  const std::string completeChars = utf8Buffer_.addToken(tokenStr);
  if (!completeChars.empty()) {
    emitOutputPiece(outputCallback, completeChars);
  }

  if (reasoningEnabled_) {
    qvac_lib_inference_addon_llama::utils::updateReasoningBuffer(
        tokenStr, reasoningState_);
  }

  const bool isEos = llama_vocab_is_eog(modelCtx_.vocab, tokenId);
  if (sampledToken && isEos && isQwen3ReasoningFamily_) {
    if (inlineDecodeBatch != nullptr) {
      if (handleReasoningEOS(
              tokenId, tokenStr, **inlineDecodeBatch, nPast_, outputCallback)) {
        return {.token = tokenId, .finished = false, .decodedInline = true};
      }
    } else if (
        reasoningState_.inside_reasoning &&
        reasoningState_.cached_close_tag_token != LLAMA_TOKEN_NULL) {
      // The sampler already accepted the original EOS above, but the text
      // emitted is this close tag instead, so the two are one token out of
      // step for the rest of the request. The accept below repairs the half
      // that matters; see the comment on it for the half that remains.
      //
      // The forced newlines queued below are deliberately NOT fed to the
      // grammar (see the `is_generated = false` accept above): doing so
      // would turn a bounded drift into a throw that fails every
      // co-scheduled request.
      tokenId = reasoningState_.cached_close_tag_token;
      tokenStr =
          common_token_to_piece(modelCtx_.lctx, tokenId, params_.special);
      // Hand the substituted close tag to the sampler so fabric's
      // reasoning-budget matcher advances to DONE. Without this it stays in
      // COUNTING for the whole request — the EOS it did see advances no end
      // matcher, and at an unlimited budget `remaining` is INT_MAX, so the
      // only other exit never arrives (fabric reasoning-budget.cpp:93-131).
      // `grammar_should_apply` then returns false for a *lazy* grammar in
      // COUNTING (sampling.cpp:459-462), which silently disarms the tool
      // grammar for the rest of the request on the default
      // `tool_choice: "auto"` — the PR's whole constraint switching itself
      // off with no error.
      //
      // Restricted to a lazy grammar *with a reasoning-budget sampler
      // actually built*, and that pair is what makes it safe: only then does
      // fabric compute `accept_grammar == false` and skip the grammar
      // sampler, which cannot therefore throw on this token. `grammar_lazy`
      // alone is not enough — `grammar_should_apply` returns true when there
      // is no budget sampler at all (sampling.cpp:456-457), and the token
      // would reach `llama_grammar_accept_token`, which throws on a piece the
      // grammar does not admit. An eager grammar cannot reach this branch at
      // all — EOG is masked to -INFINITY unless a grammar stack is empty
      // (llama-grammar.cpp:1360-1381).
      if (params_.sampling.grammar_lazy &&
          reasoningBudgetSamplerBuilt(params_.sampling)) {
        common_sampler_accept(smpl_.get(), tokenId, true);
      }
      reasoningState_.inside_reasoning = false;
      if (reasoningState_.cached_newline_token != LLAMA_TOKEN_NULL) {
        forcedTokens_.push_back(reasoningState_.cached_newline_token);
        forcedTokens_.push_back(reasoningState_.cached_newline_token);
      }
      banEogAfterReasoningRecovery_ = true;
      const std::string completeChars = utf8Buffer_.addToken(tokenStr);
      if (!completeChars.empty()) {
        emitOutputPiece(outputCallback, completeChars);
      }
      return {.token = tokenId, .finished = false};
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
    generationStopReason_ = GenerationStopReason::Eos;
    return {
        .token = tokenId,
        .finished = true,
        .stopReason = GenerationStopReason::Eos};
  }
  GenerationStopReason stopReason = GenerationStopReason::None;
  if (isEos) {
    stopReason = GenerationStopReason::Eos;
  } else if (reachedBudget) {
    stopReason = GenerationStopReason::PredictionLimit;
  } else if (checkAntiprompt()) {
    stopReason = GenerationStopReason::Antiprompt;
  }
  const bool finished = stopReason != GenerationStopReason::None;
  if (finished) {
    generationStopReason_ = stopReason;
    flushPendingUtf8ToCallback(outputCallback);
  }

  // The scheduler decodes this non-terminal token on its next step. Record it
  // provisionally now; any decode/cancel failure restores the pre-request
  // ledger and state transactionally.
  if (!finished && inlineDecodeBatch == nullptr) {
    appendResidentToken(tokenId);
  }

  return {.token = tokenId, .finished = finished, .stopReason = stopReason};
}

void TextLlmContext::onSequenceEnd(
    const std::function<void(const std::string&)>& outputCallback) {
  flushPendingUtf8ToCallback(outputCallback);
}

bool TextLlmContext::onGenerationFinished(
    const std::function<void(const std::string&)>& outputCallback,
    GenerationStopReason terminalReason) {
  if (terminalReason != GenerationStopReason::None) {
    generationStopReason_ = terminalReason;
  }
  onSequenceEnd(outputCallback);
  // An empty generation that stopped for a committing reason (immediate EOS)
  // is a valid answer and commits like any other; only the stop reason
  // decides.
  if (!commitsCacheRequest(generationStopReason_)) {
    return rollbackCurrentRequest(outputCallback);
  }
  commitCacheRequest();
  // Generation completed; cancel cannot fire anymore so the
  // prefill-entry rollback checkpoint is no longer reachable. Drop
  // its temp file now instead of waiting for the next inference.
  requestRollback_.clear();
  // `generationStopReason_` intentionally persists: runtime stats read
  // it after generateResponse() returns; it is re-initialized at the
  // next generation's entry.
  return true;
}

bool TextLlmContext::onCancel(
    const std::function<void(const std::string&)>& outputCallback) {
  // Once prefill completed the caller has received the prompt's answer as
  // far as it got, so the request keeps its state (and commits its cache
  // transaction when one is active). Cancelled during prefill it rolls back
  // to the pre-request state like any failure. Same rule with or without
  // `cacheKey`; without one the difference is only visible in `CacheTokens`.
  if (prefillComplete_) {
    return commitCancelledRequest(outputCallback);
  }
  return rollbackCurrentRequest(outputCallback);
}

bool TextLlmContext::onFailure(
    const std::function<void(const std::string&)>& outputCallback) {
  return rollbackCurrentRequest(outputCallback);
}

bool TextLlmContext::commitCancelledRequest(
    const std::function<void(const std::string&)>& outputCallback) {
  // Cancel after prefill completed keeps what the caller already received,
  // exactly like a prediction-limit stop: the prompt and every streamed
  // token stay resident and the next full-history turn extends them. Finish
  // queued backend work first so the KV the ledger describes is complete.
  llama_synchronize(modelCtx_.lctx);
  flushPendingUtf8ToCallback(outputCallback);
  if (cacheRequestActive_) {
    commitCacheRequest();
  }
  requestRollback_.clear();
  // Sampler history is rebuilt from the ledger by the next request.
  common_sampler_reset(smpl_.get());
  return true;
}

bool TextLlmContext::rollbackCurrentRequest(
    const std::function<void(const std::string&)>& outputCallback) {
  // Rollback = "request never happened": restore the pre-request cursor.
  // Reached for failures, context overflow and cancels during prefill; a
  // cancel after prefill completed keeps the state instead (see
  // `commitCancelledRequest`).
  // If cancellation lands after llama_decode() but before the next sampler
  // read, the implicit sampler-side synchronize is skipped. Finish any queued
  // backend work before mutating KV/recurrent state during rollback.
  llama_synchronize(modelCtx_.lctx);
  flushPendingUtf8ToCallback(outputCallback);

  if (cacheRequestActive_) {
    const bool ok = restorePreRequestCacheState();
    common_sampler_reset(smpl_.get());
    generationStopReason_ =
        stopReasonAfterRequestRollback(generationStopReason_);
    return ok;
  }

  const bool rollbackOk = rollbackCancelledRequest({
      .labelTag = "[TextLlm]",
      .ctx = modelCtx_.lctx,
      .seqId = seqId_,
      .needsFullStateSnapshot = needsFullStateSnapshot_,
      .currentPos = nPast_,
      .preRequestPos = preRequestNPast_,
      .rollback = requestRollback_,
      .onSnapshotRestored =
          [this](llama_pos restoredNPast) { nPast_ = restoredNPast; },
      .onSnapshotRestoreFailed =
          [this](llama_pos restoredNPast) { nPast_ = restoredNPast; },
      .onMissingSnapshotAdvanced = [this]() { nPast_ = preRequestNPast_; },
      .removeLastNTokens =
          [this](llama_pos delta) { removeLastNTokens(delta); },
      .onPureAttentionRolledBack = [this]() { nPast_ = preRequestNPast_; },
  });

  requestRollback_.clear();
  generationStopReason_ = stopReasonAfterRequestRollback(generationStopReason_);
  // The sampled tokens were accepted before rollback; clear sampler history so
  // the next clean request cannot inherit a request that "never happened".
  common_sampler_reset(smpl_.get());
  return rollbackOk;
}

void TextLlmContext::configureReasoningTags(
    const std::string& thinkingStartTag, const std::string& thinkingEndTag,
    const std::optional<ReasoningTags>& fallbackTags) {
  // Family-default tags act as both the fallback when the active chat
  // template does not expose reasoning tags, and as the source for the
  // Qwen-family single-token close marker used by EOS-inside-reasoning
  // recovery. Resolved by the caller so the lookup runs at most once per
  // prompt render and the reasoning-budget markers can be derived from the
  // same value.
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

  const bool reasoningInitOk = initializeReasoningState(
      modelCtx_.lctx, reasoningState_, *reasoningTags, eosRecoveryCloseTag);
  if (reasoningInitOk) {
    reasoningEnabled_ = true;
    return;
  }

  QLOG_IF(
      Priority::WARNING,
      string_format(
          "[TextLlm] reasoning detection disabled for marker '%s'\n",
          reasoningTags->open.c_str()));
}

int32_t TextLlmContext::getToolDefinitionsDropped() const {
  return toolDefinitionsDropped_;
}

void TextLlmContext::resetToolDefinitionsDropped() {
  toolDefinitionsDropped_ = 0;
}

std::vector<llama_token> TextLlmContext::cacheStateTokens() const {
  return cache::serialize(residentLedger_, nPast_, nPast_);
}

void TextLlmContext::restoreCacheStateTokens(
    const std::vector<llama_token>& tokens) {
  const cache::DecodedLedger decoded =
      cache::deserialize(tokens.data(), tokens.size());
  if (decoded.nPast != decoded.cacheTokens) {
    throw std::runtime_error("text cache has divergent position/KV totals");
  }
  residentLedger_ = decoded.ledger;
  nPast_ = decoded.nPast;
  cacheCheckpoints_.clear();
  pendingCheckpoint_.reset();
}

void TextLlmContext::clearCacheReconciliationState() {
  residentLedger_.entries.clear();
  pendingPromptLedger_.entries.clear();
  preRequestLedger_.entries.clear();
  preRequestCacheSnapshot_.clear();
  pendingCheckpoint_.reset();
  cacheCheckpoints_.clear();
  cacheRequestActive_ = false;
  cacheRequestRolledBack_ = false;
}

bool TextLlmContext::rollbackFailedRequest() {
  return !cacheRequestActive_ || restorePreRequestCacheState();
}

void TextLlmContext::beginCacheRequest() {
  cacheRequestActive_ = true;
  cacheRequestRolledBack_ = false;
  preRequestNPast_ = nPast_;
  preRequestLedger_ = residentLedger_;
  pendingPromptLedger_.entries.clear();
  pendingCheckpoint_.reset();
  preRequestCacheSnapshot_.clear();
  // Pure-attention memory rolls back with a tail trim to `preRequestNPast_`,
  // so a full-state dump is only taken when reconciliation is about to
  // discard resident state that a trim cannot bring back (see
  // `reconcilePrompt`). Models that cannot trim need it up front.
  if (needsFullStateSnapshot_) {
    capturePreRequestCacheSnapshot();
  }
}

void TextLlmContext::capturePreRequestCacheSnapshot() {
  if (!preRequestCacheSnapshot_.empty()) {
    return;
  }
  if (!snapshotSequenceState(
          modelCtx_.lctx, seqId_, nPast_, preRequestCacheSnapshot_)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToSaveSessionFile),
        "[TextLlm] failed to snapshot cache before prompt reconciliation");
  }
}

void TextLlmContext::rebuildSamplerFromLedger(const cache::Ledger& ledger) {
  common_sampler_reset(smpl_.get());
  for (const cache::Entry& entry : ledger.entries) {
    if (entry.kind == cache::EntryKind::Token) {
      common_sampler_accept(
          smpl_.get(), static_cast<llama_token>(entry.identity), false);
    }
  }
}

std::vector<llama_token> TextLlmContext::reconcilePrompt(
    const std::vector<llama_token>& fullPrompt, bool isPrefillOnlyRequest) {
  pendingPromptLedger_ = cache::fromTokens(fullPrompt);
  const size_t prefix =
      cache::commonPrefix(residentLedger_, pendingPromptLedger_);
  const size_t cachedLength = residentLedger_.entries.size();
  // A fully reused prompt has no decode step and therefore produces no fresh
  // logits for generation. Match llama-server's cache-prompt behavior by
  // backing up one token so the final prompt token is decoded again. A
  // prefill-only request needs no logits and can reuse the complete prompt.
  size_t reuseTarget = prefix;
  if (!isPrefillOnlyRequest && reuseTarget == fullPrompt.size() &&
      reuseTarget > 0) {
    --reuseTarget;
  }
  size_t reuse = reuseTarget;
  std::string checkpoint = "none";

  if (needsFullStateSnapshot_ && reuseTarget < cachedLength) {
    reuse = 0;
    for (auto it = cacheCheckpoints_.rbegin(); it != cacheCheckpoints_.rend();
         ++it) {
      const size_t checkpointSize = it->ledger.entries.size();
      if (checkpointSize <= reuseTarget &&
          cache::commonPrefix(it->ledger, pendingPromptLedger_) ==
              checkpointSize &&
          restoreSequenceState(modelCtx_.lctx, seqId_, it->state)) {
        residentLedger_ = it->ledger;
        nPast_ = residentLedger_.positions();
        reuse = checkpointSize;
        checkpoint = std::to_string(checkpointSize);
        break;
      }
    }
    if (reuse == 0) {
      clearSequenceMemory(modelCtx_.lctx);
      residentLedger_.entries.clear();
      nPast_ = 0;
      checkpoint = "cold";
    }
  } else if (!needsFullStateSnapshot_ && reuseTarget < cachedLength) {
    // The trimmed range is resident state the request may still need back
    // on rollback, and a tail trim cannot restore it. Capture the pre-request
    // dump now; the append-only common case never pays for it.
    capturePreRequestCacheSnapshot();
    const llama_pos reusePos = residentLedger_.positions(reuseTarget);
    clearSequenceMemory(modelCtx_.lctx, reusePos, -1);
    residentLedger_.truncate(reuseTarget);
    nPast_ = reusePos;
  }

  // Checkpoints past the divergence no longer describe an authoritative
  // prefix. Disk restores deliberately have an empty collection.
  for (auto it = cacheCheckpoints_.begin(); it != cacheCheckpoints_.end();) {
    const size_t count = it->ledger.entries.size();
    if (count > prefix ||
        cache::commonPrefix(it->ledger, pendingPromptLedger_) != count) {
      it = cacheCheckpoints_.erase(it);
    } else {
      ++it;
    }
  }

  rebuildSamplerFromLedger(residentLedger_);
  QLOG_IF(
      Priority::DEBUG,
      string_format(
          "[TextLlm] cache reconcile: cached=%zu rendered=%zu common=%zu "
          "firstDivergence=%zu checkpoint=%s reuse=%zu nPast=%d\n",
          cachedLength,
          pendingPromptLedger_.entries.size(),
          prefix,
          prefix,
          checkpoint.c_str(),
          reuse,
          nPast_));

  return std::vector<llama_token>(fullPrompt.begin() + reuse, fullPrompt.end());
}

void TextLlmContext::capturePendingCheckpoint() {
  if (!needsFullStateSnapshot_) {
    return;
  }
  CacheCheckpoint checkpoint;
  checkpoint.ledger = residentLedger_;
  if (!snapshotSequenceState(
          modelCtx_.lctx, seqId_, nPast_, checkpoint.state)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToSaveSessionFile),
        "[TextLlm] failed to capture full-state cache checkpoint");
  }
  pendingCheckpoint_ = std::move(checkpoint);
}

void TextLlmContext::commitCacheRequest() {
  if (!cacheRequestActive_) {
    return;
  }
  if (needsFullStateSnapshot_ && !preRequestCacheSnapshot_.empty()) {
    cache::appendProcessCheckpoint(
        cacheCheckpoints_,
        CacheCheckpoint{
            .state = std::move(preRequestCacheSnapshot_),
            .ledger = preRequestLedger_});
  } else {
    preRequestCacheSnapshot_.clear();
  }
  if (pendingCheckpoint_.has_value()) {
    cache::appendProcessCheckpoint(
        cacheCheckpoints_, std::move(*pendingCheckpoint_));
    pendingCheckpoint_.reset();
  }
  cacheRequestActive_ = false;
  cacheRequestRolledBack_ = false;
}

bool TextLlmContext::restorePreRequestCacheState() {
  bool ok = true;
  if (!preRequestCacheSnapshot_.empty()) {
    ok = restoreSequenceState(modelCtx_.lctx, seqId_, preRequestCacheSnapshot_);
  } else if (nPast_ > preRequestNPast_) {
    // No dump was needed: the request only appended to resident memory, so
    // dropping the appended tail is the exact pre-request state.
    try {
      clearSequenceMemory(modelCtx_.lctx, preRequestNPast_, -1);
    } catch (const std::exception& e) {
      QLOG_IF(
          Priority::WARNING,
          string_format(
              "[TextLlm] cache request tail trim failed on rollback "
              "(preRequestNPast=%d, nPast=%d): %s\n",
              preRequestNPast_,
              nPast_,
              e.what()));
      ok = false;
    }
  }
  residentLedger_ = preRequestLedger_;
  nPast_ = preRequestNPast_;
  pendingPromptLedger_.entries.clear();
  pendingCheckpoint_.reset();
  preRequestCacheSnapshot_.clear();
  cacheRequestActive_ = false;
  cacheRequestRolledBack_ = true;
  return ok;
}

void TextLlmContext::appendResidentToken(llama_token token) {
  if (cacheRequestActive_ && token != LLAMA_TOKEN_NULL) {
    residentLedger_.appendToken(token);
  }
}

bool TextLlmContext::loadCache(const std::string& cacheKey) {
  if (cacheKey.empty() || !isFileInitialized(cacheKey)) {
    return false;
  }

  size_t tokenCount = 0;
  std::vector<llama_token> stateTokens(
      cache::LEDGER_HEADER_WORDS +
      cache::LEDGER_ENTRY_WORDS *
          (static_cast<size_t>(llama_n_ctx(modelCtx_.lctx)) + 1));
  const auto loadedBytes = llama_state_seq_load_file(
      modelCtx_.lctx,
      cacheKey.c_str(),
      seqId_,
      stateTokens.data(),
      stateTokens.size(),
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
    clearCacheReconciliationState();
  });

  stateTokens.resize(tokenCount);
  if (!cache::hasMarker(stateTokens.data(), stateTokens.size())) {
    clearCacheReconciliationState();
    return false;
  }
  try {
    restoreCacheStateTokens(stateTokens);
  } catch (const std::exception& ex) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        "TextLlmContext::loadCache: malformed cache ledger in '" + cacheKey +
            "': " + ex.what());
  }
  const llama_pos metadataNPast = nPast_;
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
  const llama_pos metadataCacheTokens = nPast_;
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

  restoredKvGuard.dismiss();
  return true;
}

void TextLlmContext::saveCache(const std::string& cacheKey) const {
  if (cacheKey.empty()) {
    return;
  }

  const std::vector<llama_token> stateTokens = cacheStateTokens();
  const std::string tmpCacheKey = cacheKey + ".tmp";
  const auto savedBytes = llama_state_seq_save_file(
      modelCtx_.lctx,
      tmpCacheKey.c_str(),
      seqId_,
      stateTokens.data(),
      stateTokens.size());
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
  if (!cacheRequestActive_) {
    preRequestNPast_ = nPast_;
  }
}

void TextLlmContext::snapshotPreRequestRollbackAnchor() {
  if (cacheRequestActive_) {
    return;
  }
  // Pure-attention drivers rely on `removeLastNTokens` in `onCancel`;
  // no snapshot needed. The single-prompt path takes its own capture
  // after `preparePrefill` (see the mid-`evalMessageWithTools` site) —
  // this hook exists specifically so the batch path, which never runs
  // that site, has an equivalent rollback anchor.
  if (!needsFullStateSnapshot_) {
    return;
  }
  if (!requestRollback_.capture(modelCtx_.lctx, seqId_, nPast_)) {
    // Silent failure would make `hasPrefillEntry()` false at cancel
    // time, turn `onCancel`'s rollback into a no-op, and let peak
    // `nPast` leak back into `CacheTokens`. This is cancel-path
    // bookkeeping for transactional request recovery
    // cleanup, so we log a warning rather than hard-failing the
    // request.
    QLOG_IF(
        Priority::WARNING,
        "[TextLlm] failed to capture prefill-entry full-state snapshot at "
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

  return restoreSampler;
}

void TextLlmContext::stop() { stopGeneration_.store(true); }

void TextLlmContext::resetStopFlag() { stopGeneration_.store(false); }

void TextLlmContext::resetState(bool resetStats) {
  // Reset the n_past
  nPast_ = 0;
  clearCacheReconciliationState();

  // Clear UTF-8 buffer when resetting state
  utf8Buffer_.clear();
  forcedTokens_.clear();
  banEogAfterReasoningRecovery_ = false;
  thinkingForcedOpen_ = false;
  thinkingForcedOpenText_.clear();
  requestRollback_.clear();
  // Finish queued backend work before mutating KV/recurrent memory.
  llama_synchronize(modelCtx_.lctx);
  clearSequenceMemory(modelCtx_.lctx);

  // Reset performance metrics
  if (resetStats) {
    llama_perf_context_reset(modelCtx_.lctx);
  }

  // Reset sampler if available
  common_sampler_reset(smpl_.get());
}

llama_context* TextLlmContext::getCtx() { return modelCtx_.lctx; }

llama_pos TextLlmContext::getNPast() const { return nPast_; }

void TextLlmContext::setNPast(llama_pos nPast) { this->nPast_ = nPast; }

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

  if (needsFullStateSnapshot_) {
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

  // Same reason as the batch path in `onLogitsReady`: the substituted close
  // tag has to reach fabric's reasoning-budget matcher, or it stays in
  // COUNTING and `grammar_should_apply` keeps a lazy tool grammar disarmed
  // for the rest of the request. Lazy *and* budget-sampler-built, which is
  // what makes the grammar sampler provably not fed this token; see the
  // batch path for why the lazy flag alone is not enough.
  //
  // Deliberately before the decode below so a successfully injected close
  // advances the reasoning-budget matcher before sampling resumes. A failed
  // decode throws and rolls back the whole cached request; the next prompt
  // rebuilds sampler history from the restored resident ledger.
  if (params_.sampling.grammar_lazy &&
      reasoningBudgetSamplerBuilt(params_.sampling)) {
    common_sampler_accept(smpl_.get(), tokenId, true);
  }

  // Decode closing tag
  common_batch_clear(batch);
  common_batch_add(batch, tokenId, nPast, {seqId_}, true);
  const bool forceCloseDecodeFailure =
      std::exchange(forceReasoningRecoveryDecodeFailureForTesting_, false);
  if (forceCloseDecodeFailure || llama_decode(modelCtx_.lctx, batch) != 0) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(FailedToDecode),
        "[TextLlm] failed to decode reasoning close tag");
  }
  ++nPast;
  appendResidentToken(tokenId);
  ++lastGeneratedTokenCount_;

  // Publish the synthetic close only after it is resident in KV. If decode
  // fails, the request rolls back without exposing output that was never
  // committed to the model context.
  std::string completeChars = utf8Buffer_.addToken(tokenStr);
  if (!completeChars.empty()) {
    emitOutputPiece(outputCallback, completeChars);
  }

  // KNOWN LIMITATION, pre-existing and narrower than it was: the trailing
  // newlines injected below are still streamed and decoded without any
  // `common_sampler_accept`, so on this single-prompt path the sampler's
  // `prev` — what `checkAntiprompt` scans — omits them, unlike the batch
  // path's forced-token branch. Left alone because this function's decode
  // bookkeeping is shared with recurrent rollback.
  //
  // Inject 2 newlines after closing tag
  if (reasoningState_.cached_newline_token != LLAMA_TOKEN_NULL) {
    for (int i = 0; i < 2; i++) {
      // The generation guard only proved room for ONE more token and the
      // close tag above just took it. Nothing evicts to make room any more,
      // so stop here rather than decode into a cell that does not exist; the
      // next `onLogitsReady` reports `contextOverflow`. Without this the
      // ERROR below fires on an ordinary full-context boundary.
      if (contextWindowFull(nPast, ctxCeiling())) {
        break;
      }
      common_batch_clear(batch);
      common_batch_add(
          batch, reasoningState_.cached_newline_token, nPast, {seqId_}, true);

      const bool forceNewlineDecodeFailure =
          std::exchange(forceReasoningRecoveryDecodeFailureForTesting_, false);
      if (forceNewlineDecodeFailure ||
          llama_decode(modelCtx_.lctx, batch) != 0) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            toString(FailedToDecode),
            "[TextLlm] failed to decode reasoning recovery newline");
      }
      ++nPast;
      appendResidentToken(reasoningState_.cached_newline_token);
      ++lastGeneratedTokenCount_;
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

  banEogAfterReasoningRecovery_ = true;
  return true;
}
