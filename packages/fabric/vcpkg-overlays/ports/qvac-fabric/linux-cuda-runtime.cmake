# nvcc before CUDA 13.4 cannot compile host code against libc++, which QVAC's
# Linux addon uses. A CUDA MODULE must use one runtime throughout, including
# its static GGML core, so it gets a private core built against libstdc++.
# Keep that core private so no C++ objects or symbols cross the C ABI.
# The ggml port carries the same function; the two differ only where the
# forks do.
function(qvac_isolate_cuda_runtime)
    if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux" OR NOT TARGET ggml-cuda)
        return()
    endif()
    get_target_property(cuda_type ggml-cuda TYPE)
    get_target_property(cuda_dir ggml-cuda SOURCE_DIR)
    get_directory_property(cuda_compiler_id DIRECTORY "${cuda_dir}"
        DEFINITION CMAKE_CUDA_COMPILER_ID)
    if(NOT cuda_type STREQUAL "MODULE_LIBRARY" OR
       NOT cuda_compiler_id STREQUAL "NVIDIA")
        return()
    endif()

    get_target_property(base_dir ggml-base SOURCE_DIR)
    get_target_property(base_sources ggml-base SOURCES)
    set(cuda_base_sources)
    foreach(source IN LISTS base_sources)
        get_filename_component(source "${source}" ABSOLUTE BASE_DIR "${base_dir}")
        list(APPEND cuda_base_sources "${source}")
    endforeach()
    get_directory_property(base_definitions DIRECTORY "${base_dir}" COMPILE_DEFINITIONS)

    # Default visibility: the loader looks up the log functions in this core,
    # and a hidden symbol cannot be exported by the version script below.
    add_library(ggml-base-cuda STATIC ${cuda_base_sources})
    set_target_properties(ggml-base-cuda PROPERTIES POSITION_INDEPENDENT_CODE ON)
    target_compile_features(ggml-base-cuda PRIVATE
        $<TARGET_PROPERTY:ggml-base,COMPILE_FEATURES>)
    target_include_directories(ggml-base-cuda PRIVATE
        $<TARGET_PROPERTY:ggml-base,INCLUDE_DIRECTORIES>)
    target_include_directories(ggml-base-cuda INTERFACE
        $<TARGET_PROPERTY:ggml-base,INTERFACE_INCLUDE_DIRECTORIES>)
    target_compile_definitions(ggml-base-cuda PRIVATE
        $<TARGET_PROPERTY:ggml-base,COMPILE_DEFINITIONS>
        ${base_definitions})
    target_compile_definitions(ggml-base-cuda INTERFACE
        $<TARGET_PROPERTY:ggml-base,INTERFACE_COMPILE_DEFINITIONS>)
    target_compile_options(ggml-base-cuda PRIVATE
        $<TARGET_PROPERTY:ggml-base,COMPILE_OPTIONS>)
    target_link_libraries(ggml-base-cuda PRIVATE
        $<TARGET_PROPERTY:ggml-base,LINK_LIBRARIES>)

    get_target_property(cuda_libraries ggml-cuda LINK_LIBRARIES)
    list(TRANSFORM cuda_libraries REPLACE "^ggml-base$" "ggml-base-cuda")
    set_property(TARGET ggml-cuda PROPERTY LINK_LIBRARIES ${cuda_libraries})

    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        # Target options follow the triplet's global -stdlib=libc++ flags.
        target_compile_options(ggml-base-cuda PRIVATE
            $<$<COMPILE_LANGUAGE:CXX>:-stdlib=libstdc++>)
        foreach(target ggml-cuda ggml-cuda-cutlass)
            if(TARGET ${target})
                target_compile_options(${target} PRIVATE
                    $<$<COMPILE_LANGUAGE:CXX>:-stdlib=libstdc++>
                    $<$<COMPILE_LANGUAGE:CUDA>:-Xcompiler=-stdlib=libstdc++>)
            endif()
        endforeach()
        target_link_options(ggml-cuda PRIVATE -stdlib=libstdc++)
    endif()

    # The loader resolves only these entry points (ggml-backend-reg.cpp);
    # backend operations are returned as function pointers. Unlike the ggml
    # fork, this one also forwards its logger to the module.
    set(cuda_exports "${CMAKE_CURRENT_BINARY_DIR}/qvac-cuda-exports.map")
    file(WRITE "${cuda_exports}" "{\n  global: ggml_backend_init; ggml_backend_score;\n    ggml_log_set; ggml_log_get; ggml_log_callback_default;\n  local: *;\n};\n")
    set_property(TARGET ggml-cuda APPEND PROPERTY LINK_DEPENDS "${cuda_exports}")
    # libstdc++'s __cxa_pure_virtual is referenced only weakly, which does not
    # pull it from the archive.
    target_link_options(ggml-cuda PRIVATE
        "LINKER:--version-script=${cuda_exports}"
        -static-libstdc++
        LINKER:--undefined=__cxa_pure_virtual
        LINKER:-z,defs)
endfunction()

# CMAKE_PROJECT_ggml_INCLUDE runs before the targets exist. Configure them at
# the end of the ggml directory, after all GGML target properties are set.
cmake_language(DEFER CALL qvac_isolate_cuda_runtime)
