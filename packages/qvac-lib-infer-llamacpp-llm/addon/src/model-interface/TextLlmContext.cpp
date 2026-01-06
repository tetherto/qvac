#include "TextLlmContext.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

#include <llama.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

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
    common_params& commonParams, common_init_result&& llamaInit)
    : llama_init(std::move(llamaInit)), params(commonParams) {
  {

    model = llama_init.model.get();
    lctx = llama_init.context.get();
    if (model == nullptr) {
      throw qvac_errors::StatusError(
          AddonID, toString(UnableToLoadModel), "Failed to initialize model");
    }

    if (lctx == nullptr) {
      throw qvac_errors::StatusError(
          AddonID, toString(UnableToLoadModel), "Failed to initialize context");
    }

    vocab = llama_model_get_vocab(model);

    is_qwen3_model_ =
        qvac_lib_inference_addon_llama::utils::isQwen3Model(model);
    if (is_qwen3_model_) {
      qvac_lib_inference_addon_llama::utils::initializeQwen3ReasoningState(
          lctx, reasoning_state_);
    }

    std::string chat_template = getChatTemplate(model, params);
    tmpls = common_chat_templates_init(model, chat_template);

    smpl.reset(common_sampler_init(model, params.sampling));
    if (!smpl) {
      std::string errorMsg = string_format(
          "[TextLlm] %s: failed to initialize sampling subsystem\n", __func__);
      throw qvac_errors::StatusError(
          AddonID, toString(UnableToCreateSamplingSystem), errorMsg);
    }

    if (!llama_model_has_encoder(model) && llama_vocab_get_add_eos(vocab)) {
      throw qvac_errors::StatusError(
          AddonID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          "For decoder-only models, should NOT automatically add EOS tokens");
    }

    int gaN = params.grp_attn_n;
    int gaW = params.grp_attn_w;
    if (gaN != 1) {
      if (gaN <= 0) {
        throw qvac_errors::StatusError(
            AddonID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            "grp_attn_n must be positive");
      }
      if (gaW % gaN != 0) {
        throw qvac_errors::StatusError(
            AddonID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            "grp_attn_w must be a multiple of grp_attn_n");
      }
    }

    // antiprompt init
    for (const std::string& antiprompt : params.antiprompt) {
      auto ids = ::common_tokenize(lctx, antiprompt, false, true);
      if (ids.size() == 1) {
        antiprompt_tokens.push_back(ids[0]);
      }
    }

    // threadpool init
    auto* cpuDev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (cpuDev == nullptr) {
      throw qvac_errors::StatusError(
          AddonID, toString(NoCpuBackendFound), "no CPU backend found");
    }

    auto* reg = ggml_backend_dev_backend_reg(cpuDev);
    void* procAddr =
        ggml_backend_reg_get_proc_address(reg, "ggml_threadpool_new");
    if (procAddr == nullptr) {
      throw qvac_errors::StatusError(
          AddonID,
          toString(UnableToCreateThreadPool),
          "Failed to get ggml_threadpool_new function address");
    }
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
    auto* ggmlThreadpoolNewFn =
        reinterpret_cast<decltype(ggml_threadpool_new)*>(procAddr);

    struct ggml_threadpool_params tppBatch =
        ggml_threadpool_params_from_cpu_params(params.cpuparams_batch);
    struct ggml_threadpool_params tpp =
        ggml_threadpool_params_from_cpu_params(params.cpuparams);

    set_process_priority(params.cpuparams.priority);

    if (!ggml_threadpool_params_match(&tpp, &tppBatch)) {
      threadpool_batch.reset(ggmlThreadpoolNewFn(&tppBatch));
      if (!threadpool_batch) {
        throw qvac_errors::StatusError(
            AddonID,
            toString(UnableToCreateThreadPool),
            "batch threadpool create failed");
      }
      // Start the non-batch threadpool in the paused state
      tpp.paused = true;
    }

    threadpool.reset(ggmlThreadpoolNewFn(&tpp));
    if (!threadpool) {
      throw qvac_errors::StatusError(
          AddonID,
          toString(UnableToCreateThreadPool),
          "threadpool create failed");
    }
    llama_attach_threadpool(lctx, threadpool.get(), threadpool_batch.get());

    // log system info
    QLOG_IF(Priority::DEBUG, [&]() {
      return string_format(
          "[TextLlm] %s\n", common_params_get_system_info(params).c_str());
    }());
  }
}

