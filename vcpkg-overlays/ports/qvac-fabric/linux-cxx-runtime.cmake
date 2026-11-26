# CUDA and XDNA share a GGML core compiled against libstdc++. Runtime
# linkage stays on each module: static for CUDA, shared to match XRT for XDNA.
function(qvac_configure_cxx_runtimes)
    if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
        return()
    endif()
    set(cuda_module OFF)
    if(TARGET ggml-cuda)
        get_target_property(cuda_type ggml-cuda TYPE)
        get_target_property(cuda_dir ggml-cuda SOURCE_DIR)
        get_directory_property(cuda_compiler_id DIRECTORY "${cuda_dir}"
            DEFINITION CMAKE_CUDA_COMPILER_ID)
        if(cuda_type STREQUAL "MODULE_LIBRARY" AND cuda_compiler_id STREQUAL "NVIDIA")
            set(cuda_module ON)
        endif()
    endif()
    set(xdna_module OFF)
    if(TARGET ggml-xdna)
        get_target_property(xdna_type ggml-xdna TYPE)
        if(xdna_type STREQUAL "MODULE_LIBRARY")
            set(xdna_module ON)
        endif()
    endif()
    if(NOT cuda_module AND NOT xdna_module)
        return()
    endif()

    get_target_property(base_dir ggml-base SOURCE_DIR)
    get_target_property(base_sources ggml-base SOURCES)
    set(stdcxx_base_sources)
    foreach(source IN LISTS base_sources)
        get_filename_component(source "${source}" ABSOLUTE BASE_DIR "${base_dir}")
        list(APPEND stdcxx_base_sources "${source}")
    endforeach()
    get_directory_property(base_definitions DIRECTORY "${base_dir}" COMPILE_DEFINITIONS)

    # Default visibility: the loader looks up the log functions in this core,
    # and a hidden symbol cannot be exported by the version script below.
    add_library(ggml-base-libstdcxx STATIC ${stdcxx_base_sources})
    set_target_properties(ggml-base-libstdcxx PROPERTIES POSITION_INDEPENDENT_CODE ON)
    target_compile_features(ggml-base-libstdcxx PRIVATE
        $<TARGET_PROPERTY:ggml-base,COMPILE_FEATURES>)
    target_include_directories(ggml-base-libstdcxx PRIVATE
        $<TARGET_PROPERTY:ggml-base,INCLUDE_DIRECTORIES>)
    target_include_directories(ggml-base-libstdcxx INTERFACE
        $<TARGET_PROPERTY:ggml-base,INTERFACE_INCLUDE_DIRECTORIES>)
    target_compile_definitions(ggml-base-libstdcxx PRIVATE
        $<TARGET_PROPERTY:ggml-base,COMPILE_DEFINITIONS>
        ${base_definitions})
    target_compile_definitions(ggml-base-libstdcxx INTERFACE
        $<TARGET_PROPERTY:ggml-base,INTERFACE_COMPILE_DEFINITIONS>)
    target_compile_options(ggml-base-libstdcxx PRIVATE
        $<TARGET_PROPERTY:ggml-base,COMPILE_OPTIONS>)
    target_link_libraries(ggml-base-libstdcxx PRIVATE
        $<TARGET_PROPERTY:ggml-base,LINK_LIBRARIES>)

    set(stdcxx_targets ggml-base-libstdcxx)
    if(cuda_module)
        list(APPEND stdcxx_targets ggml-cuda)
        if(TARGET ggml-cuda-cutlass)
            list(APPEND stdcxx_targets ggml-cuda-cutlass)
        endif()
    endif()
    if(xdna_module)
        list(APPEND stdcxx_targets ggml-xdna ggml-cpu-xdna)
    endif()
    foreach(target IN LISTS stdcxx_targets)
        foreach(property LINK_LIBRARIES INTERFACE_LINK_LIBRARIES)
            get_target_property(libraries ${target} ${property})
            if(libraries)
                list(TRANSFORM libraries REPLACE "^ggml-base$" "ggml-base-libstdcxx")
                list(TRANSFORM libraries REPLACE "^\\$<LINK_ONLY:ggml-base>$" "$<LINK_ONLY:ggml-base-libstdcxx>")
                set_property(TARGET ${target} PROPERTY ${property} ${libraries})
            endif()
        endforeach()
        if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
            target_compile_options(${target} PRIVATE
                $<$<COMPILE_LANGUAGE:CXX>:-stdlib=libstdc++>
                $<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler=-stdlib=libstdc++>)
        endif()
    endforeach()
    set(modules)
    if(cuda_module)
        list(APPEND modules ggml-cuda)
    endif()
    if(xdna_module)
        list(APPEND modules ggml-xdna)
    endif()
    foreach(target IN LISTS modules)
        if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
            target_link_options(${target} PRIVATE -stdlib=libstdc++)
        endif()
        # Keep each module's core private; only the backend and logger entry
        # points cross the C ABI into the loading process.
        set(exports "${CMAKE_CURRENT_BINARY_DIR}/${target}-exports.map")
        file(WRITE "${exports}" "{\n  global: ggml_backend_init; ggml_backend_score;\n    ggml_log_set; ggml_log_get; ggml_log_callback_default;\n  local: *;\n};\n")
        set_property(TARGET ${target} APPEND PROPERTY LINK_DEPENDS "${exports}")
        target_link_options(${target} PRIVATE
            "LINKER:--version-script=${exports}" LINKER:-z,defs)
    endforeach()
    if(cuda_module)
        # The weak pure-virtual reference does not pull this from the archive.
        target_link_options(ggml-cuda PRIVATE
            -static-libstdc++ LINKER:--undefined=__cxa_pure_virtual
            LINKER:--as-needed)
        # CMake may append an implicit shared -lstdc++ for CUDA. Resolve the
        # runtime from its archive first, then discard the unused shared copy.
        target_link_libraries(ggml-cuda PRIVATE
            "-Wl,-Bstatic" stdc++ "-Wl,-Bdynamic")
    endif()
    if(xdna_module)
        # XRT exchanges C++ objects with this module and needs shared libstdc++.
        # Suppress the driver's implicit runtime, including the triplet's static
        # runtime option, and link the shared library explicitly.
        if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
            target_link_options(ggml-xdna PRIVATE -nostdlib++)
        endif()
        target_link_libraries(ggml-xdna PRIVATE stdc++)
        set_target_properties(ggml-xdna PROPERTIES INSTALL_RPATH "${QVAC_XRT_ROOT}/lib")
    endif()
endfunction()

# Run after GGML has created and configured all backend targets.
cmake_language(DEFER CALL qvac_configure_cxx_runtimes)
