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
    : llama_init(std::move(llamaInit)), params(commonParams),
      model(llama_init.model.get()), lctx(llama_init.context.get()) {

  if (model == nullptr) {
    throw qvac_errors::StatusError(
        AddonID,
        qvac_errors::general_error::toString(UnableToLoadModel),
        "Failed to initialize model.");
  }

  if (lctx == nullptr) {
    throw qvac_errors::StatusError(
        AddonID,
        qvac_errors::general_error::toString(UnableToLoadModel),
        "Failed to initialize context");
  }

  vocab = llama_model_get_vocab(model);

  std::string chat_template = getChatTemplate(model, params);
  tmpls = common_chat_templates_init(model, chat_template);

  smpl.reset(common_sampler_init(model, params.sampling));
  if (!smpl) {
    std::string errorMsg = string_format(
        "[MtmdLlm] %s: failed to initialize sampling subsystem\n", __func__);
    throw qvac_errors::StatusError(
        AddonID, toString(UnableToCreateSamplingSystem), errorMsg);
  }

  if ((llama_model_chat_template(model, nullptr) == nullptr) &&
      params.chat_template.empty()) {
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
        AddonID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "Model does not have chat template");
  }

  init_vision_context();

  // antiprompt init
  for (const std::string& antiprompt : params.antiprompt) {
    auto ids = ::common_tokenize(lctx, antiprompt, false, true);
    if (ids.size() == 1) {
      antiprompt_tokens.push_back(ids[0]);
    }
  }

  // load antiprompt tokens for legacy templates
  if (params.chat_template == "vicuna") {
    auto tempTokens = common_tokenize(lctx, "ASSISTANT:", false, true);
    antiprompt_tokens.insert(
        antiprompt_tokens.end(), tempTokens.begin(), tempTokens.end());
  } else if (params.chat_template == "deepseek") {
    auto tempTokens = common_tokenize(lctx, "###", false, true);
    antiprompt_tokens.insert(
        antiprompt_tokens.end(), tempTokens.begin(), tempTokens.end());
  }
}

void MtmdLlmContext::init_vision_context() {
  const char* clipPath = params.mmproj.path.c_str();
  mtmd_context_params mparams = mtmd_context_params_default();
  mparams.use_gpu = params.mmproj_use_gpu;
  mparams.backend_device =
      params.mmproj_backend.empty() ? nullptr : params.mmproj_backend.c_str();
  mparams.print_timings = true;
  mparams.n_threads = params.cpuparams.n_threads;
  ctx_vision.reset(mtmd_init_from_file(clipPath, model, mparams));
  if (ctx_vision.get() == nullptr) {
    std::string errorMsg = string_format(
        "[MtmdLlm] Failed to load vision model from %s\n", clipPath);
    throw qvac_errors::StatusError(
        AddonID, toString(UnableToLoadModel), errorMsg);
  }
}

