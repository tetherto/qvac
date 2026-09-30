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

  cmake_language(EVAL CODE "_ExternalProject_Add(${args})")
endfunction()
