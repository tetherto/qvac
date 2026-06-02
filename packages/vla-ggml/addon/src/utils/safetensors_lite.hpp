#pragma once

// Tiny header-only reader for the safetensors v1 format.
//
// Only the slice we need for the π₀.₅ parity tests:
//   - open() the file (mmap on POSIX, fallback to read on Windows)
//   - look up a named tensor's dtype, shape, and byte range
//   - copy the bytes out as a std::vector<float> when the dtype is F32
//
// Not a general-purpose safetensors lib — no bfloat16, no quantised types,
// no streaming. The PyTorch reference stores all breakpoints as F32.

#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace qvac_vla_safetensors_lite {

struct TensorRecord {
  std::string dtype;            // "F32", "F16", "I32", "BOOL", ...
  std::vector<int64_t> shape;
  uint64_t byte_offset = 0;     // offset into the data blob (NOT the file)
  uint64_t byte_length = 0;
};

class Reader {
public:
  Reader() = default;

  // Parses the header and reads the entire data blob into memory. Throws
  // std::runtime_error on any parse failure. Sized for the ~137 MB
  // reference activations; not appropriate for multi-GB files.
  void open(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
      throw std::runtime_error("safetensors: cannot open '" + path + "'");
    }
    in.seekg(0, std::ios::end);
    const std::streamoff total = in.tellg();
    if (total < 8) {
      throw std::runtime_error("safetensors: file too short");
    }
    in.seekg(0);

    uint64_t header_len = 0;
    in.read(reinterpret_cast<char*>(&header_len), 8);
    if (!in || header_len == 0 ||
        header_len > static_cast<uint64_t>(total) - 8) {
      throw std::runtime_error("safetensors: bad header length");
    }
    std::string header(header_len, '\0');
    in.read(header.data(), header_len);
    if (!in) {
      throw std::runtime_error("safetensors: short header read");
    }
    parseHeader_(header);

    const std::streamoff blob_off = 8 + static_cast<std::streamoff>(header_len);
    const std::streamoff blob_size = total - blob_off;
    blob_.resize(static_cast<size_t>(blob_size));
    in.read(reinterpret_cast<char*>(blob_.data()), blob_size);
    if (!in) {
      throw std::runtime_error("safetensors: short blob read");
    }
  }

  bool has(const std::string& name) const {
    return tensors_.find(name) != tensors_.end();
  }

  const TensorRecord& record(const std::string& name) const {
    auto it = tensors_.find(name);
    if (it == tensors_.end()) {
      throw std::runtime_error("safetensors: missing tensor '" + name + "'");
    }
    return it->second;
  }

  // Returns a copy of the tensor bytes as float32. Throws if the dtype is
  // not "F32" (a deliberate constraint — the C++ parity tests only ever
  // compare F32 activations to ggml's F32 graph outputs).
  std::vector<float> readF32(const std::string& name) const {
    const TensorRecord& r = record(name);
    if (r.dtype != "F32") {
      throw std::runtime_error(
          "safetensors: tensor '" + name + "' has dtype " + r.dtype +
          " (readF32 requires F32)");
    }
    if (r.byte_length % sizeof(float) != 0) {
      throw std::runtime_error(
          "safetensors: tensor '" + name + "' length not a float multiple");
    }
    std::vector<float> out(r.byte_length / sizeof(float));
    if (r.byte_offset + r.byte_length > blob_.size()) {
      throw std::runtime_error(
          "safetensors: tensor '" + name + "' byte range out of bounds");
    }
    std::memcpy(out.data(), blob_.data() + r.byte_offset, r.byte_length);
    return out;
  }

