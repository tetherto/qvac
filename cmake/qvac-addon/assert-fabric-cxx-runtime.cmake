# Asserts that a built addon module imports its C++ runtime from @qvac/fabric
# and not from whatever C++ runtime the host process happens to load first.
#
# Run as a POST_BUILD step by qvac_addon_finalize, with:
#   READELF  path to readelf (CMAKE_READELF)
#   MODULE   the built .bare module
#   FABRIC   the @qvac/fabric module MODULE links against
#
# This exists because both halves of the failure are silent. -nostdlib++ links
# cleanly whether or not fabric ends up providing the runtime, and a module that
# resolves it elsewhere loads and runs -- it just stops matching typed catches on
# any exception that crossed the seam, which surfaces a package-level "Unknown
# error" a long way from the link that caused it. Checking the built ELF is the
# only place the invariant is directly observable.
#
# Which version node to require, and whether to require one at all, comes out of
# FABRIC itself. Reading it from fabric's package config instead would make the
# check depend on which platform's prebuild leg wrote that config last, since it
# installs to a platform-shared share/ path and the artifact merge keeps one
# copy: a config from a leg whose fabric shares libc++ through a shared library
# turns this assertion off, which is precisely the state it exists to catch.

cmake_minimum_required(VERSION 3.25)

foreach(_required READELF MODULE FABRIC)
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

function(read_dyn_syms path out_lines)
  execute_process(
    COMMAND "${READELF}" --dyn-syms -W "${path}"
    OUTPUT_VARIABLE _syms
    ERROR_VARIABLE _readelf_error
    RESULT_VARIABLE _readelf_status)
  if(NOT _readelf_status EQUAL 0)
    message(FATAL_ERROR
      "assert-fabric-cxx-runtime: readelf failed on ${path}: ${_readelf_error}")
  endif()
  # Semicolons would be read as list separators; symbol lines contain none.
  string(REPLACE ";" "," _syms "${_syms}")
  string(REPLACE "\n" ";" _syms "${_syms}")
  # Keep the numbered symbol entries and drop the table header. Both files read
  # here are dynamic objects that certainly have entries, so parsing none means
  # the output was not understood -- a readelf variant printing another format,
  # or a wrapper on PATH printing something else entirely -- and every question
  # below would answer itself the permissive way: fabric would look like it
  # exports no runtime, and the module like it imports nothing unpinned.
  set(_entries "")
  foreach(_line IN LISTS _syms)
    if(_line MATCHES "^[ \t]*[0-9]+:")
      list(APPEND _entries "${_line}")
    endif()
  endforeach()
  if(NOT _entries)
    message(FATAL_ERROR
      "assert-fabric-cxx-runtime: '${READELF} --dyn-syms' returned no symbol "
      "entries for\n${path}\n"
      "so this check cannot see what that file imports or exports. It is the "
      "only detector for a module that resolved its C++ runtime from the host "
      "process, so it fails rather than pass on an unread file. Point READELF "
      "at binutils readelf or llvm-readelf.")
  endif()
  set(${out_lines} "${_entries}" PARENT_SCOPE)
endfunction()

# Whether fabric is the process' one C++ runtime shows up in its exports: the
# link that embeds libc++ defines the cxxabi entry points, and the ones that
# share a libc++ shared library (Android, the ASan build) import them like any
# other consumer. __cxa_throw stands in for the whole block, which fabric's
# symbols.map splices in as a unit or not at all.
read_dyn_syms("${FABRIC}" _fabric_sym_lines)

set(_fabric_defines_runtime FALSE)
set(_version "")
foreach(_line IN LISTS _fabric_sym_lines)
  if(_line MATCHES "[ \t]UND[ \t]")
    continue()
  endif()
  # Anchored, so __cxa_throw_bad_array_new_length is not mistaken for it.
  if(_line MATCHES "[ \t]__cxa_throw(@@([^ \t@]+))?$")
    set(_fabric_defines_runtime TRUE)
    set(_version "${CMAKE_MATCH_2}")
    break()
  endif()
endforeach()

if(NOT _fabric_defines_runtime)
  # This fabric resolves libc++ from a shared library, which the module resolves
  # it from too, so there is one runtime either way and no node to pin to.
  message(STATUS
    "qvac-addon: ${FABRIC} exports no C++ runtime of its own; "
    "nothing for ${MODULE} to pin to")
  return()
endif()

if(NOT _version)
  message(FATAL_ERROR
    "${FABRIC}\n"
    "exports its C++ runtime with no ELF version node, so ${MODULE} would "
    "resolve that runtime from the host process instead -- silently, at both "
    "build and load time. Update @qvac/fabric to a release that stamps one. A "
    "workspace build that reaches this has usually fallen back to a registry "
    "fabric because the local version no longer satisfies this package's range.")
endif()

read_dyn_syms("${MODULE}" _dyn_sym_lines)

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
set(_pinned "")
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
  if(_symbol MATCHES "@${_version}$")
    list(APPEND _pinned "${_symbol}")
  else()
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
    "imports ${_unpinned_count} C++ runtime symbol(s) with no ${_version} "
    "version requirement, so the dynamic linker is free to satisfy them from "
    "the host process' C++ runtime instead of fabric's. Under bare that host "
    "runtime is GNU libstdc++, and an exception crossing the seam between the "
    "two stops matching typed catches.\n"
    "${FABRIC}\n"
    "exports that runtime under ${_version}, so check that nothing on this "
    "target's link line reintroduces a C++ standard library of its own "
    "(-static-libstdc++, -stdlib=, a bundled libc++.a).\n"
    "  ${_unpinned_report}")
endif()

# Importing none is the other way to fail: a module holding a whole C++ runtime
# of its own asks fabric for nothing, and would pass a check that only looks at
# what it imports.
if(NOT _pinned)
  message(FATAL_ERROR
    "${MODULE}\n"
    "imports no C++ runtime symbol from\n"
    "${FABRIC}\n"
    "so it is not sharing fabric's runtime. Either something on its link line "
    "gave it one of its own (-static-libstdc++, a bundled libc++.a), or it has "
    "no C++ runtime needs at all -- in which case it should not be asking to "
    "import fabric's, and qvac_addon_static_cxx_runtime is what it wants.")
endif()
