#include "TextLlmContext.hpp"

#include <algorithm>
#include <cassert>
#include <chrono>
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
  snapshotScope_ =
      qvac_lib_inference_addon_llama::utils::untrimmableSnapshotScope();
  requestRollback_.setScope(snapshotScope_);
  // Generated reasoning stays resident. A later authoritative full prompt
  // either includes it (and reuses it) or omits it (and prefix reconciliation
  // removes it), matching llama-server's lazy behavior.

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

  // An empty `chat_template` uses the template embedded in the GGUF.
  tmpls_ = common_chat_templates_init(modelCtx_.model, params_.chat_template);
  historyReasoningTags_ =
      qvac_lib_inference_addon_llama::utils::historyReasoningTags(
          tmpls_.get(), modelCtx_.model, params_.use_jinja);

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
    if (renderOverrides_.parallelToolCalls) {
      inputs.parallel_tool_calls = *renderOverrides_.parallelToolCalls;
    }
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

  generationPromptTokens_ =
      needsFullStateSnapshot_ && cacheReconciliationEnabled_ &&
              inputs.add_generation_prompt &&
              !llama_model_has_encoder(modelCtx_.model)
          ? generationPromptTailLength(
                modelCtx_.lctx, rendered.generationPrompt, inputTokens)
          : 0;

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
  lastPromptTokenCount_ = 0;
  lastPromptEvalMs_ = 0.0;
  lastGenerationMs_ = 0.0;

  PrefillPlan plan =
      preparePrefill(chatMsgs, tools, {}, {}, isCacheLoaded, prefill);
  const std::vector<llama_token> inputTokens = std::move(plan.tokens);
  const auto nTokens = static_cast<llama_pos>(inputTokens.size());
  // The end-of-history checkpoint splits the prefill: decode up to it,
  // capture, then decode the generation prompt.
  const std::optional<llama_pos> checkpointAt =
      plan.checkpointAtTextTokens.has_value()
          ? std::optional<llama_pos>(
                static_cast<llama_pos>(*plan.checkpointAtTextTokens))
          : std::nullopt;

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

  const auto prefillStart = std::chrono::steady_clock::now();
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
    const llama_pos chunkEnd =
        checkpointAt.has_value() && tokenIndex < *checkpointAt ? *checkpointAt
                                                               : nTokens;
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
    lastPromptTokenCount_ += textBatch->n_tokens;
    // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,bugprone-narrowing-conversions,readability-implicit-bool-conversion,readability-identifier-naming)
    if (checkpointAt.has_value() && tokenIndex == *checkpointAt) {
      captureHistoryCheckpoint(nPast_);
    }
  }
  // Finish the queued decodes so the prompt time covers the work, not just
  // its submission; generation would wait for it at its first sample anyway.
  llama_synchronize(modelCtx_.lctx);
  lastPromptEvalMs_ = std::chrono::duration<double, std::milli>(
                          std::chrono::steady_clock::now() - prefillStart)
                          .count();

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

  // Per-slot usable window: the partitioned per-sequence cap in batch mode,
  // else the full context. Overflow must measure against this so the driver
  // agrees with the scheduler about what fits.
  const llama_pos ceiling = ctxCeiling();

  // exceedsContextWindow mirrors the scheduler's admission, so the driver never
  // rejects a prompt the scheduler already let in.
  const auto throwIfOverflows = [&](llama_pos cached, size_t nTokens) {
    if (exceedsContextWindow(
            static_cast<llama_pos>(nTokens), ceiling, isPrefillOnlyRequest)) {
      std::string errorMsg = string_format(
          "[TextLlm] context overflow at batch prefill step: prompt tokens "
          "%zu, max context tokens %d\n",
          nTokens,
          ceiling);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextOverflow), errorMsg);
    }
    // Cached conversation plus this prompt: the context is full, and there is
    // nothing to evict any more, so the request cannot proceed.
    if (exceedsContextWindow(
            cached + static_cast<llama_pos>(nTokens),
            ceiling,
            isPrefillOnlyRequest)) {
      std::string errorMsg = string_format(
          "[TextLlm] context overflow at batch prefill step: cached tokens %d "
          "plus prompt tokens %zu exceed the max context tokens %d\n",
          cached,
          nTokens,
          ceiling);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextOverflow), errorMsg);
    }
  };

  std::optional<size_t> checkpointAt;
  if (cacheReconciliationEnabled_) {
    const size_t fullSize = inputTokens.size();
    // Reconciliation trims or replaces the cached conversation, so a prompt
    // that cannot fit is refused before it, against the prefix it shares
    // with the cache. A text ledger has one position per entry.
    const size_t shared =
        cache::commonPrefix(residentLedger_, cache::fromTokens(inputTokens));
    throwIfOverflows(static_cast<llama_pos>(shared), fullSize - shared);
    beginCacheRequest();
    inputTokens = reconcilePrompt(inputTokens, isPrefillOnlyRequest);
    // Only the generation prompt follows the history, so the history ends
    // `generationPromptTokens_` tokens before the end of the suffix too. A
    // history end inside the reused prefix has nothing left to capture, and
    // with `cache_checkpoints: 0` nothing would keep it.
    if (generationPromptTokens_ > 0 && cacheCheckpointPolicy_.maxCount > 0 &&
        inputTokens.size() > generationPromptTokens_) {
      checkpointAt = inputTokens.size() - generationPromptTokens_;
      historyCheckpointEntries_ = fullSize - generationPromptTokens_;
    }
  }

  throwIfOverflows(nPast_, inputTokens.size());

  return PrefillPlan{
      .tokens = std::move(inputTokens), .checkpointAtTextTokens = checkpointAt};
}