private:
  // Minimal JSON-ish parser tuned for the safetensors header shape:
  //   { "tensor_name": {"dtype":"F32","shape":[d0,d1,...],"data_offsets":[a,b]}, ... }
  // Plus an optional "__metadata__" key (ignored). Whitespace-tolerant. Not
  // a real JSON parser — strings cannot contain escapes other than \" and
  // \\, and numbers must be integers. This is enough for every safetensors
  // file the reference dump produces.
  void parseHeader_(const std::string& h) {
    Pos p{h, 0};
    p.skipWs();
    p.expect('{');
    p.skipWs();
    while (!p.atEnd() && p.peek() != '}') {
      std::string key = p.readString();
      p.skipWs();
      p.expect(':');
      p.skipWs();
      if (key == "__metadata__") {
        p.skipValue();
      } else {
        tensors_.emplace(std::move(key), parseTensorObject_(p));
      }
      p.skipWs();
      if (p.peek() == ',') {
        p.consume();
        p.skipWs();
      }
    }
    p.expect('}');
  }

  struct Pos {
    const std::string& s;
    size_t i;
    bool atEnd() const { return i >= s.size(); }
    char peek() const {
      if (atEnd()) {
        throw std::runtime_error("safetensors: unexpected end of header");
      }
      return s[i];
    }
    char consume() {
      char c = peek();
      ++i;
      return c;
    }
    void expect(char c) {
      if (consume() != c) {
        throw std::runtime_error(
            std::string("safetensors: expected '") + c + "' at offset " +
            std::to_string(i - 1));
      }
    }
    void skipWs() {
      while (!atEnd() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' ||
                          s[i] == '\r')) {
        ++i;
      }
    }
    std::string readString() {
      expect('"');
      std::string out;
      while (!atEnd() && s[i] != '"') {
        if (s[i] == '\\' && i + 1 < s.size()) {
          char nx = s[i + 1];
          if (nx == '"' || nx == '\\') {
            out.push_back(nx);
            i += 2;
            continue;
          }
        }
        out.push_back(s[i]);
        ++i;
      }
      expect('"');
      return out;
    }
    int64_t readInt() {
      skipWs();
      bool neg = false;
      if (peek() == '-') {
        neg = true;
        consume();
      }
      if (!std::isdigit(static_cast<unsigned char>(peek()))) {
        throw std::runtime_error(
            "safetensors: expected integer at offset " + std::to_string(i));
      }
      int64_t v = 0;
      while (!atEnd() && std::isdigit(static_cast<unsigned char>(s[i]))) {
        v = v * 10 + (s[i] - '0');
        ++i;
      }
      return neg ? -v : v;
    }
    // Skip an arbitrary JSON value — supports objects, arrays, strings, and
    // bare tokens (numbers, true, false, null). Used to ignore the
    // __metadata__ block whose schema we don't care about.
    void skipValue() {
      skipWs();
      char c = peek();
      if (c == '{' || c == '[') {
        char open = consume();
        char close = (open == '{') ? '}' : ']';
        int depth = 1;
        while (!atEnd() && depth > 0) {
          char ch = consume();
          if (ch == '"') {
            // Skip a string literal (with simple \" \\ escapes).
            while (!atEnd() && s[i] != '"') {
              if (s[i] == '\\' && i + 1 < s.size()) {
                i += 2;
              } else {
                ++i;
              }
            }
            if (atEnd()) {
              throw std::runtime_error("safetensors: unterminated string");
            }
            ++i; // closing quote
          } else if (ch == '{' || ch == '[') {
            ++depth;
          } else if (ch == '}' || ch == ']') {
            if (ch != close && depth == 1) {
              throw std::runtime_error("safetensors: mismatched bracket");
            }
            --depth;
          }
        }
      } else if (c == '"') {
        readString();
      } else {
        // Bare token — number / true / false / null. Consume until a
        // structural character.
        while (!atEnd() && s[i] != ',' && s[i] != '}' && s[i] != ']' &&
               s[i] != ' ' && s[i] != '\t' && s[i] != '\n' && s[i] != '\r') {
          ++i;
        }
      }
    }
  };

  TensorRecord parseTensorObject_(Pos& p) {
    TensorRecord r;
    p.expect('{');
    p.skipWs();
    while (!p.atEnd() && p.peek() != '}') {
      std::string field = p.readString();
      p.skipWs();
      p.expect(':');
      p.skipWs();
      if (field == "dtype") {
        r.dtype = p.readString();
      } else if (field == "shape") {
        p.expect('[');
        p.skipWs();
        while (!p.atEnd() && p.peek() != ']') {
          r.shape.push_back(p.readInt());
          p.skipWs();
          if (p.peek() == ',') {
            p.consume();
            p.skipWs();
          }
        }
        p.expect(']');
      } else if (field == "data_offsets") {
        p.expect('[');
        p.skipWs();
        int64_t a = p.readInt();
        p.skipWs();
        p.expect(',');
        p.skipWs();
        int64_t b = p.readInt();
        p.skipWs();
        p.expect(']');
        if (a < 0 || b < a) {
          throw std::runtime_error("safetensors: bad data_offsets");
        }
        r.byte_offset = static_cast<uint64_t>(a);
        r.byte_length = static_cast<uint64_t>(b - a);
      } else {
        p.skipValue();
      }
      p.skipWs();
      if (p.peek() == ',') {
        p.consume();
        p.skipWs();
      }
    }
    p.expect('}');
    return r;
  }

  std::unordered_map<std::string, TensorRecord> tensors_;
  std::vector<uint8_t> blob_;
};

} // namespace qvac_vla_safetensors_lite
