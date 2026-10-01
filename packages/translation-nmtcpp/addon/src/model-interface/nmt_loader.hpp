#pragma once

#include "nmt.hpp"

struct nmt_context* nmtInitWithParamsNoState(
    struct nmt_model_loader* loader, struct nmt_context_params params);

struct nmt_context* nmtInitFromFileWithParamsNoState(
    const char* pathModel, struct nmt_context_params params);