bool MtmdLlmContext::check_antiprompt() {
    if (!params.antiprompt.empty()) {
      constexpr int K_N_PREV = 32;
      std::string lastOutput =
          common_sampler_prev_str(smpl.get(), lctx, K_N_PREV);

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

void MtmdLlmContext::TokenizeChat(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, mtmd::input_chunks& chunks,
    bool isCacheLoaded) {
  common_chat_templates_inputs inputs;
  std::string formattedChat;

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
  formattedChat = getPrompt(tmpls.get(), inputs);

  if (formattedChat.empty()) {
    std::string errorMsg = string_format(
        "[MtmdLlm] %s: formatted chat prompt is empty\n", __func__);
    throw qvac_errors::StatusError(AddonID, toString(EmptyPrompt), errorMsg);
  }

  QLOG_IF(
      Priority::DEBUG,
      string_format("[MtmdLlm] formatted prompt: %s\n", formattedChat.c_str()));

  mtmd_input_text text;
  text.text = formattedChat.c_str();
  text.add_special = addSpecial;
  text.parse_special = true;

  auto bitmapsCPtr = bitmaps.c_ptr();
  int32_t res = mtmd_tokenize(
      ctx_vision.get(),
      chunks.ptr.get(), // output
      &text,            // text
      bitmapsCPtr.data(),
      bitmapsCPtr.size());
  if (res != 0) {
    resetMedia();
    std::string errorMsg = string_format(
        "[MtmdLlm] %s: Unable to tokenize prompt, res = %d\n", __func__, res);
    throw qvac_errors::StatusError(AddonID, toString(EncoderFailed), errorMsg);
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

  TokenizeChat(chatMsgs, tools, chunks, isCacheLoaded);

  const bool isFirstMsg = (n_past == 0);

  const mtmd_input_chunks* chunksPtr = chunks.ptr.get();

  size_t nTokens = mtmd_helper_get_n_tokens(chunksPtr);
  if (nTokens >= llama_n_ctx(lctx)) {
    std::string errorMsg = string_format(
        "[MtmdLlm] context overflow at prefill step (%ld tokens, max %d)\n",
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
              "[MtmdLlm] Prefill step: discarded %d tokens after the first "
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
              "[MtmdLlm] Prefill step: discarded %d tokens after the first "
              "message\n",
              n_discarded));
    } else {
      std::string errorMsg = string_format(
          "[MtmdLlm] context overflow at prefill step (%ld tokens, max "
          "%d)\n",
          n_past + nTokens,
          llama_n_ctx(lctx));
      throw qvac_errors::StatusError(
          AddonID, toString(ContextOverflow), errorMsg);
    }
  }

  size_t n_chunks = mtmd_input_chunks_size(chunksPtr);
  if (n_chunks == 0) {
    const char* errorMsg = "[MtmdLlm] Unable to eval prompt\n";
    throw qvac_errors::StatusError(AddonID, toString(EncoderFailed), errorMsg);
  }

  llama_pos nPastLocal = n_past;

  for (size_t i = 0; i < n_chunks; i++) {
    bool chunkLogitsLast = (i == n_chunks - 1);
    const auto* chunk = mtmd_input_chunks_get(chunksPtr, i);

    if (stop_generation.load()) {
      llama_pos totalDelta = nPastLocal - n_past;
      n_past = nPastLocal;
      removeLastNTokens(totalDelta);
      stop_generation.store(false);
      return false;
    }
    int32_t res = mtmd_helper_eval_chunk_single(
        ctx_vision.get(),
        lctx,
        chunk,
        nPastLocal,
        0,
        params.n_batch,
        chunkLogitsLast,
        &nPastLocal);
    if (res != 0) {
      std::string errorMsg =
          "[MtmdLlm] failed to eval chunk " + std::to_string(i);
      throw qvac_errors::StatusError(
          AddonID, toString(EncoderFailed), errorMsg);
    }
  }
  n_past = nPastLocal;

  if (isFirstMsg) {
    firstMsgTokens = n_past;
    if (n_discarded >= llama_n_ctx(lctx) - firstMsgTokens) {
      n_discarded = llama_n_ctx(lctx) - firstMsgTokens - 1;
    }
  }
  return true;
}

bool MtmdLlmContext::generateResponse(
    const std::function<void(const std::string&)>& outputCallback) {

  int nRemain = params.n_predict;
  BatchPtr batchPtr = BatchPtr(new llama_batch(
      llama_batch_init(1, 0, 1))); // batch for next token generation

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
              "[MtmdLlm] discarded %d tokens after the first message\n",
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

    if (llama_vocab_is_eog(vocab, tokenId) || check_antiprompt()) {
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
      // Generation stopped by request - add EOT token and exit
      stop_generation.store(false);
      llama_token eot = llama_vocab_eot(vocab);
      common_batch_add(
          *batchPtr,
          eot == LLAMA_TOKEN_NULL ? llama_vocab_eos(vocab) : eot,
          n_past++,
          {0},
          true);
      // Decode the EOT token
      if (llama_decode(lctx, *batchPtr) != 0) {
        const char* errorMsg = "[MtmdLlm] failed to decode EOT token\n";
        throw qvac_errors::StatusError(
            AddonID, toString(FailedToDecode), errorMsg);
      }
      break; // Exit generation loop after processing EOT
    }

    // eval the token
    if (llama_decode(lctx, *batchPtr) != 0) {
      const char* errorMsg = "[MtmdLlm] failed to decode next token\n";
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

void MtmdLlmContext::stop() { stop_generation.store(true); }

llama_context* MtmdLlmContext::getCtx() { 
    return lctx;
}

llama_pos MtmdLlmContext::getNPast() const {
    return n_past; 
}

void MtmdLlmContext::setNPast(llama_pos nPast) { this->n_past = nPast; }

llama_pos MtmdLlmContext::getFirstMsgTokens() const { return firstMsgTokens; }

void MtmdLlmContext::setFirstMsgTokens(llama_pos firstMsgTokens) {
  this->firstMsgTokens = firstMsgTokens;
}

void MtmdLlmContext::setNDiscarded(llama_pos nDiscarded) {
  this->n_discarded = nDiscarded;
}

void MtmdLlmContext::loadMedia(const std::vector<uint8_t>& media) {
    if (media.empty()) {
        resetMedia();
        const char* errorMsg = "[MtmdLlm] Media buffer is empty\n";
        throw qvac_errors::StatusError(
            AddonID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            errorMsg);
    }

    if (ctx_vision.get() == nullptr) {
      resetMedia();
      const char* errorMsg = "[MtmdLlm] Vision context is not initialized\n";
      throw qvac_errors::StatusError(
          AddonID, toString(UnableToLoadModel), errorMsg);
    }

    mtmd::bitmap bmp(mtmd_helper_bitmap_init_from_buf(ctx_vision.get(), media.data(), media.size()));
    if (!bmp.ptr) {
        resetMedia();
        const char* errorMsg =
            "[MtmdLlm] Failed to load media from memory buffer\n";
        throw qvac_errors::StatusError(
            AddonID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            errorMsg);
    }
    bitmaps.entries.push_back(std::move(bmp));
}

void MtmdLlmContext::loadMedia(const std::string& fname) {
    if (fname.empty()) {
        resetMedia();
        const char* errorMsg = "[MtmdLlm] Filename is empty\n";
        throw qvac_errors::StatusError(
            AddonID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            errorMsg);
    }

    if (ctx_vision.get() == nullptr) {
      resetMedia();
      const char* errorMsg = "[MtmdLlm] Vision context is not initialized\n";
      throw qvac_errors::StatusError(
          AddonID, toString(UnableToLoadModel), errorMsg);
    }

    mtmd::bitmap bmp(mtmd_helper_bitmap_init_from_file(ctx_vision.get(), fname.c_str()));
    if (!bmp.ptr) {
        resetMedia();
        std::string errorMsg = string_format(
            "[MtmdLlm] Failed to load media from file: %s\n", fname.c_str());
        throw qvac_errors::StatusError(
            AddonID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            errorMsg);
    }
    bitmaps.entries.push_back(std::move(bmp));
}

void MtmdLlmContext::resetState(bool resetStats) {
  // Reset the n_past
  n_past = 0;

  // Reset the first msg token length
  firstMsgTokens = 0;

  // Clear UTF-8 buffer when resetting state
  utf8_buffer_.clear();

  // Reset the KV cache
  llama_memory_clear(llama_get_memory(lctx), true);

  // Reset the performance metrics
  if (resetStats) {
    llama_perf_context_reset(lctx);
  }

  // Reset sampler if available
  common_sampler_reset(smpl.get());

  // Synchronize to ensure all operations are complete
  llama_synchronize(lctx);
}

void MtmdLlmContext::resetMedia() { bitmaps.entries.clear(); }

llama_pos MtmdLlmContext::removeLastNTokens(llama_pos count) {
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
