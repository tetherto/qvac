#pragma once

// This file defines some implementation types so that we can test the blob
// stream

#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>

#include "qvac-lib-inference-addon-cpp/BlobsStream.hpp"


#ifdef GGML_SHARED
#    if defined(_WIN32) && !defined(__MINGW32__)
#        ifdef GGML_BUILD
#            define GGML_CLASS_API __declspec(dllexport)
#        else
#            define GGML_CLASS_API __declspec(dllimport)
#        endif
#    else
#        define GGML_CLASS_API __attribute__((visibility("default")))
#    endif
#else
#    define GGML_CLASS_API
#endif

/// @brief Custom basic_streambuf<char> for uint8_t input data, that owns the underlying data. 
/// @note basic_streambuf<char> has more support on different platforms than basic_streambuf<uint8_t>
/// which is missing on some platforms (e.g. MacOS, newer NDKs). C++ 17 provides additional guarantees for char.
class GGML_CLASS_API Uint8BufferStreamBuf : public std::basic_streambuf<char> {
  public:
    Uint8BufferStreamBuf(std::vector<uint8_t> && _data);

  protected:
    int_type underflow() override;

    /// @brief Efficient bulk reading. The standard implementation specifies that this function can be overridden
    /// to provide a more efficient implementation: sgetn will call this function if it is overridden.
    std::streamsize xsgetn(char_type * s, std::streamsize n) override;

    pos_type seekoff(off_type off, std::ios_base::seekdir dir,
                     std::ios_base::openmode which = std::ios_base::in) override;

    pos_type seekpos(pos_type pos, std::ios_base::openmode which = std::ios_base::in) override;

  private:
    std::vector<uint8_t> data;
};

/// @brief Owned version of BlobsStream that takes ownership of the data
template <typename T> class OwnedBlobsStream : public BlobsStream<T> {
public:
  OwnedBlobsStream(std::vector<std::vector<T>>&& data)
      : BlobsStream<T>(convert_to_blobs(data)),
        // Asuming data.data() on heap position remains unchanged after the move
        owned_data(std::move(data)) {}

private:
  std::vector<std::vector<T>> owned_data;

  static std::vector<std::pair<T*, std::size_t>>
  convert_to_blobs(const std::vector<std::vector<T>>& data) {
    std::vector<std::pair<T*, std::size_t>> blobs;
    blobs.reserve(data.size());

    for (const auto& vec : data) {
      if (!vec.empty()) {
        blobs.emplace_back(const_cast<T*>(vec.data()), vec.size());
      }
    }
    return blobs;
  }
};
