#include <cstdio>
#include <cstdlib>

#include <crtdbg.h>
#include <windows.h>
static int report(int kind, char* text, int* result) {
  if (kind != _CRT_ASSERT)
    return FALSE;
  std::fprintf(stderr, "CORE CRT ASSERT: %s\n", text);
  std::fflush(stderr);
  TerminateProcess(GetCurrentProcess(), 86);
  *result = 0;
  return TRUE;
}
extern "C" __declspec(dllexport) void qvac_test_core_crt_failures() {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
  _CrtSetReportHook(report);
}