bool TextLlmContext::checkAntiprompt() {
  if (!params.antiprompt.empty()) {
    constexpr int K_N_PREV = 32;
    std::string lastOutput = common_sampler_prev_str(smpl.get(), lctx, K_N_PREV);

    // Check if each of the reverse prompts appears at the end of the output.
    for (std::string& antiprompt : params.antiprompt) {
      size_t extraPadding = 2;
      size_t searchStartPos =
          lastOutput.length() >
                  static_cast<size_t>(antiprompt.length() + extraPadding)
              ? lastOutput.length() -
                    static_cast<size_t>(antiprompt.length() + extraPadding)
              : 0;

      if (lastOutput.find(antiprompt, searchStartPos) != std::string::npos) {
        return true;
      }
    }

    // check for reverse prompt using special tokens
    llama_token lastToken = common_sampler_last(smpl.get());
    for (auto token : antiprompt_tokens) {
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
  std::string prompt;
  common_chat_templates_inputs inputs;

  bool isLastMessageFromUser = false;
  bool addSpecial = false;

  if (n_past == 0 && !isCacheLoaded) {
    isLastMessageFromUser = true;
    addSpecial = true;
  } else if (n_past > 0) {
    isLastMessageFromUser = chatMsgs.back().role == "user";
    common_sampler_reset(smpl.get());
    addSpecial = false;
  }

  inputs.use_jinja = params.use_jinja;
  inputs.messages = chatMsgs;
  inputs.add_generation_prompt = isLastMessageFromUser;

  if (!tools.empty()) {
    inputs.tools = tools;
  }
  prompt = getPrompt(tmpls.get(), inputs);

  QLOG_IF(
      Priority::DEBUG,
      string_format("[TextLlm] formatted prompt: %s\n", prompt.c_str()));

  if (!prompt.empty()) {
    inputTokens = common_tokenize(lctx, prompt, addSpecial, true);
  } else {
    std::string errorMsg = string_format(
        "[TextLlm] %s: formatted chat prompt is empty\n", __func__);
    throw qvac_errors::StatusError(AddonID, toString(EmptyPrompt), errorMsg);
  }

  if (inputTokens.empty()) {
    std::string errorMsg =
        string_format("[TextLlm] %s: tokenized input is empty\n", __func__);
    throw qvac_errors::StatusError(
        AddonID, toString(EmptyTokenizedInput), errorMsg);
  }

  // Encode the input if model has encoder
  if (llama_model_has_encoder(model) && n_past == 0 && !isCacheLoaded) {
    int encInputSize = static_cast<int>(inputTokens.size());
    llama_token* encInputBuf = inputTokens.data();

    if (llama_encode(lctx, llama_batch_get_one(encInputBuf, encInputSize)) !=
        0) {
      std::string errorMsg =
          string_format("[TextLlm] %s : failed to eval encoder\n", __func__);
      throw qvac_errors::StatusError(
          AddonID, toString(EncoderFailed), errorMsg);
    }

    llama_token decoderStartTokenId = llama_model_decoder_start_token(model);
    if (decoderStartTokenId == LLAMA_TOKEN_NULL) {
      decoderStartTokenId = llama_vocab_bos(vocab);
    }

    inputTokens.clear();
    inputTokens.push_back(decoderStartTokenId);
  }
};

bool TextLlmContext::evalMessage(
    const std::vector<common_chat_msg>& chatMsgs, bool isCacheLoaded) {
  return evalMessageWithTools(chatMsgs, {}, isCacheLoaded);
}

bool TextLlmContext::evalMessageWithTools(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, bool isCacheLoaded) {
  std::vector<llama_token> inputTokens;
  tokenizeChat(chatMsgs, tools, inputTokens, isCacheLoaded);

  size_t nTokens = inputTokens.size();
  const bool isFirstMsg = (n_past == 0);

  if (nTokens >= llama_n_ctx(lctx)) {
    std::string errorMsg = string_format(
        "[TextLlm] context overflow at prefill step (%ld tokens, max %d)\n",
        nTokens,
        llama_n_ctx(lctx));
    throw qvac_errors::StatusError(
        AddonID, toString(ContextOverflow), errorMsg);
  }
  if (n_past + nTokens >= llama_n_ctx(lctx)) {

    llama_pos leftTokens = n_past - firstMsgTokens - n_discarded;
    if (leftTokens >= 0 && n_past + nTokens - n_discarded < llama_n_ctx(lctx)) {
      auto* mem = llama_get_memory(lctx);
      llama_memory_seq_rm(mem, 0, firstMsgTokens, firstMsgTokens + n_discarded);
      llama_memory_seq_add(
          mem, 0, firstMsgTokens + n_discarded, n_past, -n_discarded);
      n_past -= n_discarded;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[TextLlm] Prefill step: discarded %d tokens after the first "
              "message\n",
              n_discarded));
    } else if (
        leftTokens < 0 && firstMsgTokens + nTokens < llama_n_ctx(lctx) &&
        n_discarded > 0) {
      auto* mem = llama_get_memory(lctx);
      llama_memory_seq_rm(mem, 0, firstMsgTokens, n_past);
      n_past = firstMsgTokens;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[TextLlm] Prefill step: discarded %d tokens after the first "
              "message\n",
              n_discarded));
    } else {
      std::string errorMsg = string_format(
          "[TextLlm] context overflow at prefill step (%ld tokens, max "
          "%d)\n",
          n_past + nTokens,
          llama_n_ctx(lctx));
      throw qvac_errors::StatusError(
          AddonID, toString(ContextOverflow), errorMsg);
    }
  }
  BatchPtr textBatchPtr =
      BatchPtr(new llama_batch(llama_batch_init(params.n_batch, 0, 1)));

  llama_pos count = n_past;
  llama_pos tokenIndex = 0;
  while (tokenIndex < nTokens) { // split into batches
    if (stop_generation
            .load()) { // remove the last added tokens from the context
      removeLastNTokens(tokenIndex);
      stop_generation.store(false);
      return false;
    }
    textBatchPtr->n_tokens = 0; // clear the batch
    // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,bugprone-narrowing-conversions,readability-implicit-bool-conversion,readability-identifier-naming)
    for (; tokenIndex < nTokens && textBatchPtr->n_tokens < params.n_batch;
         tokenIndex++) {
      llama_pos batchTokenIndex = textBatchPtr->n_tokens;
      // NOLINTNEXTLINE(clang-analyzer-core.NullDereference)
      textBatchPtr->token[batchTokenIndex] = inputTokens[tokenIndex];
      textBatchPtr->pos[batchTokenIndex] = static_cast<llama_pos>(count++);
      textBatchPtr->n_seq_id[batchTokenIndex] = 1;
      textBatchPtr->seq_id[batchTokenIndex][0] = 0;
      textBatchPtr->logits[batchTokenIndex] = static_cast<int8_t>(false);

      textBatchPtr->n_tokens++;
    }
    bool isLastToken = (tokenIndex == nTokens);
    if (isLastToken) {
      textBatchPtr->logits[textBatchPtr->n_tokens - 1] =
          static_cast<int8_t>(true);
    }
    // NOLINTNEXTLINE(clang-analyzer-core.CallAndMessage)
    int ret = llama_decode(lctx, *textBatchPtr);
    if (ret != 0) {
      std::string errorMsg = string_format(
          "[TextLlm] %s: failed to decode input tokens\n", __func__);
      throw qvac_errors::StatusError(
          AddonID, toString(FailedToDecode), errorMsg);
    }

    n_past += textBatchPtr->n_tokens;
    // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,bugprone-narrowing-conversions,readability-implicit-bool-conversion,readability-identifier-naming)
  }

  if (isFirstMsg) {
    firstMsgTokens = n_past;
    if (n_discarded >= llama_n_ctx(lctx) - firstMsgTokens) {
      n_discarded = llama_n_ctx(lctx) - firstMsgTokens - 1;
    }
  }
  return true;
}

