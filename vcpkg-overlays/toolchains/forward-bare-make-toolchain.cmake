include_guard(GLOBAL)

include(ExternalProject)

# cmake-toolchains forwards ${CMAKE_TOOLCHAIN_FILE}. In a vcpkg port that
# variable is vcpkg.cmake, which does not select a compiler, so a nested
# host tool falls through to /usr/bin/cc. Forward the bare-make toolchain
# instead. A caller that passes CMAKE_TOOLCHAIN_FILE itself still wins:
# this is a cache default.
#
# Each argument is passed as a bracket argument, as expanding ARGN would drop
# empty ones, such as the one in CONFIGURE_COMMAND "".
function(ExternalProject_Add name)
  set(args "[==[${name}]==]")

  set(i 1)

  while(i LESS ARGC)
    string(APPEND args " [==[${ARGV${i}}]==]")

    math(EXPR i "${i} + 1")
  endwhile()

  string(APPEND args " CMAKE_CACHE_DEFAULT_ARGS [==[-DCMAKE_TOOLCHAIN_FILE:FILEPATH=${QVAC_BARE_MAKE_TOOLCHAIN_FILE}]==]")

  # Windows port builds run without the user's PATH, so a nested Ninja
  # project cannot find vcpkg's ninja on its own. vcpkg passes the path with
  # backslashes, which the generated initial cache would read as escapes.
  if(CMAKE_GENERATOR MATCHES "Ninja" AND CMAKE_MAKE_PROGRAM)
    file(TO_CMAKE_PATH "${CMAKE_MAKE_PROGRAM}" _qvac_make_program)
    string(APPEND args " [==[-DCMAKE_MAKE_PROGRAM:FILEPATH=${_qvac_make_program}]==]")
  endif()

  cmake_language(EVAL CODE "_ExternalProject_Add(${args})")
endfunction()
