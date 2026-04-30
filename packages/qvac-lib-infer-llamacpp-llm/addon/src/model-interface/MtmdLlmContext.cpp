#include "MtmdLlmContext.hpp"

#include <algorithm>
#include <cassert>

#include <common/log.h>
#include <llama/mtmd/mtmd-helper.h>
#include <llama/mtmd/mtmd.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "ContextSlider.hpp"
#include "GenerationParamsApply.hpp"
#include "addon/LlmErrors.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
// NOLINTNEXTLINE(readability-function-cognitive-complexity)

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::utils;

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
MtmdLlmContext::MtmdLlmContext(
    common_params& commonParams, common_init_result&& llamaInit,
    ToolsCompactController& tools)
    : tools_(tools), llamaInit_(std::move(llamaInit)), params_(commonParams),
      model_(llamaInit_.model.get()), lctx_(llamaInit_.context.get()) {

  if (model_ == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(UnableToLoadModel),
        "Failed to initialize model.");
  }

  if (lctx_ == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(UnableToLoadModel),
        "Failed to initialize context");
  }

  vocab_ = llama_model_get_vocab(model_);

  std::string chatTemplate = getChatTemplate(model_, params_, tools_.enabled());
  tmpls_ = common_chat_templates_init(model_, chatTemplate);

  smpl_.reset(common_sampler_init(model_, params_.sampling));
  if (!smpl_) {
    std::string errorMsg = string_format(
        "[MtmdLlm] %s: failed to initialize sampling subsystem\n", __func__);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToCreateSamplingSystem), errorMsg);
  }

  if ((llama_model_chat_template(model_, nullptr) == nullptr) &&
      params_.chat_template.empty()) {
    QLOG_IF(
        Priority::ERROR,
        string_format(
            "[MtmdLlm] %s: Model does not have chat template\n", __func__));
    QLOG_IF(
        Priority::ERROR,
        "[MtmdLlm]   For old llava models, you may need to use "
        "'--chat-template "
        "vicuna'\n");
    QLOG_IF(
        Priority::ERROR,
        "[MtmdLlm]   For MobileVLM models, use '--chat-template deepseek'\n");
    QLOG_IF(
        Priority::ERROR,
        "[MtmdLlm]   For Mistral Small 3.1, use '--chat-template "
        "mistral-v7'\n");
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "Model does not have chat template");
  }

  initVisionContext();

  // antiprompt init
  for (const std::string& antiprompt : params_.antiprompt) {
    auto ids = ::common_tokenize(lctx_, antiprompt, false, true);
    if (ids.size() == 1) {
      antipromptTokens_.push_back(ids[0]);
    }
  }

  // load antiprompt tokens for legacy templates
  if (params_.chat_template == "vicuna") {
    auto tempTokens = common_tokenize(lctx_, "ASSISTANT:", false, true);
    antipromptTokens_.insert(
        antipromptTokens_.end(), tempTokens.begin(), tempTokens.end());
  } else if (params_.chat_template == "deepseek") {
    auto tempTokens = common_tokenize(lctx_, "###", false, true);
    antipromptTokens_.insert(
        antipromptTokens_.end(), tempTokens.begin(), tempTokens.end());
  }
}

void MtmdLlmContext::initVisionContext() {
  const char* clipPath = params_.mmproj.path.c_str();
  mtmd_context_params mparams = mtmd_context_params_default();
  mparams.use_gpu = params_.mmproj_use_gpu;
  mparams.backend_device =
      params_.mmproj_backend.empty() ? nullptr : params_.mmproj_backend.c_str();
  mparams.print_timings = true;
  mparams.n_threads = params_.cpuparams.n_threads;
  ctxVision_.reset(mtmd_init_from_file(clipPath, model_, mparams));
  if (ctxVision_.get() == nullptr) {
    std::string errorMsg = string_format(
        "[MtmdLlm] Failed to load vision model from %s\n", clipPath);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadModel), errorMsg);
  }
}

