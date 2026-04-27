#include "TextLlmContext.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstddef>

#include <llama.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "ContextSlider.hpp"
#include "addon/LlmErrors.hpp"
#include "common/common.h"
#include "common/log.h"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/Qwen3ReasoningUtils.hpp"

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::utils;
// NOLINTNEXTLINE(readability-identifier-naming,readability-function-cognitive-complexity)
// NOLINTNEXTLINE(readability-function-cognitive-complexity)

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
TextLlmContext::TextLlmContext(
    common_params& commonParams, common_init_result&& llamaInit,
    ToolsCompactController& tools)
    : tools_(tools), llamaInit_(std::move(llamaInit)), params_(commonParams) {
  {

    model_ = llamaInit_.model.get();
    lctx_ = llamaInit_.context.get();
    if (model_ == nullptr) {
      throw qvac_errors::StatusError(
          ADDON_ID, toString(UnableToLoadModel), "Failed to initialize model");
    }

    if (lctx_ == nullptr) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToLoadModel),
          "Failed to initialize context");
    }

    vocab_ = llama_model_get_vocab(model_);

    isQwen3Model_ = qvac_lib_inference_addon_llama::utils::isQwen3Model(model_);
    if (isQwen3Model_) {
      qvac_lib_inference_addon_llama::utils::initializeQwen3ReasoningState(
          lctx_, reasoningState_);
    }

    std::string chatTemplate =
        getChatTemplate(model_, params_, tools_.enabled());
    tmpls_ = common_chat_templates_init(model_, chatTemplate);

    smpl_.reset(common_sampler_init(model_, params_.sampling));
    if (!smpl_) {
      std::string errorMsg = string_format(
          "[TextLlm] %s: failed to initialize sampling subsystem\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(UnableToCreateSamplingSystem), errorMsg);
    }

    if (!llama_model_has_encoder(model_) && llama_vocab_get_add_eos(vocab_)) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          "For decoder-only models, should NOT automatically add EOS tokens");
    }

    int gaN = params_.grp_attn_n;
    int gaW = params_.grp_attn_w;
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

    // antiprompt init
    for (const std::string& antiprompt : params_.antiprompt) {
      auto ids = ::common_tokenize(lctx_, antiprompt, false, true);
      if (ids.size() == 1) {
        antipromptTokens_.push_back(ids[0]);
      }
    }

    // threadpool init
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
      // Start the non-batch threadpool in the paused state
      tpp.paused = true;
    }

    threadpool_.reset(ggmlThreadpoolNewFn(&tpp));
    if (!threadpool_) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(UnableToCreateThreadPool),
          "threadpool create failed");
    }
    llama_attach_threadpool(lctx_, threadpool_.get(), threadpoolBatch_.get());

    // log system info
    QLOG_IF(Priority::DEBUG, [&]() {
      return string_format(
          "[TextLlm] %s\n", common_params_get_system_info(params_).c_str());
    }());
  }
}

