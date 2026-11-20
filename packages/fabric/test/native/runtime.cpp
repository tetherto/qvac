#include <exception>
#include <stdexcept>
#include <string>

#include <uint8-buff-stream.h>

extern "C" void qvac_runtime_throw();
extern "C" void qvac_runtime_exception(std::exception_ptr* result);
extern "C" std::basic_streambuf<char>* qvac_runtime_stream();

int main() {
  try {
    qvac_runtime_throw();
    return 1;
  } catch (const std::invalid_argument& error) {
    if (std::string(error.what()) != "qvac-shared-core-runtime")
      return 2;
  }
  std::exception_ptr error;
  qvac_runtime_exception(&error);
  if (!error)
    return 3;
  try {
    std::rethrow_exception(error);
    return 4;
  } catch (const std::invalid_argument&) {
  }
  auto* stream = qvac_runtime_stream();
  auto* typed = dynamic_cast<Uint8BufferStreamBuf*>(stream);
  const bool valid = typed && typed->data_ptr()[4095] == 42;
  delete stream;
  return valid ? 0 : 5;
}
