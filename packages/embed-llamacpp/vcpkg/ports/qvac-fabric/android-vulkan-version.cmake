# Function to detect Vulkan version from NDK vulkan_core.h
function(detect_ndk_vulkan_version)
    if(NOT DEFINED ENV{ANDROID_NDK_HOME} OR "$ENV{ANDROID_NDK_HOME}" STREQUAL "")
        message(FATAL_ERROR "ANDROID_NDK_HOME must be set for Android Vulkan header detection")
    endif()

    string(TOLOWER "${CMAKE_HOST_SYSTEM_NAME}" host_system_name_lower)

    # CMAKE_HOST_SYSTEM_PROCESSOR is unavailable here. Use a glob pattern to complete the folder instead.
    file(GLOB host_dirs LIST_DIRECTORIES true "$ENV{ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/${host_system_name_lower}-*")
    if(host_dirs)
        list(GET host_dirs 0 host_dir)
        get_filename_component(host_arch "${host_dir}" NAME)
        set(vulkan_core_h "$ENV{ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/${host_arch}/sysroot/usr/include/vulkan/vulkan_core.h")
    else()
        message(FATAL_ERROR "Could not find NDK host directory for ${host_system_name_lower}")
    endif()

    if(NOT EXISTS "${vulkan_core_h}")
        message(FATAL_ERROR "vulkan_core.h not found at ${vulkan_core_h}")
    endif()

    file(READ "${vulkan_core_h}" header_content)
    string(REGEX MATCH "VK_HEADER_VERSION ([0-9]+)" version_match "${header_content}")
    if(version_match)
        set(header_version_3 "${CMAKE_MATCH_1}")
    else()
        message(FATAL_ERROR "Could not extract VK_HEADER_VERSION from ${vulkan_core_h}")
    endif()

    # Extract major.minor version from VK_HEADER_VERSION_COMPLETE for download URL
    string(REGEX MATCH "VK_HEADER_VERSION_COMPLETE VK_MAKE_API_VERSION\\(([0-9]+), ([0-9]+), ([0-9]+)" version_match "${header_content}")
    if(version_match)
        set(major "${CMAKE_MATCH_2}")
        set(minor "${CMAKE_MATCH_3}")
        set(vulkan_version "${major}.${minor}.${header_version_3}" PARENT_SCOPE)
    else()
        message(FATAL_ERROR "Could not extract Vulkan major.minor version from ${vulkan_core_h}")
    endif()
endfunction()

function(resolve_vulkan_headers_version out_var)
    if(DEFINED QVAC_FABRIC_ANDROID_VULKAN_HEADERS_VERSION)
        set(requested_version "${QVAC_FABRIC_ANDROID_VULKAN_HEADERS_VERSION}")
    elseif(DEFINED ENV{QVAC_FABRIC_ANDROID_VULKAN_HEADERS_VERSION})
        set(requested_version "$ENV{QVAC_FABRIC_ANDROID_VULKAN_HEADERS_VERSION}")
    else()
        set(requested_version "1.3.275")
    endif()

    if(requested_version STREQUAL "AUTO")
        detect_ndk_vulkan_version()
        set(${out_var} "${vulkan_version}" PARENT_SCOPE)
    else()
        set(${out_var} "${requested_version}" PARENT_SCOPE)
    endif()
endfunction()

function(resolve_vulkan_headers_sha512 version out_var)
    if(version STREQUAL "1.3.275")
        set(${out_var}
            "adebfc61501e67367d366a8b17833d064f925ada6480641ef3c128bbda3852087e02d67a09e90b2c188a47494b7e47a87db0d039465858e765e89dc6c2b370d7"
            PARENT_SCOPE)
    else()
        message(FATAL_ERROR
            "Unsupported Android Vulkan-Headers version '${version}'. "
            "Add the matching KhronosGroup/Vulkan-Headers archive SHA512 before building.")
    endif()
endfunction()