bool TextLlmContext::checkAntiprompt() {
  if (!params_.antiprompt.empty()) {
    constexpr int kNPrev = 32;
    std::string lastOutput =
        common_sampler_prev_str(smpl_.get(), lctx_, kNPrev);

    // Check if each of the reverse prompts appears anywhere in the recent
    // output. We search the full kNPrev-token window because a single token
    // can decode to many characters, and a short antiprompt like "\n" may
    // appear at the start of such a token, far from the string's tail.
    for (const std::string& antiprompt : params_.antiprompt) {
      if (lastOutput.find(antiprompt) != std::string::npos) {
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
  inputs.messages = chatMsgs;
  inputs.add_generation_prompt = isLastMessageFromUser;

  if (!tools.empty()) {
    inputs.tools = tools;
  }
  prompt = getPrompt(tmpls_.get(), inputs);

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
    inputTokens = common_tokenize(lctx_, prompt, addSpecial, true);

    if (tools_.enabled() && !tools.empty()) {
      inputs.tools = {};
      inputs.add_generation_prompt = false;
      inputs.use_jinja = params_.use_jinja;
      auto promptNoTools = getPrompt(tmpls_.get(), inputs);
      auto tokensNoTools =
          common_tokenize(lctx_, promptNoTools, addSpecial, true);
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
  if (llama_model_has_encoder(model_) && nPast_ == 0 && !isCacheLoaded) {
    int encInputSize = static_cast<int>(inputTokens.size());
    llama_token* encInputBuf = inputTokens.data();

    if (llama_encode(lctx_, llama_batch_get_one(encInputBuf, encInputSize)) !=
        0) {
      std::string errorMsg =
          string_format("[TextLlm] %s : failed to eval encoder\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(EncoderFailed), errorMsg);
    }

    llama_token decoderStartTokenId = llama_model_decoder_start_token(model_);
    if (decoderStartTokenId == LLAMA_TOKEN_NULL) {
      decoderStartTokenId = llama_vocab_bos(vocab_);
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
  std::vector<llama_token> inputTokens;
  tokenizeChat(chatMsgs, tools, inputTokens, isCacheLoaded);

  size_t nTokens = inputTokens.size();
  const bool isFirstMsg = (nPast_ == 0);

  if (nTokens >= llama_n_ctx(lctx_)) {
    std::string errorMsg = string_format(
        "[TextLlm] context overflow at prefill step: prompt tokens %ld, max "
        "context tokens %d\n",
        nTokens,
        llama_n_ctx(lctx_));
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextOverflow), errorMsg);
  }
  if (nPast_ + nTokens >= llama_n_ctx(lctx_)) {
    auto outcome = trySlidePrefill(
        lctx_,
        nPast_,
        firstMsgTokens_,
        static_cast<llama_pos>(nTokens),
        nDiscarded_,
        tools_);
    switch (outcome.kind) {
    case ContextSlideOutcome::Kind::Slid:
      nPast_ = outcome.newNPast;
      ++nSlides_;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[TextLlm] Prefill step: discarded %d tokens after the first "
              "message\n",
              outcome.discarded));
      break;
    case ContextSlideOutcome::Kind::FullWipe:
      nPast_ = outcome.newNPast;
      ++nSlides_;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[TextLlm] Prefill step: wiped %d tokens after the first "
              "message\n",
              outcome.discarded));
      break;
    case ContextSlideOutcome::Kind::Overflow: {
      std::string errorMsg = string_format(
          "[TextLlm] context overflow at prefill step (%ld tokens, max "
          "%d)\n",
          nPast_ + nTokens,
          llama_n_ctx(lctx_));
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextOverflow), errorMsg);
    }
    case ContextSlideOutcome::Kind::NotNeeded:
      break;
    }
  }
  LlamaBatch textBatch(params_.n_batch, 0, 1);

  llama_pos count = nPast_;
  llama_pos tokenIndex = 0;
  while (tokenIndex < nTokens) { // split into batches
    if (stopGeneration_
            .load()) { // remove the last added tokens from the context
      removeLastNTokens(tokenIndex);
      stopGeneration_.store(false);
      return false;
    }
    textBatch->n_tokens = 0; // clear the batch
    // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,bugprone-narrowing-conversions,readability-implicit-bool-conversion,readability-identifier-naming)
    for (; tokenIndex < nTokens && textBatch->n_tokens < params_.n_batch;
         tokenIndex++) {
      llama_pos batchTokenIndex = textBatch->n_tokens;
      // NOLINTNEXTLINE(clang-analyzer-core.NullDereference)
      textBatch->token[batchTokenIndex] = inputTokens[tokenIndex];
      textBatch->pos[batchTokenIndex] = (count++);
      textBatch->n_seq_id[batchTokenIndex] = 1;
      textBatch->seq_id[batchTokenIndex][0] = 0;
      textBatch->logits[batchTokenIndex] = static_cast<int8_t>(false);

      textBatch->n_tokens++;
    }
    bool isLastToken = (tokenIndex == nTokens);
    if (isLastToken && !prefill) {
      textBatch->logits[textBatch->n_tokens - 1] = static_cast<int8_t>(true);
    }
    // NOLINTNEXTLINE(clang-analyzer-core.CallAndMessage)
    int ret = llama_decode(lctx_, *textBatch);
    if (ret != 0) {
      std::string errorMsg = string_format(
          "[TextLlm] %s: failed to decode input tokens\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(FailedToDecode), errorMsg);
    }

    nPast_ += textBatch->n_tokens;
    // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,bugprone-narrowing-conversions,readability-implicit-bool-conversion,readability-identifier-naming)
  }

  if (isFirstMsg) {
    firstMsgTokens_ = nPast_;
    const auto ctxSize = static_cast<llama_pos>(llama_n_ctx(lctx_));
    if (nDiscarded_ >= ctxSize - firstMsgTokens_) {
      nDiscarded_ = ctxSize - firstMsgTokens_ - 1;
    }
  }
  tools_.onEvalComplete(nPast_, static_cast<llama_pos>(inputTokens.size()));
  return true;
}

void TextLlmContext::flushPendingUtf8ToCallback(
    const std::function<void(const std::string&)>& outputCallback) {
  if (!outputCallback || !utf8Buffer_.hasPendingBytes()) {
    return;
  }
  std::string remaining = utf8Buffer_.flush();
  if (!remaining.empty()) {
    outputCallback(remaining);
  }
}

