# Fails when a Linux module links a shared C++ runtime or leaves C++ runtime
# symbols for the loading process to provide. The modules link libc++
# statically and are dlopen'd by hosts that need not map any C++ runtime
# (bare-sidecar maps none), so either defect makes the module load only in
# some processes, and the addon then falls back to CPU without an error.
#
# Allowed undefined: __cxa_atexit, __cxa_finalize, __cxa_thread_atexit_impl
# (glibc) and _Unwind_* (libgcc_s).
#
# WITH_XDNA permits only the XDNA module to use the system XRT/libstdc++ ABI.
# Script mode accepts the same opt-in through QVAC_CHECK_XDNA=ON.
#
# Script mode, for checking prebuilt modules:
#   cmake -DQVAC_CHECK_FILES="a.so;b.so" -P qvac-check-cxx-runtime.cmake

set(_QVAC_CXX_RUNTIME_NEEDED "^lib(stdc\\+\\+|c\\+\\+|c\\+\\+abi)\\.so")
set(_QVAC_CXX_RUNTIME_SYMBOLS
  # std:: names, both libstdc++'s and libc++'s inline std::__1, and the std
  # abbreviations (std::allocator, basic_string, string, istream, ostream, iostream)
  "^_ZN?K?St"
  "^_ZNK?S[abiosd]"
  # typeinfo, vtables and typeinfo names of std and cxxabi types
  "^_ZT[IVS]N?K?S[tabiosd]"
  "^_ZT[IVS]N10__cxxabiv1"
  # operator new and delete
  "^_Zn[wa]"
  "^_Zd[la]"
  "^__cxa_"
  "^__gxx_personality_"
  "^__dynamic_cast$")
set(_QVAC_CXX_RUNTIME_ALLOWED "^__cxa_(atexit|finalize|thread_atexit_impl)$")

function(qvac_check_cxx_runtime)
  cmake_parse_arguments(PARSE_ARGV 0 arg "WITH_XDNA" "" "")
  set(_modules ${arg_UNPARSED_ARGUMENTS})
  set(_xdna_found OFF)
  list(REMOVE_ITEM _modules "")
  list(LENGTH _modules _module_count)
  if(_module_count EQUAL 0)
    message(FATAL_ERROR "qvac-fabric: no modules to check for a C++ runtime dependency")
  endif()
  find_program(QVAC_NM NAMES llvm-nm nm REQUIRED)
  find_program(QVAC_READELF NAMES llvm-readelf readelf REQUIRED)
  set(_failures)
  foreach(_module IN LISTS _modules)
    execute_process(
      COMMAND "${QVAC_READELF}" -d "${_module}"
      OUTPUT_VARIABLE _dynamic
      COMMAND_ERROR_IS_FATAL ANY)
    string(REGEX MATCHALL "\\(NEEDED\\)[^\n]*\\[[^]\n]+\\]" _needed_lines "${_dynamic}")
    get_filename_component(_module_name "${_module}" NAME)
    set(_xdna OFF)
    if(arg_WITH_XDNA AND _module_name STREQUAL "libqvac-ggml-xdna.so")
      set(_xdna ON)
      set(_xdna_found ON)
    endif()
    set(_needed)
    set(_bad_needed)
    foreach(_line IN LISTS _needed_lines)
      string(REGEX REPLACE ".*\\[([^]]+)\\]$" "\\1" _lib "${_line}")
      list(APPEND _needed "${_lib}")
      if(_lib MATCHES "${_QVAC_CXX_RUNTIME_NEEDED}" AND
         NOT (_xdna AND _lib STREQUAL "libstdc++.so.6"))
        list(APPEND _bad_needed "${_lib}")
      endif()
    endforeach()

    if(_xdna)
      foreach(_required libstdc++.so.6 libxrt_coreutil.so.2)
        list(FIND _needed "${_required}" _required_index)
        if(_required_index EQUAL -1)
          list(APPEND _bad_needed "missing ${_required}")
        endif()
      endforeach()
    endif()

    execute_process(
      COMMAND "${QVAC_NM}" -D --undefined-only -P "${_module}"
      OUTPUT_VARIABLE _undefined
      COMMAND_ERROR_IS_FATAL ANY)
    string(REPLACE "\n" ";" _undefined "${_undefined}")
    set(_bad_symbols)
    foreach(_line IN LISTS _undefined)
      string(REGEX REPLACE "[@ ].*" "" _symbol "${_line}")
      if(_symbol STREQUAL "" OR _symbol MATCHES "${_QVAC_CXX_RUNTIME_ALLOWED}")
        continue()
      endif()
      if(_xdna)
        if(_symbol MATCHES "^(ggml|gguf)_" OR _symbol MATCHES "_ZNK?St3__1")
          list(APPEND _bad_symbols "${_symbol}")
        endif()
        continue()
      endif()
      foreach(_pattern IN LISTS _QVAC_CXX_RUNTIME_SYMBOLS)
        if(_symbol MATCHES "${_pattern}")
          list(APPEND _bad_symbols "${_symbol}")
          break()
        endif()
      endforeach()
    endforeach()

    if(_bad_needed OR _bad_symbols)
      string(APPEND _failures "\n  ${_module}")
    endif()
    if(_bad_needed)
      list(JOIN _bad_needed ", " _bad_needed)
      string(APPEND _failures "\n   NEEDED: ${_bad_needed}")
    endif()
    if(_bad_symbols)
      list(LENGTH _bad_symbols _count)
      list(SUBLIST _bad_symbols 0 10 _shown)
      list(JOIN _shown "\n    " _shown)
      string(APPEND _failures "\n   ${_count} undefined C++ runtime symbols, first:\n    ${_shown}")
    endif()
  endforeach()
  if(arg_WITH_XDNA AND NOT _xdna_found)
    message(FATAL_ERROR "qvac-fabric: requested XDNA module is missing")
  endif()
  if(_failures)
    message(FATAL_ERROR "qvac-fabric: modules depend on a C++ runtime the loading process may not have:${_failures}")
  endif()
  message(STATUS "qvac-fabric: ${_module_count} modules passed C++ runtime validation (XDNA system ABI: ${_xdna_found})")
endfunction()

if(CMAKE_SCRIPT_MODE_FILE STREQUAL CMAKE_CURRENT_LIST_FILE)
  set(_options)
  if(QVAC_CHECK_XDNA)
    list(APPEND _options WITH_XDNA)
  endif()
  qvac_check_cxx_runtime(${_options} ${QVAC_CHECK_FILES})
endif()