void TextLlmContext::syncPosition(llama_pos currentPos) {
  nPast_ = currentPos;
  confirmPendingResidentToken(currentPos);
}

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

  const auto generationStart = std::chrono::steady_clock::now();
  ScopeGuard recordGenerationTime([this, generationStart]() noexcept {
    lastGenerationMs_ = std::chrono::duration<double, std::milli>(
                            std::chrono::steady_clock::now() - generationStart)
                            .count();
  });
  LlamaBatch batch(1, 0, 1); // batch for next token generation
  unsigned generatedAfterAccept = 0;

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
  const SequenceStepResult result = sampleFromLogits(
      logitIdx, generatedAfterAccept, outputCallback, inlineDecodeBatch);
  // The single-prompt loop records a token itself once it decoded it; on the
  // batch path the scheduler decodes it later (see
  // `holdPendingResidentToken`).
  if (inlineDecodeBatch == nullptr) {
    holdPendingResidentToken(result.token, nPast_);
  }
  return result;
}

SequenceStepResult TextLlmContext::sampleFromLogits(
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

  const llama_token tokenId =
      common_sampler_sample(smpl_.get(), modelCtx_.lctx, logitIdx);
  common_sampler_accept(smpl_.get(), tokenId, true);

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
  // Family-default tags act as the fallback when the active chat template
  // does not expose reasoning tags. Resolved by the caller so the lookup runs
  // at most once per prompt render and the reasoning-budget markers can be
  // derived from the same value.
  const std::optional<ReasoningTags> reasoningTags =
      selectReasoningTagSource(thinkingStartTag, thinkingEndTag, fallbackTags);

  reasoningState_ = ReasoningState{};
  reasoningEnabled_ = false;
  if (!reasoningTags.has_value()) {
    return;
  }

  const bool reasoningInitOk =
      initializeReasoningState(modelCtx_.lctx, reasoningState_, *reasoningTags);
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
  cache::requireTokensInVocab(
      decoded.ledger, llama_vocab_n_tokens(modelCtx_.vocab));
  residentLedger_ = decoded.ledger;
  nPast_ = decoded.nPast;
  cacheCheckpoints_.clear();
  pendingHistoryCheckpoint_.reset();
}

void TextLlmContext::clearCacheReconciliationState() {
  residentLedger_.entries.clear();
  pendingPromptLedger_.entries.clear();
  preRequestLedger_.entries.clear();
  preRequestCacheSnapshot_.clear();
  cacheCheckpoints_.clear();
  pendingHistoryCheckpoint_.reset();
  historyCheckpointEntries_ = 0;
  cacheRequestActive_ = false;
  cacheRequestRolledBack_ = false;
}

bool TextLlmContext::rollbackFailedRequest() {
  return !cacheRequestActive_ || restorePreRequestCacheState();
}

void TextLlmContext::beginCacheRequest() {
  discardPendingResidentToken();
  pendingHistoryCheckpoint_.reset();
  historyCheckpointEntries_ = 0;
  cacheRequestActive_ = true;
  cacheRequestRolledBack_ = false;
  preRequestNPast_ = nPast_;
  preRequestLedger_ = residentLedger_;
  pendingPromptLedger_.entries.clear();
  preRequestCacheSnapshot_.clear();
  // Pure-attention memory never needs a dump: rollback is a tail trim to the
  // rollback target, which `reconcilePrompt` moves to the divergence point
  // when it trims resident state. Models that cannot trim snapshot up front.
  if (needsFullStateSnapshot_) {
    capturePreRequestCacheSnapshot();
  }
}

