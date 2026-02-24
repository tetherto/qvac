# Function to detect Vulkan version from NDK vulkan_core.h
function(detect_ndk_vulkan_version)
    string(TOLOWER "${CMAKE_HOST_SYSTEM_NAME}" host_system_name_lower)

    # CMAKE_HOST_SYSTEM_PROCESSOR is unavailable here. Use a glob pattern to complete the folder instead. 
    file(GLOB host_dirs LIST_DIRECTORIES true "$ENV{ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/${host_system_name_lower}-*")
    if(host_dirs)
        list(GET host_dirs 0 host_dir)
        get_filename_component(host_arch "${host_dir}" NAME)
        set(vulkan_core_h "$ENV{ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/${host_arch}/sysroot/usr/include/vulkan/vulkan_core.h")
    else()
        message(FATAL "Could not find NDK host directory for ${host_system_name_lower}")
    endif()

    if(NOT vulkan_core_h)
        message(FATAL "vulkan_core.h not found, using default version")
    endif()

    file(READ "${vulkan_core_h}" header_content)
    string(REGEX MATCH "VK_HEADER_VERSION ([0-9]+)" version_match "${header_content}")
    if(version_match)
        set(header_version_3 "${CMAKE_MATCH_1}")
    else()
        message(FATAL "Could not extract VK_HEADER_VERSION from vulkan_core.h, using default: ${vulkan_version}")
    endif()

     # Extract major.minor version from VK_HEADER_VERSION_COMPLETE for download URL
    string(REGEX MATCH "VK_HEADER_VERSION_COMPLETE VK_MAKE_API_VERSION\\(([0-9]+), ([0-9]+), ([0-9]+)" version_match "${header_content}")
    if(version_match)
        set(major "${CMAKE_MATCH_2}")
        set(minor "${CMAKE_MATCH_3}")
        set(vulkan_version "${major}.${minor}.${header_version_3}" PARENT_SCOPE)
    else()
        message(FATAL "Could not extract major.minor version from vulkan_core.h, using default: ${vulkan_version}")
    endif()
endfunction()