bool TextLlmContext::generateResponse(
    const std::function<void(const std::string&)>& outputCallback) {

  int nRemain = params.n_predict;
  BatchPtr batchPtr = BatchPtr(new llama_batch(
      llama_batch_init(1, 0, 1))); // batch for next token generation

  // Reset reasoning state at start of generation (preserve cached tokens)
  reasoning_state_.inside_reasoning = false;
  reasoning_state_.recent_output_buffer.clear();

  while (nRemain != 0) {
    if (n_past + 1 > llama_n_ctx(lctx) && n_discarded == 0) {
      return false;
    } else if (n_past + 1 > llama_n_ctx(lctx) && n_discarded > 0) {
      auto* mem = llama_get_memory(lctx);
      llama_memory_seq_rm(mem, 0, firstMsgTokens, firstMsgTokens + n_discarded);
      llama_memory_seq_add(
          mem, 0, firstMsgTokens + n_discarded, n_past, -n_discarded);
      n_past -= n_discarded;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[TextLlm] discarded %d tokens after the first message\n",
              n_discarded));
    }

    llama_token tokenId = common_sampler_sample(smpl.get(), lctx, -1);
    common_sampler_accept(smpl.get(), tokenId, true);

    // decrement remaining sampling budget
    --nRemain;

    // send text to JS callback with UTF-8 buffering
    std::string tokenStr = common_token_to_piece(lctx, tokenId, params.special);

    if (outputCallback) {
      // Use buffer to accumulate tokens until complete UTF-8 sequences
      std::string completeChars = utf8_buffer_.addToken(tokenStr);
      if (!completeChars.empty()) {
        outputCallback(completeChars);
      }
    }

    if (is_qwen3_model_) {
      qvac_lib_inference_addon_llama::utils::updateQwen3ReasoningBuffer(
          tokenStr, reasoning_state_);
    }

    bool isEos = llama_vocab_is_eog(vocab, tokenId);
    if (isEos && is_qwen3_model_) {
      if (handleQwen3ReasoningEOS(
              tokenId, tokenStr, batchPtr.get(), n_past, outputCallback)) {
        continue;
      }
    }

    if (isEos || checkAntiprompt()) {
      // Flush any remaining UTF-8 bytes before ending generation
      if (outputCallback && utf8_buffer_.hasPendingBytes()) {
        std::string remaining = utf8_buffer_.flush();
        if (!remaining.empty()) {
          outputCallback(remaining);
        }
      }
      break; // end of generation
    }

    common_batch_clear(*batchPtr);
    // Check for stop generation request
    if (!stop_generation.load()) {
      common_batch_add(*batchPtr, tokenId, n_past++, {0}, true);
    } else {
      stop_generation.store(false);
      // Generation stopped by request - add EOT token and exit
      llama_token eot = llama_vocab_eot(vocab);
      common_batch_add(
          *batchPtr,
          eot == LLAMA_TOKEN_NULL ? llama_vocab_eos(vocab) : eot,
          n_past++,
          {0},
          true);
      // Decode the EOT token
      if (llama_decode(lctx, *batchPtr) != 0) {
        const char* errorMsg = "[TextLlm] failed to decode EOT token\n";
        throw qvac_errors::StatusError(
            AddonID, toString(FailedToDecode), errorMsg);
      }
      break; // Exit generation loop after processing EOT
    }

    // eval the token
    // NOLINT(clang-analyzer-core.CallAndMessage)
    if (llama_decode(lctx, *batchPtr) != 0) {
      const char* errorMsg = "[TextLlm] failed to decode next token\n";
      throw qvac_errors::StatusError(
          AddonID, toString(FailedToDecode), errorMsg);
    }
  }

  // Flush any remaining UTF-8 bytes at end of generation loop
  if (nRemain == 0 && outputCallback && utf8_buffer_.hasPendingBytes()) {
    std::string remaining = utf8_buffer_.flush();
    if (!remaining.empty()) {
      outputCallback(remaining);
    }
  }
  return true;
}