void TextLlmContext::applyContextDiscard() {
  auto outcome =
      trySlideGeneration(lctx_, nPast_, firstMsgTokens_, nDiscarded_, tools_);
  if (outcome.kind == ContextSlideOutcome::Kind::Slid) {
    nPast_ = outcome.newNPast;
    ++nSlides_;
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[TextLlm] discarded %d tokens after the first message\n",
            outcome.discarded));
  }
}

void TextLlmContext::handleStopRequestAndAddEot(LlamaBatch& batch) {
  stopGeneration_.store(false);
  llama_token eot = llama_vocab_eot(vocab_);
  common_batch_add(
      *batch,
      eot == LLAMA_TOKEN_NULL ? llama_vocab_eos(vocab_) : eot,
      nPast_++,
      {0},
      true);
  if (llama_decode(lctx_, *batch) != 0) {
    const char* errorMsg = "[TextLlm] failed to decode EOT token\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(FailedToDecode), errorMsg);
  }
}

bool TextLlmContext::generateResponse(
    const std::function<void(const std::string&)>& outputCallback) {

  int nRemain = params_.n_predict;
  LlamaBatch batch(1, 0, 1); // batch for next token generation

  reasoningState_.inside_reasoning = false;
  reasoningState_.recent_output_buffer.clear();

  if (stopGeneration_.load()) {
    stopGeneration_.store(false);
    flushPendingUtf8ToCallback(outputCallback);
    return true;
  }

  while (nRemain != 0) {
    if (stopGeneration_.load()) {
      stopGeneration_.store(false);
      flushPendingUtf8ToCallback(outputCallback);
      return true;
    }
    if (nPast_ + 1 > static_cast<llama_pos>(llama_n_ctx(lctx_)) &&
        nDiscarded_ == 0) {
      QLOG_IF(
          Priority::WARNING,
          string_format(
              "[TextLlm] generation overflow: context is full and nDiscarded "
              "is "
              "0 (nPast=%d, nCtx=%d, firstMsgTokens=%d, nPastBeforeTools=%d, "
              "toolsCompact=%s)\n",
              nPast_,
              llama_n_ctx(lctx_),
              firstMsgTokens_,
              tools_.anchor(),
              tools_.enabled() ? "true" : "false"));
      return false;
    }
    applyContextDiscard();

    llama_token tokenId = common_sampler_sample(smpl_.get(), lctx_, -1);
    common_sampler_accept(smpl_.get(), tokenId, true);
    --nRemain;

    std::string tokenStr =
        common_token_to_piece(lctx_, tokenId, params_.special);
    if (outputCallback) {
      std::string completeChars = utf8Buffer_.addToken(tokenStr);
      if (!completeChars.empty()) {
        outputCallback(completeChars);
      }
    }

    if (isQwen3Model_) {
      qvac_lib_inference_addon_llama::utils::updateQwen3ReasoningBuffer(
          tokenStr, reasoningState_);
    }

    bool isEos = llama_vocab_is_eog(vocab_, tokenId);
    if (isEos && isQwen3Model_) {
      if (handleQwen3ReasoningEOS(
              tokenId, tokenStr, *batch, nPast_, outputCallback)) {
        continue;
      }
    }

    if (isEos || checkAntiprompt()) {
      flushPendingUtf8ToCallback(outputCallback);
      break;
    }

    common_batch_clear(*batch);
    if (stopGeneration_.load()) {
      handleStopRequestAndAddEot(batch);
      break;
    }
    common_batch_add(*batch, tokenId, nPast_++, {0}, true);

    // NOLINT(clang-analyzer-core.CallAndMessage)
    if (llama_decode(lctx_, *batch) != 0) {
      const char* errorMsg = "[TextLlm] failed to decode next token\n";
      throw qvac_errors::StatusError(
          ADDON_ID, toString(FailedToDecode), errorMsg);
    }
  }

  if (nRemain == 0) {
    flushPendingUtf8ToCallback(outputCallback);
  }
  return true;
}

