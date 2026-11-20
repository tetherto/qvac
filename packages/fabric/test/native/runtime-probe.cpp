#include <exception>
#include <stdexcept>
#include <vector>

#include <uint8-buff-stream.h>

#ifdef _WIN32
#define QVAC_RUNTIME_EXPORT __declspec(dllexport)
#else
#define QVAC_RUNTIME_EXPORT __attribute__((visibility("default")))
#endif

// /EHsc assumes extern "C" functions do not throw unless explicitly declared.
extern "C" QVAC_RUNTIME_EXPORT void qvac_runtime_throw() noexcept(false) {
  throw std::invalid_argument("qvac-shared-core-runtime");
}

extern "C" QVAC_RUNTIME_EXPORT void
qvac_runtime_exception(std::exception_ptr* result) {
  try {
    qvac_runtime_throw();
  } catch (...) {
    *result = std::current_exception();
  }
}

extern "C" QVAC_RUNTIME_EXPORT std::basic_streambuf<char>*
qvac_runtime_stream() {
  return new Uint8BufferStreamBuf(std::vector<uint8_t>(4096, 42));
}
