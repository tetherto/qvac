#pragma once

#include "nmt.hpp"

nmt_vocab::id findBosToken(const nmt_vocab& vocab);

int nmtTokenizeInput(struct nmt_context* ctx, const char* inputText);

int nmtTokenize(
    struct nmt_context* ctx, const char* text, nmt_token* tokens,
    int nMaxTokens);

std::string detokenizeSentencepiece(const nmt_context* ctx);
