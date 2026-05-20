#pragma once

// Thin RAII wrapper around gguf_init_from_file.
//
// A GgufLoader owns both a gguf_context (the metadata + tensor index) and a
// backing ggml_context (the tensor descriptor storage that gguf_init_from_file
// populates when ctx != nullptr is requested). The destructor frees both.
//
// Tensor data lookup:  get_tensor(name)
// Metadata lookup:     get_string / get_u32 / get_u64
//                      (returns std::nullopt when the key is absent or the
//                       stored type does not match the requested accessor)
//
// Lifetime: any pointer or string_view returned by these accessors is
// owned by the GgufLoader and is invalidated when the loader is destroyed.

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

struct gguf_context;
struct ggml_context;
struct ggml_tensor;

namespace easyocr::ggml {

class GgufLoader {
public:
  // load_tensor_data=false (default) parses metadata + tensor descriptors
  // only, leaving each tensor's `data` pointer null. Pass true to also
  // mmap/read the tensor blobs into a backing ggml_context — required if
  // callers want to read weight values via `get_tensor(name)->data`.
  explicit GgufLoader(const std::string& path, bool load_tensor_data = false);
  ~GgufLoader();

  GgufLoader(const GgufLoader&) = delete;
  GgufLoader& operator=(const GgufLoader&) = delete;
  GgufLoader(GgufLoader&&) = delete;
  GgufLoader& operator=(GgufLoader&&) = delete;

  // True iff the file was opened and parsed successfully.
  bool ok() const noexcept { return gguf_ != nullptr; }

  // The path the loader was constructed with (for error reporting).
  const std::string& path() const noexcept { return path_; }

  int64_t n_tensors() const noexcept;
  int64_t n_kv() const noexcept;

  // Tensor data lookup by name. Returns nullptr if the tensor is absent or
  // the loader is not ok().
  ::ggml_tensor* get_tensor(const std::string& name) const noexcept;

  // Metadata accessors. Each returns std::nullopt if the key is absent or
  // the on-disk type does not match the accessor (no implicit conversion).
  std::optional<std::string_view>
  get_string(const std::string& key) const noexcept;
  std::optional<uint32_t> get_u32(const std::string& key) const noexcept;
  std::optional<uint64_t> get_u64(const std::string& key) const noexcept;

private:
  std::string path_;
  ::gguf_context* gguf_ = nullptr;
  ::ggml_context* meta_ctx_ = nullptr;
};

} // namespace easyocr::ggml
