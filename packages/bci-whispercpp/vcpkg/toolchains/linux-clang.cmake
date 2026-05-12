# Prefer the highest LLVM major actually installed under /usr/lib/llvm-N/bin so
# the chosen `clang` / `clang++` match the libc++ headers shipped by the same
# package set. Some CI workflows install LLVM via apt.llvm.org's `llvm.sh`
# without prepending the versioned bin dir to PATH, which leaves unversioned
# `clang` pointing at the runner image default (clang-14 on ubuntu-22.04) while
# `/usr/include/c++/v1` is replaced by `libc++-N-dev`. That mismatch makes
# ggml's `<math.h>`/`<type_traits>` includes fail to compile against the newer
# libc++ headers. Auto-detecting the installed major here makes the toolchain
# robust to that workflow shape without forcing every workflow through
# `update-alternatives`. Falls back to unversioned `clang`/`clang++` when no
# versioned bin dir is present (e.g. local macOS dev or runners that already
# expose the desired major via PATH).
set(_qvac_clang_root "")
foreach(_qvac_clang_major 22 21 20 19)
  if(EXISTS "/usr/lib/llvm-${_qvac_clang_major}/bin/clang++")
    set(_qvac_clang_root "/usr/lib/llvm-${_qvac_clang_major}/bin")
    break()
  endif()
endforeach()

if(_qvac_clang_root)
  set(CMAKE_C_COMPILER "${_qvac_clang_root}/clang")
  set(CMAKE_CXX_COMPILER "${_qvac_clang_root}/clang++")
else()
  set(CMAKE_C_COMPILER "clang")
  set(CMAKE_CXX_COMPILER "clang++")
endif()

unset(_qvac_clang_root)
unset(_qvac_clang_major)

include("$ENV{VCPKG_ROOT}/scripts/toolchains/linux.cmake")
