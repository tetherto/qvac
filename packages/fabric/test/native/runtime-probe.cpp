#include <exception>
#include <stdexcept>
#include <vector>

#include <uint8-buff-stream.h>

extern "C" __attribute__((visibility("default"))) void qvac_runtime_throw() {
  throw std::invalid_argument("qvac-shared-core-runtime");
}

extern "C" __attribute__((visibility("default"))) void
qvac_runtime_exception(std::exception_ptr* result) {
  try {
    qvac_runtime_throw();
  } catch (...) {
    *result = std::current_exception();
  }
}

extern "C" __attribute__((visibility("default"))) std::basic_streambuf<char>*
qvac_runtime_stream() {
  return new Uint8BufferStreamBuf(std::vector<uint8_t>(4096, 42));
}
