#include "MtmdLlmContext.hpp"

#include <algorithm>

#include <common/log.h>
#include <llama/mtmd/mtmd-helper.h>
#include <llama/mtmd/mtmd.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

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
    common_params& commonParams, common_init_result&& llamaInit)
    : llamaInit_(std::move(llamaInit)), params_(commonParams),
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

  std::string chatTemplate = getChatTemplate(model_, params_);
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

    // Check if each of the reverse prompts appears at the end of the output.
    for (std::string& antiprompt : params_.antiprompt) {
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
  common_chat_templates_inputs inputs;
  std::string formattedChat;

  bool isLastMessageFromUser = false;
  bool addSpecial = false;

  if (nPast_ == 0 && !isCacheLoaded) {
    isLastMessageFromUser = true;
    addSpecial = true;
  } else if (nPast_ > 0) {
    isLastMessageFromUser = chatMsgs.back().role == "user";
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

  resetMedia();
}

bool MtmdLlmContext::evalMessage(
    const std::vector<common_chat_msg>& chatMsgs, bool isCacheLoaded) {
  return evalMessageWithTools(chatMsgs, {}, isCacheLoaded);
}

bool MtmdLlmContext::evalMessageWithTools(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, bool isCacheLoaded) {
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

    llama_pos leftTokens = nPast_ - firstMsgTokens_ - nDiscarded_;
    if (leftTokens >= 0 &&
        nPast_ + nTokens - nDiscarded_ < llama_n_ctx(lctx_)) {
      auto* mem = llama_get_memory(lctx_);
      llama_memory_seq_rm(
          mem, 0, firstMsgTokens_, firstMsgTokens_ + nDiscarded_);
      llama_memory_seq_add(
          mem, 0, firstMsgTokens_ + nDiscarded_, nPast_, -nDiscarded_);
      nPast_ -= nDiscarded_;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[MtmdLlm] Prefill step: discarded %d tokens after the first "
              "message\n",
              nDiscarded_));
    } else if (
        leftTokens < 0 && firstMsgTokens_ + nTokens < llama_n_ctx(lctx_) &&
        nDiscarded_ > 0) {
      auto* mem = llama_get_memory(lctx_);
      llama_memory_seq_rm(mem, 0, firstMsgTokens_, nPast_);
      nPast_ = firstMsgTokens_;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[MtmdLlm] Prefill step: discarded %d tokens after the first "
              "message\n",
              nDiscarded_));
    } else {
      std::string errorMsg = string_format(
          "[MtmdLlm] context overflow at prefill step (%ld tokens, max "
          "%d)\n",
          nPast_ + nTokens,
          llama_n_ctx(lctx_));
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextOverflow), errorMsg);
    }
  }

  size_t nChunks = mtmd_input_chunks_size(chunksPtr);
  if (nChunks == 0) {
    const char* errorMsg = "[MtmdLlm] Unable to eval prompt\n";
    throw qvac_errors::StatusError(ADDON_ID, toString(EncoderFailed), errorMsg);
  }

  llama_pos nPastLocal = nPast_;

  for (size_t i = 0; i < nChunks; i++) {
    bool chunkLogitsLast = (i == nChunks - 1);
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
    if (nDiscarded_ >= llama_n_ctx(lctx_) - firstMsgTokens_) {
      nDiscarded_ = llama_n_ctx(lctx_) - firstMsgTokens_ - 1;
    }
  }
  return true;
}

bool MtmdLlmContext::generateResponse(
    const std::function<void(const std::string&)>& outputCallback) {

  int nRemain = params_.n_predict;
  BatchPtr batchPtr = BatchPtr(new llama_batch(
      llama_batch_init(1, 0, 1))); // batch for next token generation

  while (nRemain != 0) {
    if (nPast_ + 1 > llama_n_ctx(lctx_) && nDiscarded_ == 0) {
      return false;
    } else if (nPast_ + 1 > llama_n_ctx(lctx_) && nDiscarded_ > 0) {
      auto* mem = llama_get_memory(lctx_);
      llama_memory_seq_rm(
          mem, 0, firstMsgTokens_, firstMsgTokens_ + nDiscarded_);
      llama_memory_seq_add(
          mem, 0, firstMsgTokens_ + nDiscarded_, nPast_, -nDiscarded_);
      nPast_ -= nDiscarded_;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[MtmdLlm] discarded %d tokens after the first message\n",
              nDiscarded_));
    }

    llama_token tokenId = common_sampler_sample(smpl_.get(), lctx_, -1);
    common_sampler_accept(smpl_.get(), tokenId, true);

    // decrement remaining sampling budget
    --nRemain;

    // send text to JS callback with UTF-8 buffering
    std::string tokenStr =
        common_token_to_piece(lctx_, tokenId, params_.special);
    if (outputCallback) {
      // Use buffer to accumulate tokens until complete UTF-8 sequences
      std::string completeChars = utf8Buffer_.addToken(tokenStr);
      if (!completeChars.empty()) {
        outputCallback(completeChars);
      }
    }

    if (llama_vocab_is_eog(vocab_, tokenId) || checkAntiprompt()) {
      // Flush any remaining UTF-8 bytes before ending generation
      if (outputCallback && utf8Buffer_.hasPendingBytes()) {
        std::string remaining = utf8Buffer_.flush();
        if (!remaining.empty()) {
          outputCallback(remaining);
        }
      }
      break; // end of generation
    }

    common_batch_clear(*batchPtr);
    // Check for stop generation request
    if (!stopGeneration_.load()) {
      common_batch_add(*batchPtr, tokenId, nPast_++, {0}, true);
    } else {
      // Generation stopped by request - add EOT token and exit
      stopGeneration_.store(false);
      llama_token eot = llama_vocab_eot(vocab_);
      common_batch_add(
          *batchPtr,
          eot == LLAMA_TOKEN_NULL ? llama_vocab_eos(vocab_) : eot,
          nPast_++,
          {0},
          true);
      // Decode the EOT token
      if (llama_decode(lctx_, *batchPtr) != 0) {
        const char* errorMsg = "[MtmdLlm] failed to decode EOT token\n";
        throw qvac_errors::StatusError(
            ADDON_ID, toString(FailedToDecode), errorMsg);
      }
      break; // Exit generation loop after processing EOT
    }

    // eval the token
    if (llama_decode(lctx_, *batchPtr) != 0) {
      const char* errorMsg = "[MtmdLlm] failed to decode next token\n";
      throw qvac_errors::StatusError(
          ADDON_ID, toString(FailedToDecode), errorMsg);
    }
  }

  // Flush any remaining UTF-8 bytes at end of generation loop
  if (nRemain == 0 && outputCallback && utf8Buffer_.hasPendingBytes()) {
    std::string remaining = utf8Buffer_.flush();
    if (!remaining.empty()) {
      outputCallback(remaining);
    }
  }
  return true;
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
  // Reset the n_past
  nPast_ = 0;

  // Reset the first msg token length
  firstMsgTokens_ = 0;

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
