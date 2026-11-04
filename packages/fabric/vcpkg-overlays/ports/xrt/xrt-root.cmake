# Resolved where it is used, not where the port was built: a binary-cache
# restore on another host must find that host's XRT.
if(NOT "$ENV{XILINX_XRT}" STREQUAL "")
  file(TO_CMAKE_PATH "$ENV{XILINX_XRT}" XRT_ROOT)
else()
  set(XRT_ROOT "/opt/xilinx/xrt")
endif()
