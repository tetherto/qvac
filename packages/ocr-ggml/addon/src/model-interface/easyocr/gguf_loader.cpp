#include "gguf_loader.hpp"

#include "ggml.h"
#include "gguf.h"

namespace easyocr::ggml {

GgufLoader::GgufLoader(const std::string& path, bool load_tensor_data)
    : path_(path) {
    gguf_init_params params{
        /* .no_alloc = */ !load_tensor_data,
        /* .ctx      = */ &meta_ctx_,
    };
    gguf_ = gguf_init_from_file(path_.c_str(), params);
    if (gguf_ == nullptr && meta_ctx_ != nullptr) {
        // gguf_init_from_file may allocate ctx even when it later fails;
        // free it so we don't leak.
        ggml_free(meta_ctx_);
        meta_ctx_ = nullptr;
    }
}

GgufLoader::~GgufLoader() {
    if (gguf_ != nullptr) {
        gguf_free(gguf_);
        gguf_ = nullptr;
    }
    if (meta_ctx_ != nullptr) {
        ggml_free(meta_ctx_);
        meta_ctx_ = nullptr;
    }
}

int64_t GgufLoader::n_tensors() const noexcept {
    return gguf_ != nullptr ? gguf_get_n_tensors(gguf_) : 0;
}

int64_t GgufLoader::n_kv() const noexcept {
    return gguf_ != nullptr ? gguf_get_n_kv(gguf_) : 0;
}

::ggml_tensor* GgufLoader::get_tensor(const std::string& name) const noexcept {
    if (meta_ctx_ == nullptr) {
        return nullptr;
    }
    return ggml_get_tensor(meta_ctx_, name.c_str());
}

std::optional<std::string_view>
GgufLoader::get_string(const std::string& key) const noexcept {
    if (gguf_ == nullptr) {
        return std::nullopt;
    }
    const int64_t id = gguf_find_key(gguf_, key.c_str());
    if (id < 0) {
        return std::nullopt;
    }
    if (gguf_get_kv_type(gguf_, id) != GGUF_TYPE_STRING) {
        return std::nullopt;
    }
    return std::string_view(gguf_get_val_str(gguf_, id));
}

std::optional<uint32_t>
GgufLoader::get_u32(const std::string& key) const noexcept {
    if (gguf_ == nullptr) {
        return std::nullopt;
    }
    const int64_t id = gguf_find_key(gguf_, key.c_str());
    if (id < 0) {
        return std::nullopt;
    }
    if (gguf_get_kv_type(gguf_, id) != GGUF_TYPE_UINT32) {
        return std::nullopt;
    }
    return gguf_get_val_u32(gguf_, id);
}

std::optional<uint64_t>
GgufLoader::get_u64(const std::string& key) const noexcept {
    if (gguf_ == nullptr) {
        return std::nullopt;
    }
    const int64_t id = gguf_find_key(gguf_, key.c_str());
    if (id < 0) {
        return std::nullopt;
    }
    if (gguf_get_kv_type(gguf_, id) != GGUF_TYPE_UINT64) {
        return std::nullopt;
    }
    return gguf_get_val_u64(gguf_, id);
}

}  // namespace easyocr::ggml
