# Asserts that a built addon module imports its C++ runtime from @qvac/fabric
# and not from whatever C++ runtime the host process happens to load first.
#
# Run as a POST_BUILD step by qvac_addon_finalize, with:
#   READELF  path to readelf (CMAKE_READELF)
#   MODULE   the built .bare module
#   VERSION  fabric's ELF version node (QVAC_FABRIC_ABI_VERSION)
#
# This exists because both halves of the failure are silent. -nostdlib++ links
# cleanly whether or not fabric ends up providing the runtime, and a module that
# resolves it elsewhere loads and runs -- it just stops matching typed catches on
# any exception that crossed the seam, which surfaces a package-level "Unknown
# error" a long way from the link that caused it. Checking the built ELF is the
# only place the invariant is directly observable.

cmake_minimum_required(VERSION 3.25)

foreach(_required READELF MODULE VERSION)
  if(NOT ${_required})
    message(FATAL_ERROR "assert-fabric-cxx-runtime: ${_required} is required")
  endif()
endforeach()

if(NOT EXISTS "${READELF}")
  message(FATAL_ERROR
    "assert-fabric-cxx-runtime: no readelf at '${READELF}'. It verifies that "
    "${MODULE} imports fabric's C++ runtime; install binutils or llvm rather "
    "than skipping the check.")
endif()

execute_process(
  COMMAND "${READELF}" --dyn-syms -W "${MODULE}"
  OUTPUT_VARIABLE _dyn_syms
  ERROR_VARIABLE _readelf_error
  RESULT_VARIABLE _readelf_status)
if(NOT _readelf_status EQUAL 0)
  message(FATAL_ERROR
    "assert-fabric-cxx-runtime: readelf failed on ${MODULE}: ${_readelf_error}")
endif()

# Semicolons would be read as list separators; symbol lines contain none.
string(REPLACE ";" "," _dyn_syms "${_dyn_syms}")
string(REPLACE "\n" ";" _dyn_sym_lines "${_dyn_syms}")

# The C++ runtime surface fabric exports, by mangled prefix: cxxabi entry points,
# the personality routine, typeinfo / typeinfo names / vtables, the operator
# new/delete family, and the standard library itself. Mirrors
# packages/fabric/symbols-linux-cxx-runtime.map.
set(_cxx_runtime_prefixes
  "__cxa_" "__gxx_personality" "__dynamic_cast"
  "_ZT" "_Znw" "_Zna" "_Zdl" "_Zda"
  "_ZN[KVR]?St" "_ZSt" "_ZGVNSt")
string(JOIN "|" _cxx_runtime_regex ${_cxx_runtime_prefixes})

set(_unpinned "")
foreach(_line IN LISTS _dyn_sym_lines)
  if(NOT _line MATCHES "UND[ \t]+([^ \t]+)")
    continue()
  endif()
  set(_symbol "${CMAKE_MATCH_1}")
  # glibc owns the two __cxa_ entries that static initialisation and finalisation
  # go through, and libgcc_s owns the unwinder that both libc++abi and libstdc++
  # call into. Neither is fabric's to provide.
  if(_symbol MATCHES "^(__cxa_atexit|__cxa_finalize|_Unwind_)")
    continue()
  endif()
  if(NOT _symbol MATCHES "^(${_cxx_runtime_regex})")
    continue()
  endif()
  if(NOT _symbol MATCHES "@${VERSION}$")
    list(APPEND _unpinned "${_symbol}")
  endif()
endforeach()

if(_unpinned)
  list(REMOVE_DUPLICATES _unpinned)
  list(SORT _unpinned)
  list(LENGTH _unpinned _unpinned_count)
  # A module that missed the version node misses it for every symbol at once, so
  # a sample identifies the problem as well as hundreds of lines would.
  set(_sample_size 10)
  if(_unpinned_count GREATER _sample_size)
    list(SUBLIST _unpinned 0 ${_sample_size} _unpinned_sample)
    math(EXPR _remaining "${_unpinned_count} - ${_sample_size}")
    list(APPEND _unpinned_sample "... and ${_remaining} more")
  else()
    set(_unpinned_sample "${_unpinned}")
  endif()
  string(REPLACE ";" "\n  " _unpinned_report "${_unpinned_sample}")
  message(FATAL_ERROR
    "${MODULE}\n"
    "imports ${_unpinned_count} C++ runtime symbol(s) with no ${VERSION} "
    "version requirement, so the dynamic linker is free to satisfy them from "
    "the host process' C++ runtime instead of fabric's. Under bare that host "
    "runtime is GNU libstdc++, and an exception crossing the seam between the "
    "two stops matching typed catches.\n"
    "Rebuild against a fabric whose symbols.map stamps the ${VERSION} node, and "
    "check that nothing on this target's link line reintroduces a C++ standard "
    "library (-static-libstdc++, -stdlib=, a bundled libc++.a).\n"
    "  ${_unpinned_report}")
endif()