bool MtmdLlmContext::checkAntiprompt() {
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

void MtmdLlmContext::tokenizeChat(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, mtmd::input_chunks& chunks,
    bool isCacheLoaded) {
  if (chatMsgs.empty()) {
    std::string errorMsg =
        string_format("[MtmdLlm] %s: no chat messages provided\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }

  common_chat_templates_inputs inputs;
  std::string formattedChat;

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
  formattedChat = getPrompt(tmpls_.get(), inputs);

  if (formattedChat.empty()) {
    std::string errorMsg = string_format(
        "[MtmdLlm] %s: formatted chat prompt is empty\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }

  QLOG_IF(
      Priority::DEBUG,
      string_format("[MtmdLlm] formatted prompt: %s\n", formattedChat.c_str()));

  mtmd_input_text text;
  text.text = formattedChat.c_str();
  text.add_special = addSpecial;
  text.parse_special = true;

  auto bitmapsCPtr = bitmaps_.c_ptr();
  int32_t res = mtmd_tokenize(
      ctxVision_.get(),
      chunks.ptr.get(), // output
      &text,            // text
      bitmapsCPtr.data(),
      bitmapsCPtr.size());
  if (res != 0) {
    resetMedia();
    std::string errorMsg = string_format(
        "[MtmdLlm] %s: Unable to tokenize prompt, res = %d\n", __func__, res);
    throw qvac_errors::StatusError(ADDON_ID, toString(EncoderFailed), errorMsg);
  }

  if (tools_.enabled() && !tools.empty()) {
    inputs.tools = {};
    inputs.add_generation_prompt = false;
    inputs.use_jinja = params_.use_jinja;
    auto promptNoTools = getPrompt(tmpls_.get(), inputs);

    if (!promptNoTools.empty()) {
      mtmd_input_text textNoTools;
      textNoTools.text = promptNoTools.c_str();
      textNoTools.add_special = addSpecial;
      textNoTools.parse_special = true;

      mtmd::input_chunks chunksNoTools(mtmd_input_chunks_init());
      int32_t resNoTools = mtmd_tokenize(
          ctxVision_.get(),
          chunksNoTools.ptr.get(),
          &textNoTools,
          bitmapsCPtr.data(),
          bitmapsCPtr.size());

      if (resNoTools == 0) {
        tools_.onTokenize(
            mtmd_helper_get_n_tokens(chunks.ptr.get()),
            mtmd_helper_get_n_tokens(chunksNoTools.ptr.get()));
      }
    }
  } else {
    tools_.onTokenize(mtmd_helper_get_n_tokens(chunks.ptr.get()), 0);
  }

  resetMedia();
}

bool MtmdLlmContext::evalMessage(
    const std::vector<common_chat_msg>& chatMsgs, bool isCacheLoaded,
    bool prefill) {
  return evalMessageWithTools(chatMsgs, {}, isCacheLoaded, prefill);
}

bool MtmdLlmContext::evalMessageWithTools(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, bool isCacheLoaded,
    bool prefill) {
  mtmd::input_chunks chunks(mtmd_input_chunks_init());

  tokenizeChat(chatMsgs, tools, chunks, isCacheLoaded);

  const bool isFirstMsg = (nPast_ == 0);

  const mtmd_input_chunks* chunksPtr = chunks.ptr.get();

  size_t nTokens = mtmd_helper_get_n_tokens(chunksPtr);
  if (nTokens >= llama_n_ctx(lctx_)) {
    std::string errorMsg = string_format(
        "[MtmdLlm] context overflow at prefill step (%ld tokens, max %d)\n",
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
              "[MtmdLlm] Prefill step: discarded %d tokens after the first "
              "message\n",
              outcome.discarded));
      break;
    case ContextSlideOutcome::Kind::FullWipe:
      nPast_ = outcome.newNPast;
      ++nSlides_;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[MtmdLlm] Prefill step: wiped %d tokens after the first "
              "message\n",
              outcome.discarded));
      break;
    case ContextSlideOutcome::Kind::Overflow: {
      std::string errorMsg = string_format(
          "[MtmdLlm] context overflow at prefill step (%ld tokens, max "
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

  size_t nChunks = mtmd_input_chunks_size(chunksPtr);
  if (nChunks == 0) {
    const char* errorMsg = "[MtmdLlm] Unable to eval prompt\n";
    throw qvac_errors::StatusError(ADDON_ID, toString(EncoderFailed), errorMsg);
  }

  llama_pos nPastLocal = nPast_;

  for (size_t i = 0; i < nChunks; i++) {
    bool chunkLogitsLast = (i == nChunks - 1 && !prefill);
    const auto* chunk = mtmd_input_chunks_get(chunksPtr, i);

    if (stopGeneration_.load()) {
      llama_pos totalDelta = nPastLocal - nPast_;
      nPast_ = nPastLocal;
      removeLastNTokens(totalDelta);
      stopGeneration_.store(false);
      return false;
    }
    int32_t res = mtmd_helper_eval_chunk_single(
        ctxVision_.get(),
        lctx_,
        chunk,
        nPastLocal,
        0,
        params_.n_batch,
        chunkLogitsLast,
        &nPastLocal);
    if (res != 0) {
      std::string errorMsg =
          "[MtmdLlm] failed to eval chunk " + std::to_string(i);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(EncoderFailed), errorMsg);
    }
  }
  nPast_ = nPastLocal;

  if (isFirstMsg) {
    firstMsgTokens_ = nPast_;
    const auto ctxSize = static_cast<llama_pos>(llama_n_ctx(lctx_));
    if (nDiscarded_ >= ctxSize - firstMsgTokens_) {
      nDiscarded_ = ctxSize - firstMsgTokens_ - 1;
    }
  }
  tools_.onEvalComplete(nPast_, static_cast<llama_pos>(nTokens));
  return true;
}

void MtmdLlmContext::flushPendingUtf8ToCallback(
    const std::function<void(const std::string&)>& outputCallback) {
  if (!outputCallback || !utf8Buffer_.hasPendingBytes()) {
    return;
  }
  std::string remaining = utf8Buffer_.flush();
  if (!remaining.empty()) {
    outputCallback(remaining);
  }
}

void MtmdLlmContext::applyContextDiscard() {
  auto outcome =
      trySlideGeneration(lctx_, nPast_, firstMsgTokens_, nDiscarded_, tools_);
  if (outcome.kind == ContextSlideOutcome::Kind::Slid) {
    nPast_ = outcome.newNPast;
    ++nSlides_;
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[MtmdLlm] discarded %d tokens after the first message\n",
            outcome.discarded));
  }
}

void MtmdLlmContext::handleStopRequestAndAddEot(LlamaBatch& batch) {
  stopGeneration_.store(false);
  llama_token eot = llama_vocab_eot(vocab_);
  common_batch_add(
      *batch,
      eot == LLAMA_TOKEN_NULL ? llama_vocab_eos(vocab_) : eot,
      nPast_++,
      {0},
      true);
  if (llama_decode(lctx_, *batch) != 0) {
    const char* errorMsg = "[MtmdLlm] failed to decode EOT token\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(FailedToDecode), errorMsg);
  }
}

bool MtmdLlmContext::generateResponse(
    const std::function<void(const std::string&)>& outputCallback) {

  int nRemain = params_.n_predict;
  LlamaBatch batch(1, 0, 1); // batch for next token generation

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
              "[MtmdLlm] generation overflow: context is full and nDiscarded "
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

    if (llama_vocab_is_eog(vocab_, tokenId) || checkAntiprompt()) {
      flushPendingUtf8ToCallback(outputCallback);
      break;
    }

    common_batch_clear(*batch);
    if (stopGeneration_.load()) {
      handleStopRequestAndAddEot(batch);
      break;
    }
    common_batch_add(*batch, tokenId, nPast_++, {0}, true);

    // eval the token
    if (llama_decode(lctx_, *batch) != 0) {
      const char* errorMsg = "[MtmdLlm] failed to decode next token\n";
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
MtmdLlmContext::applyGenerationParams(const GenerationParams& overrides) {
  return applyGenerationParamsToContext(params_, smpl_, model_, overrides);
}

void MtmdLlmContext::stop() { stopGeneration_.store(true); }

llama_context* MtmdLlmContext::getCtx() { return lctx_; }

llama_pos MtmdLlmContext::getNPast() const { return nPast_; }

void MtmdLlmContext::setNPast(llama_pos nPast) { this->nPast_ = nPast; }

llama_pos MtmdLlmContext::getFirstMsgTokens() const { return firstMsgTokens_; }

void MtmdLlmContext::setFirstMsgTokens(llama_pos firstMsgTokens) {
  this->firstMsgTokens_ = firstMsgTokens;
}

void MtmdLlmContext::setNDiscarded(llama_pos nDiscarded) {
  this->nDiscarded_ = nDiscarded;
}

int32_t MtmdLlmContext::getNSlides() const { return nSlides_; }
void MtmdLlmContext::resetNSlides() { nSlides_ = 0; }

void MtmdLlmContext::loadMedia(const std::vector<uint8_t>& media) {
  if (media.empty()) {
    resetMedia();
    const char* errorMsg = "[MtmdLlm] Media buffer is empty\n";
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  if (ctxVision_.get() == nullptr) {
    resetMedia();
    const char* errorMsg = "[MtmdLlm] Vision context is not initialized\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadModel), errorMsg);
  }

  mtmd::bitmap bmp(mtmd_helper_bitmap_init_from_buf(
      ctxVision_.get(), media.data(), media.size()));
  if (!bmp.ptr) {
    resetMedia();
    const char* errorMsg =
        "[MtmdLlm] Failed to load media from memory buffer\n";
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }
  bitmaps_.entries.push_back(std::move(bmp));
}

void MtmdLlmContext::loadMedia(const std::string& fname) {
  if (fname.empty()) {
    resetMedia();
    const char* errorMsg = "[MtmdLlm] Filename is empty\n";
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  if (ctxVision_.get() == nullptr) {
    resetMedia();
    const char* errorMsg = "[MtmdLlm] Vision context is not initialized\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadModel), errorMsg);
  }

  mtmd::bitmap bmp(
      mtmd_helper_bitmap_init_from_file(ctxVision_.get(), fname.c_str()));
  if (!bmp.ptr) {
    resetMedia();
    std::string errorMsg = string_format(
        "[MtmdLlm] Failed to load media from file: %s\n", fname.c_str());
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }
  bitmaps_.entries.push_back(std::move(bmp));
}

void MtmdLlmContext::resetState(bool resetStats) {

  tools_.reset();
  // Reset the n_past
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

  // Reset the KV cache
  llama_memory_clear(llama_get_memory(lctx_), true);

  // Reset the performance metrics
  if (resetStats) {
    llama_perf_context_reset(lctx_);
  }

  // Reset sampler if available
  common_sampler_reset(smpl_.get());

  // Synchronize to ensure all operations are complete
  llama_synchronize(lctx_);
}

void MtmdLlmContext::resetMedia() { bitmaps_.entries.clear(); }

llama_pos MtmdLlmContext::removeLastNTokens(llama_pos count) {
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
