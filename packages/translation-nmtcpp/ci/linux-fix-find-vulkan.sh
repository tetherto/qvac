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

  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    if(IS_DIRECTORY "/usr/include/vulkan")
      set(Vulkan_INCLUDE_DIRS "/usr/include/vulkan")
      set(Vulkan_FOUND TRUE)
      message(STATUS "Linux Vulkan_INCLUDE_DIRS=" ${Vulkan_INCLUDE_DIRS})
    else()
      message(WARNING "Vulkan headers not found in /usr/include/vulkan")
    endif()
  endif()
endmacro(find_vulkan)
EOF
