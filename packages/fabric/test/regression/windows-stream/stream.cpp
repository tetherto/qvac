#include <cstdio>
#include <cstring>
#include <vector>

#include <uint8-buff-stream.h>
extern "C" __declspec(dllimport) void qvac_test_core_crt_failures();
int main(int argc, char** argv) {
  qvac_test_core_crt_failures();
  if (argc > 1 && std::strcmp(argv[1], "control") == 0)
    return 0;
  {
    std::vector<uint8_t> bytes(4096, 42);
    Uint8BufferStreamBuf stream(std::move(bytes));
    std::basic_streambuf<char>* base = &stream;
    if (dynamic_cast<Uint8BufferStreamBuf*>(base) != &stream ||
        stream.sgetc() != 42)
      return 2;
    std::puts("stream construction and RTTI passed");
    std::fflush(stdout);
  }
  std::puts("stream scope destroyed; checking DLL teardown");
  return 0;
}
