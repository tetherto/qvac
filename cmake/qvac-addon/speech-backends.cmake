include_guard(GLOBAL)

function(qvac_speech_backend_targets output)
  set(exports "")
  foreach(backend IN LISTS GGML_AVAILABLE_BACKENDS)
    if(TARGET ggml::${backend})
      get_target_property(kind ggml::${backend} TYPE)
      if(kind STREQUAL "SHARED_LIBRARY" OR kind STREQUAL "MODULE_LIBRARY")
        list(APPEND exports INSTALL TARGET ggml::${backend})
      endif()
    endif()
  endforeach()
  set(${output} "${exports}" PARENT_SCOPE)
endfunction()

function(qvac_speech_backend_files output)
  file(GLOB modules
    "${VCPKG_INSTALLED_PATH}/lib/libqvac-ggml-*.so"
    "${VCPKG_INSTALLED_PATH}/lib/libqvac-ggml-*.so.*"
    "${VCPKG_INSTALLED_PATH}/lib/qvac-ggml-*.dll"
    "${VCPKG_INSTALLED_PATH}/bin/qvac-ggml-*.dll")
  if(GGML_BACKEND_DL AND NOT modules)
    message(FATAL_ERROR "speech backend modules are missing from ${VCPKG_INSTALLED_PATH}")
  endif()
  set(${output} "${modules}" PARENT_SCOPE)
endfunction()

function(qvac_speech_collect_backends exports files)
  set(targets "")
  set(modules "")
  if(NOT APPLE)
    qvac_speech_backend_targets(targets)
    qvac_speech_backend_files(modules)
  endif()
  set(${exports} "${targets}" PARENT_SCOPE)
  set(${files} "${modules}" PARENT_SCOPE)
endfunction()
