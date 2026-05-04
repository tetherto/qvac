#pragma once

int nmtDecodeBeamSearch(
    struct nmt_context* ctx,
    int beamSize, // NOLINT(readability-identifier-naming)
    int maxTokens);