void TextLlmContext::capturePreRequestCacheSnapshot() {
  if (!preRequestCacheSnapshot_.empty()) {
    return;
  }
  if (!snapshotSequenceState(
          modelCtx_.lctx,
          seqId_,
          nPast_,
          preRequestCacheSnapshot_,
          cacheCheckpointPolicy_.storage,
          snapshotScope_,
          cacheCheckpointPolicy_.directory)) {
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
    // Longest usable checkpoint first: a checkpoint is usable when its
    // ledger is a prefix of the new prompt no longer than the reuse target,
    // which also makes it a prefix of the resident memory a partial restore
    // relies on.
    for (CacheCheckpoint* candidate : cache::usableCheckpointsLongestFirst(
             cacheCheckpoints_, pendingPromptLedger_, reuseTarget)) {
      if (restoreSequenceState(modelCtx_.lctx, seqId_, candidate->state)) {
        residentLedger_ = candidate->ledger;
        nPast_ = residentLedger_.positions();
        reuse = residentLedger_.entries.size();
        checkpoint = std::to_string(reuse);
        break;
      }
    }
    if (reuse == 0) {
      clearSequenceMemory(modelCtx_.lctx);
      residentLedger_.entries.clear();
      nPast_ = 0;
      checkpoint = "cold";
    }
    // The restore (or the clear) replaced the memory the pre-request snapshot
    // describes: the KV cells past the checkpoint are gone, and a partial
    // snapshot holds no KV to bring them back. Roll this request back to the
    // restored state instead, which the KV cache, the recurrent state and the
    // ledger all agree on, as the attention branch below does.
    preRequestLedger_ = residentLedger_;
    preRequestNPast_ = nPast_;
    preRequestCacheSnapshot_.clear();
    if (nPast_ > 0) {
      capturePreRequestCacheSnapshot();
    }
  } else if (!needsFullStateSnapshot_ && reuseTarget < cachedLength) {
    // Trimming discards resident state a tail trim cannot bring back, so the
    // rollback target moves to the divergence point instead of the
    // pre-request state. That is the state the next request wants anyway:
    // a retry of this prompt shares exactly this prefix with the cache, and
    // restoring the old tail would only have it trimmed again. No snapshot
    // is ever written for pure-attention memory.
    llama_pos reusePos = residentLedger_.positions(reuseTarget);
    if (!canTrimSequenceTo(modelCtx_.lctx, reusePos)) {
      // Sliding-window cells before the divergence are gone; only a full
      // reprocess rebuilds that window.
      reuseTarget = 0;
      reuse = 0;
      reusePos = 0;
      checkpoint = "cold";
    }
    clearSequenceMemory(modelCtx_.lctx, reusePos, -1);
    residentLedger_.truncate(reuseTarget);
    nPast_ = reusePos;
    preRequestLedger_ = residentLedger_;
    preRequestNPast_ = nPast_;
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

  lastCacheReuse_ = reuse;
  return std::vector<llama_token>(fullPrompt.begin() + reuse, fullPrompt.end());
}

void TextLlmContext::commitCacheRequest() {
  discardPendingResidentToken();
  if (!cacheRequestActive_) {
    return;
  }
  // The pre-request snapshot only serves this request's rollback. Kept, it
  // would hold the previous answer as generated, which a template that
  // rewrites earlier answers (thinking models drop the reasoning) never
  // renders again, so no later prompt could restore it. The end-of-history
  // checkpoints stop before each answer, so with two kept the older one also
  // serves an edit of the last user message.
  preRequestCacheSnapshot_.clear();
  if (pendingHistoryCheckpoint_.has_value()) {
    cache::appendProcessCheckpoint(
        cacheCheckpoints_,
        std::move(*pendingHistoryCheckpoint_),
        cacheCheckpointPolicy_,
        [](const CacheCheckpoint& entry) { return entry.state.bytes(); });
    pendingHistoryCheckpoint_.reset();
  }
  cacheRequestActive_ = false;
  cacheRequestRolledBack_ = false;
}

void TextLlmContext::captureHistoryCheckpoint(llama_pos pos) {
  if (!needsFullStateSnapshot_ || !cacheRequestActive_ ||
      historyCheckpointEntries_ == 0) {
    return;
  }
  cache::Ledger ledger = pendingPromptLedger_;
  ledger.truncate(historyCheckpointEntries_);
  // A checkpoint is useful only if it describes exactly the memory it saves.
  // The ledger is rebuilt from the same tokens the plan fed, so a mismatch
  // means the plan and the ledger disagree; skip rather than store it.
  if (ledger.positions() != pos) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[TextLlm] skipping end-of-history checkpoint: memory ends at %d, "
            "history at %d\n",
            pos,
            ledger.positions()));
    return;
  }
  CacheCheckpoint checkpoint{.ledger = std::move(ledger)};
  // Only an optimisation for the next turn: a failed capture costs that turn
  // a longer prefill, never this request.
  if (!snapshotSequenceState(
          modelCtx_.lctx,
          seqId_,
          pos,
          checkpoint.state,
          cacheCheckpointPolicy_.storage,
          snapshotScope_,
          cacheCheckpointPolicy_.directory)) {
    QLOG_IF(
        Priority::WARNING,
        "[TextLlm] failed to capture end-of-history checkpoint\n");
    return;
  }
  pendingHistoryCheckpoint_ = std::move(checkpoint);
}