void TextLlmContext::stop() { stop_generation.store(true); }

void TextLlmContext::resetState(bool resetStats) {
  // Reset the n_past
  n_past = 0;

  // Reset the first msg token length
  firstMsgTokens = 0;

  // Clear UTF-8 buffer when resetting state
  utf8_buffer_.clear();

  // Clear the KV cache
  llama_memory_clear(llama_get_memory(lctx), true);

  // Reset performance metrics
  if (resetStats) {
    llama_perf_context_reset(lctx);
  }

  // Reset sampler if available
  common_sampler_reset(smpl.get());

  // Synchronize to ensure all operations are complete
  llama_synchronize(lctx);
}

llama_context* TextLlmContext::getCtx() { return lctx; }

llama_pos TextLlmContext::getNPast() const { return n_past; }

void TextLlmContext::setNPast(llama_pos nPast) { this->n_past = nPast; }

llama_pos TextLlmContext::getFirstMsgTokens() const { return firstMsgTokens; }

void TextLlmContext::setFirstMsgTokens(llama_pos firstMsgTokens) {
  this->firstMsgTokens = firstMsgTokens;
}

void TextLlmContext::setNDiscarded(llama_pos n_discarded) {
  this->n_discarded = n_discarded;
}

llama_pos TextLlmContext::removeLastNTokens(llama_pos count) {
  // Validate input
  if (count <= 0) {
    return 0;
  }

  // Calculate how many tokens we can actually remove
  llama_pos tokensToRemove = std::min(count, n_past);

  if (tokensToRemove == 0) {
    return 0;
  }

  // Get the memory for KV cache manipulation
  auto* mem = llama_get_memory(lctx);

  // Remove the last N tokens from the KV cache
  // llama_memory_seq_rm(memory, seq_id, start_pos, end_pos)
  // seq_id = -1 means all sequences
  // start_pos = n_past - tokensToRemove (the position to start removing from)
  // end_pos = -1 means remove to the end
  llama_memory_seq_rm(mem, -1, n_past - tokensToRemove, -1);

  // Decrement the token count by the number of tokens removed
  n_past -= tokensToRemove;

  // Note: The sampler doesn't have an "undo" function, so we leave it as is.
  // The sampler maintains its own history, but the removed tokens won't affect
  // future sampling since they're no longer in the KV cache.

  return tokensToRemove;
}

