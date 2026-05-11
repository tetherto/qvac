#pragma once

int nmtDecodeBeamSearch(
    struct nmt_context* ctx, // NOLINT(readability-identifier-naming)
    int beamSize, int maxTokens);