bool TextLlmContext::restorePreRequestCacheState() {
  bool ok = true;
  discardPendingResidentToken();
  pendingHistoryCheckpoint_.reset();
  if (!preRequestCacheSnapshot_.empty()) {
    ok = restoreSequenceState(modelCtx_.lctx, seqId_, preRequestCacheSnapshot_);
  } else {
    // Pure-attention memory: everything this request added sits after the
    // rollback target (the pre-request cursor, or the divergence point when
    // reconciliation trimmed), so dropping that tail restores it. Trimmed
    // whatever `nPast_` says, so a decode that fails part-way cannot leave
    // cells past the cursor.
    try {
      // Decoding past the target can evict the sliding-window cells in
      // front of it, which no trim brings back: land cold instead. Checked
      // before the trim, which may empty the window altogether.
      const bool windowIntact =
          canTrimSequenceTo(modelCtx_.lctx, preRequestNPast_);
      clearSequenceMemory(modelCtx_.lctx, preRequestNPast_, -1);
      if (!windowIntact) {
        clearSequenceMemory(modelCtx_.lctx);
        preRequestLedger_.entries.clear();
        preRequestNPast_ = 0;
      }
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

void TextLlmContext::holdPendingResidentToken(
    llama_token token, llama_pos sampledAt) {
  pendingResidentToken_ = token;
  pendingResidentTokenPos_ = sampledAt;
}

void TextLlmContext::confirmPendingResidentToken(llama_pos decodedPos) {
  if (pendingResidentToken_ != LLAMA_TOKEN_NULL &&
      decodedPos > pendingResidentTokenPos_) {
    appendResidentToken(pendingResidentToken_);
    discardPendingResidentToken();
  }
}

void TextLlmContext::discardPendingResidentToken() {
  pendingResidentToken_ = LLAMA_TOKEN_NULL;
}

void TextLlmContext::acceptRestoredState(
    const std::vector<llama_token>& stateTokens, const std::string& cacheKey) {
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
}

bool TextLlmContext::adoptResidentState(
    const std::vector<llama_token>& stateTokens) {
  // The sequence memory already holds the state (a slot kept resident across
  // requests, or one just restored from the RAM tier); only the ledger has to
  // be adopted. Same acceptance checks as a file load, and the same cleanup
  // when they fail: the caller then falls back to the file.
  ScopeGuard residentGuard([this]() noexcept {
    try {
      clearSequenceMemory(modelCtx_.lctx);
    } catch (...) {
      QLOG_IF(
          Priority::ERROR,
          "[TextLlm] failed to clear sequence after rejecting a resident "
          "state\n");
    }
    nPast_ = 0;
    clearCacheReconciliationState();
  });
  try {
    acceptRestoredState(stateTokens, "<resident>");
  } catch (const std::exception& ex) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[TextLlm] rejected a resident cache state: %s\n", ex.what()));
    return false;
  }
  residentGuard.dismiss();
  return true;
}

std::vector<llama_token> TextLlmContext::residentStateTokens() const {
  return cacheStateTokens();
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
  acceptRestoredState(stateTokens, cacheKey);
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
  if (!CacheManager::savedCompletely(tmpCacheKey, savedBytes)) {
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
