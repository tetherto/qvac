#pragma once

#include "nmt.hpp"

nmt_vocab::id find_bos_token(const nmt_vocab& vocab, e_model model_type);
nmt_vocab::id find_eos_token(const nmt_vocab& vocab, e_model model_type);

int nmt_token_count(struct nmt_context* ctx, const char* text);

int nmt_tokenize_input(struct nmt_context* ctx, const char* input_text);

int nmt_tokenize(
    struct nmt_context* ctx, const char* text, nmt_token* tokens,
    int n_max_tokens);

std::string detokenize_sentencepiece(const nmt_context* ctx);
