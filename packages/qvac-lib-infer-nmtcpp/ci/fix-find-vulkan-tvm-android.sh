#!/bin/bash

set -e

cat << EOF > addon/vendor/tetherto/mlc-llm/3rdparty/tvm/cmake/utils/FindVulkan.cmake
macro(find_vulkan use_vulkan use_khronos_spirv)
  set(__use_vulkan ${use_vulkan})
  if(IS_DIRECTORY ${__use_vulkan})
    set(__vulkan_sdk ${__use_vulkan})
    message(STATUS "Custom Vulkan SDK PATH=" ${__use_vulkan})
  elseif(IS_DIRECTORY $ENV{VULKAN_SDK})
    set(__vulkan_sdk $ENV{VULKAN_SDK})
  else()
    set(__vulkan_sdk "")
  endif()


  if(IS_DIRECTORY ${use_khronos_spirv})
    set(__use_khronos_spirv ${use_khronos_spirv})
    message(STATUS "Custom khronos spirv PATH=" ${__use_khronos_spirv})
  else()
    set(__use_khronos_spirv "")
  endif()

  if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    set(VULKAN_NDK_SRC ${CMAKE_ANDROID_NDK}/sources/third_party/vulkan/src)
    set(Vulkan_INCLUDE_DIRS ${VULKAN_NDK_SRC}/include)
    set(Vulkan_FOUND TRUE)
    message(STATUS "Android Vulkan_INCLUDE_DIRS=" ${Vulkan_INCLUDE_DIRS})
    message(STATUS "Skip finding SPIRV in Android, make sure you only build tvm runtime.")
  endif()
endmacro(find_vulkan)   
EOF