bool TextLlmContext::handleQwen3ReasoningEOS(
    llama_token& tokenId, std::string& tokenStr, llama_batch* batchPtr,
    llama_pos& n_past,
    const std::function<void(const std::string&)>& outputCallback) {

  if (!reasoning_state_.inside_reasoning) {
    return false;
  }

  if (reasoning_state_.cached_close_tag_token == LLAMA_TOKEN_NULL) {
    QLOG_IF(
        Priority::WARNING,
        "[TextLlm] EOS detected inside reasoning but no cached closing tag!\n");
    return false;
  }

  // Replace EOS with closing tag
  tokenId = reasoning_state_.cached_close_tag_token;
  tokenStr = common_token_to_piece(lctx, tokenId, params.special);
  reasoning_state_.inside_reasoning = false;

  // Stream closing tag to user
  if (outputCallback) {
    std::string completeChars = utf8_buffer_.addToken(tokenStr);
    if (!completeChars.empty()) {
      outputCallback(completeChars);
    }
  }

  // Decode closing tag
  common_batch_clear(*batchPtr);
  common_batch_add(*batchPtr, tokenId, n_past++, {0}, true);
  if (llama_decode(lctx, *batchPtr) != 0) {
    QLOG_IF(
        Priority::ERROR,
        "[TextLlm] Failed to decode closing tag during replacement\n");
  }

  // Inject 2 newlines after closing tag
  if (reasoning_state_.cached_newline_token != LLAMA_TOKEN_NULL) {
    for (int i = 0; i < 2; i++) {
      common_batch_clear(*batchPtr);
      common_batch_add(
          *batchPtr,
          reasoning_state_.cached_newline_token,
          n_past++,
          {0},
          true);

      if (llama_decode(lctx, *batchPtr) != 0) {
        QLOG_IF(
            Priority::ERROR,
            "[TextLlm] Failed to decode newline token during forced "
            "injection\n");
      }

      std::string newlineStr = common_token_to_piece(
          lctx, reasoning_state_.cached_newline_token, params.special);
      if (outputCallback) {
        std::string completeChars = utf8_buffer_.addToken(newlineStr);
        if (!completeChars.empty()) {
          outputCallback(completeChars);
        }
      }
    }
  }

  return true;
}