std::function<void()>
TextLlmContext::applyGenerationParams(const GenerationParams& overrides) {
  if (!overrides.hasOverrides()) {
    return []() {};
  }

  common_params_sampling savedSampling = params_.sampling;
  int savedPredict = params_.n_predict;

  auto setIf = [](const auto& src, auto& dst) {
    if (src) {
      dst = *src;
    }
  };
  setIf(overrides.temp, params_.sampling.temp);
  setIf(overrides.top_p, params_.sampling.top_p);
  setIf(overrides.top_k, params_.sampling.top_k);
  setIf(overrides.n_predict, params_.n_predict);
  setIf(overrides.seed, params_.sampling.seed);
  setIf(overrides.frequency_penalty, params_.sampling.penalty_freq);
  setIf(overrides.presence_penalty, params_.sampling.penalty_present);
  setIf(overrides.repeat_penalty, params_.sampling.penalty_repeat);

  smpl_.reset(common_sampler_init(model_, params_.sampling));

  bool restored = false;
  return [this, savedSampling, savedPredict, restored]() mutable {
    if (restored)
      return;
    restored = true;
    params_.sampling = savedSampling;
    params_.n_predict = savedPredict;
    smpl_.reset(common_sampler_init(model_, params_.sampling));
  };
}

void TextLlmContext::stop() { stopGeneration_.store(true); }

void TextLlmContext::resetState(bool resetStats) {
  // Reset the n_past

  tools_.reset();
  nPast_ = 0;

  // Reset the first msg token length
  firstMsgTokens_ = 0;

  // On partial reset (resetStats=false), preserve nSlides_ so
  // runtimeStats() can read the per-inference value.
  // On full reset (resetStats=true), clear it along with perf stats.
  if (resetStats) {
    nSlides_ = 0;
  }

  // Clear UTF-8 buffer when resetting state
  utf8Buffer_.clear();

  // Clear the KV cache
  llama_memory_clear(llama_get_memory(lctx_), true);

  // Reset performance metrics
  if (resetStats) {
    llama_perf_context_reset(lctx_);
  }

  // Reset sampler if available
  common_sampler_reset(smpl_.get());

  // Synchronize to ensure all operations are complete
  llama_synchronize(lctx_);
}

llama_context* TextLlmContext::getCtx() { return lctx_; }

llama_pos TextLlmContext::getNPast() const { return nPast_; }

void TextLlmContext::setNPast(llama_pos nPast) { this->nPast_ = nPast; }

llama_pos TextLlmContext::getFirstMsgTokens() const { return firstMsgTokens_; }

void TextLlmContext::setFirstMsgTokens(llama_pos firstMsgTokens) {
  this->firstMsgTokens_ = firstMsgTokens;
}

void TextLlmContext::setNDiscarded(llama_pos nDiscarded) {
  this->nDiscarded_ = nDiscarded;
}

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

  // Get the memory for KV cache manipulation
  auto* mem = llama_get_memory(lctx_);

  // Remove the last N tokens from the KV cache
  // llama_memory_seq_rm(memory, seq_id, start_pos, end_pos)
  // seq_id = -1 means all sequences
  // start_pos = n_past - tokensToRemove (the position to start removing from)
  // end_pos = -1 means remove to the end
  llama_memory_seq_rm(mem, -1, nPast_ - tokensToRemove, -1);

  // Decrement the token count by the number of tokens removed
  nPast_ -= tokensToRemove;

  // Note: The sampler doesn't have an "undo" function, so we leave it as is.
  // The sampler maintains its own history, but the removed tokens won't affect
  // future sampling since they're no longer in the KV cache.

  return tokensToRemove;
}

bool TextLlmContext::handleQwen3ReasoningEOS(
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
  tokenStr = common_token_to_piece(lctx_, tokenId, params_.special);
  reasoningState_.inside_reasoning = false;

  // Stream closing tag to user
  if (outputCallback) {
    std::string completeChars = utf8Buffer_.addToken(tokenStr);
    if (!completeChars.empty()) {
      outputCallback(completeChars);
    }
  }

  // Decode closing tag
  common_batch_clear(batch);
  common_batch_add(batch, tokenId, nPast++, {0}, true);
  if (llama_decode(lctx_, batch) != 0) {
    QLOG_IF(
        Priority::ERROR,
        "[TextLlm] Failed to decode closing tag during replacement\n");
  }

  // Inject 2 newlines after closing tag
  if (reasoningState_.cached_newline_token != LLAMA_TOKEN_NULL) {
    for (int i = 0; i < 2; i++) {
      common_batch_clear(batch);
      common_batch_add(
          batch, reasoningState_.cached_newline_token, nPast++, {0}, true);

      if (llama_decode(lctx_, batch) != 0) {
        QLOG_IF(
            Priority::ERROR,
            "[TextLlm] Failed to decode newline token during forced "
            "injection\n");
      }

      std::string newlineStr = common_token_to_piece(
          lctx_, reasoningState_.cached_newline_token, params_.special);
      if (outputCallback) {
        std::string completeChars = utf8Buffer_.addToken(newlineStr);
        if (!completeChars.empty()) {
          outputCallback(completeChars);
        }
      }
    }
  }

  return true;
}
