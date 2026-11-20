#include <cstdio>
#include <cwchar>
#include <initializer_list>

#include <windows.h>

bool qvac_test_app_local_crt() {
  wchar_t executable[MAX_PATH];
  const DWORD length = GetModuleFileNameW(nullptr, executable, MAX_PATH);
  if (!length || length >= MAX_PATH)
    return false;
  wchar_t* slash = std::wcsrchr(executable, L'\\');
  if (!slash)
    return false;
  *slash = L'\0';
  // Require actual loaded locations, not merely files present in the package:
  // an installed system redistributable must not mask a packaging failure.
  if (!GetModuleHandleW(L"msvcp140.dll") ||
      !GetModuleHandleW(L"vcruntime140.dll"))
    return false;
  for (const auto* name :
       {L"msvcp140.dll",
        L"msvcp140_1.dll",
        L"msvcp140_2.dll",
        L"msvcp140_atomic_wait.dll",
        L"msvcp140_codecvt_ids.dll",
        L"vcruntime140.dll",
        L"vcruntime140_1.dll",
        L"concrt140.dll"}) {
    const HMODULE module = GetModuleHandleW(name);
    if (!module)
      continue;
    wchar_t path[MAX_PATH];
    const DWORD size = GetModuleFileNameW(module, path, MAX_PATH);
    if (!size || size >= MAX_PATH)
      return false;
    std::wprintf(L"%ls loaded from %ls\n", name, path);
    wchar_t* filename = std::wcsrchr(path, L'\\');
    if (!filename)
      return false;
    *filename = L'\0';
    if (_wcsicmp(executable, path) != 0)
      return false;
  }
  return true;
}
