// NOLINTBEGIN
#include "nmt_tokenization.hpp"

#include <algorithm>
#include <sstream>
#include <string>
#include <vector>

#include "nmt.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

using namespace std;

static std::vector<nmt_vocab::id> common_sentencepiece_tokenize(
    sentencepiece::SentencePieceProcessor* processor, const std::string& text,
    const nmt_vocab& vocab) {

  std::vector<nmt_vocab::id> tokens;

  if (processor == nullptr) {
    return tokens;
  }

  std::vector<std::string> pieces;
  if (!processor->Encode(text, &pieces).ok()) {
    return tokens;
  }

  tokens.reserve(pieces.size());
  for (const std::string& piece : pieces) {
    auto it = vocab.src_token_to_id.find(piece);
    if (it != vocab.src_token_to_id.end()) {
      tokens.push_back(it->second);
    } else {
      // NMT_LOG_WARN("SentencePiece piece '%s' not found in vocabulary, using
      // <unk>\n", piece.c_str());
      auto unk_it = vocab.src_token_to_id.find("<unk>");
      if (unk_it != vocab.src_token_to_id.end()) {
        tokens.push_back(unk_it->second);
      } else {
        throw std::runtime_error(
            "SentencePiece piece not found in vocabulary and <unk> not found");
      }
    }
  }

  return tokens;
}

nmt_vocab::id find_bos_token(const nmt_vocab& vocab) {
  std::vector<std::string> bos_candidates = {"</s>"};

  for (const auto& candidate : bos_candidates) {
    auto it = vocab.src_token_to_id.find(candidate);
    if (it != vocab.src_token_to_id.end()) {
      return it->second;
    }
  }

  return 1;
}

static std::vector<nmt_vocab::id>
indictrans_tokenize(const nmt_vocab& vocab, const std::string& text) {
  std::vector<nmt_vocab::id> tokens;

  if (!vocab.has_sentencepiece_processors) {
    return tokens;
  }

  std::istringstream iss(text);
  std::string src_lang, tgt_lang, actual_text;
  if (!(iss >> src_lang >> tgt_lang)) {
    return tokens;
  }

  std::getline(iss, actual_text);
  if (!actual_text.empty() && actual_text[0] == ' ') {
    actual_text = actual_text.substr(1);
  }

  auto src_it = vocab.src_token_to_id.find(src_lang);
  auto tgt_it = vocab.src_token_to_id.find(tgt_lang);

  if (src_it != vocab.src_token_to_id.end()) {
    tokens.push_back(src_it->second);
  }

  if (tgt_it != vocab.src_token_to_id.end()) {
    tokens.push_back(tgt_it->second);
  }

  std::vector<nmt_vocab::id> text_tokens = common_sentencepiece_tokenize(
      vocab.src_processor.get(), actual_text, vocab);

  tokens.insert(tokens.end(), text_tokens.begin(), text_tokens.end());

  auto eos_it = vocab.src_token_to_id.find("</s>");
  if (eos_it != vocab.src_token_to_id.end() &&
      tokens.back() != eos_it->second) {
    tokens.push_back(eos_it->second);
  }

  return tokens;
}

static std::vector<nmt_vocab::id>
tokenize(const nmt_context* ctx, const std::string& text) {
  if (ctx->model.type == e_model::MODEL_INDICTRANS) {
    return indictrans_tokenize(ctx->vocab, text);
  }

  return {};
}

std::string detokenize_sentencepiece(const nmt_context* ctx) {
  std::string text;
  const auto& vocab = ctx->vocab;
  const auto& token_ids = ctx->state->decoder_inputs;

  if (!vocab.tgt_processor || !vocab.has_sentencepiece_processors) {
    return text;
  }

  std::vector<std::string> tokens;
  const auto& src_id_to_token = vocab.tgt_id_to_token;
  for (auto&& id : token_ids) {
    if (id != 0 && id != 1 && id != vocab.bos_token_id) {
      auto find_iter = src_id_to_token.find(id);
      if (find_iter != src_id_to_token.end()) {
        tokens.emplace_back(find_iter->second);
      } else {
        auto unk_iter = src_id_to_token.find(vocab.tgt_processor->unk_id());
        if (unk_iter != src_id_to_token.end()) {
          tokens.emplace_back("<unk>");
        } else {
          throw std::runtime_error("SentencePiece piece not found in "
                                   "vocabulary and <unk> not found");
        }
      }
    }
  }

  auto r = vocab.tgt_processor->Decode(tokens, &text);
  if (!r.ok()) {
    std::string error_msg = std::string("Failed to detokenize: ") + r.message();
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR, error_msg);
    return text;
  }

  return text;
}

int nmt_tokenize_input(struct nmt_context* ctx, const char* input_text) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[TOKENIZE] Input text: \"" + std::string(input_text) + "\"");

  int n_tokens = nmt_token_count(ctx, input_text);
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[TOKENIZE] Token count: " + std::to_string(n_tokens));

  ctx->state->text_tokens.resize(n_tokens);

  int actual_tokens =
      nmt_tokenize(ctx, input_text, ctx->state->text_tokens.data(), n_tokens);
  if (actual_tokens < 0) {
    throw std::runtime_error("Tokenization failed!");
  }

  return actual_tokens;
}

int nmt_tokenize(
    struct nmt_context* ctx, const char* text, nmt_token* tokens,
    int n_max_tokens) {
  const auto res = tokenize(ctx, text);

  if (n_max_tokens < (int)res.size()) {
    // NMT_LOG_ERROR("%s: too many resulting tokens: %d (max %d)\n", __func__,
    // (int) res.size(), n_max_tokens);
    return -(int)res.size();
  }

  for (int i = 0; i < (int)res.size(); i++) {
    tokens[i] = res[i];
  }

  return res.size();
}

int nmt_token_count(struct nmt_context* ctx, const char* text) {
  return -nmt_tokenize(ctx, text, NULL, 0);
}
// NOLINTEND
