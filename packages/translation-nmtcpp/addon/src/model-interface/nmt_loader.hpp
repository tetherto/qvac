#pragma once

#include "nmt.hpp"

struct nmt_context* nmt_init_with_params_no_state(
    struct nmt_model_loader* loader, struct nmt_context_params params);

struct nmt_context* nmt_init_from_file_with_params_no_state(
    const char* path_model, struct nmt_context_params params);

struct nmt_context* nmt_init_from_file_with_params(
    const char* path_model, struct nmt_context_params params);
