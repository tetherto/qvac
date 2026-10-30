# setup-cuda explicitly opts Linux CI builds into CUDA. Automatic PR jobs
# read build metadata from main, so they may not yet pass -D SD_CUDA=ON.
# Keep ordinary source builds and test/fuzz builds toolkit-independent.
set(_sd_cuda_default OFF)
if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Linux" AND
   NOT "$ENV{QVAC_CUDA_TOOLKIT}" STREQUAL "" AND
   NOT BUILD_TESTING AND NOT BUILD_FUZZING)
  set(_sd_cuda_default ON)
endif()
option(SD_CUDA "Enable CUDA GPU backend" ${_sd_cuda_default})
unset(_sd_cuda_default)
if(SD_CUDA)
  list(APPEND VCPKG_MANIFEST_FEATURES "cuda")
endif()
