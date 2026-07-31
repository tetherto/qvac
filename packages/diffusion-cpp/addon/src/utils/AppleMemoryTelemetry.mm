#include "AppleMemoryTelemetry.hpp"

#include <mach/mach.h>
#include <malloc/malloc.h>
#include <os/proc.h>

#import <Metal/Metal.h>
#import <TargetConditionals.h>

#include <sstream>

namespace qvac_lib_inference_addon_sd::apple_memory {

Snapshot capture() noexcept {
  Snapshot snapshot;

  task_vm_info_data_t vmInfo{};
  mach_msg_type_number_t vmInfoCount = TASK_VM_INFO_COUNT;
  if (task_info(
          mach_task_self(), TASK_VM_INFO,
          reinterpret_cast<task_info_t>(&vmInfo), &vmInfoCount) == KERN_SUCCESS) {
    snapshot.available = true;
    snapshot.physicalFootprintBytes = vmInfo.phys_footprint;
  }

  mach_task_basic_info_data_t basicInfo{};
  mach_msg_type_number_t basicInfoCount = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(
          mach_task_self(), MACH_TASK_BASIC_INFO,
          reinterpret_cast<task_info_t>(&basicInfo),
          &basicInfoCount) == KERN_SUCCESS) {
    snapshot.available = true;
    snapshot.residentBytes = basicInfo.resident_size;
  }

#if TARGET_OS_IOS
  snapshot.availableMemoryBytes = os_proc_available_memory();
#endif

  @autoreleasepool {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (device != nil) {
      snapshot.available = true;
      if ([device respondsToSelector:@selector(currentAllocatedSize)]) {
        snapshot.metalAllocatedBytes = device.currentAllocatedSize;
      }
      if (@available(iOS 13.0, macOS 10.15, *)) {
        snapshot.metalRecommendedWorkingSetBytes =
            device.recommendedMaxWorkingSetSize;
      }
#if !__has_feature(objc_arc)
      [device release];
#endif
    }
  }

  return snapshot;
}

std::size_t requestPressureRelief() noexcept {
  return malloc_zone_pressure_relief(nullptr, 0);
}

std::string describe(const std::string& stage, const Snapshot& snapshot) {
  std::ostringstream oss;
  oss << "iOS memory telemetry [" << stage << "]"
      << " phys_footprint_bytes=" << snapshot.physicalFootprintBytes
      << " resident_bytes=" << snapshot.residentBytes
      << " metal_allocated_bytes=" << snapshot.metalAllocatedBytes
      << " metal_recommended_working_set_bytes="
      << snapshot.metalRecommendedWorkingSetBytes
      << " os_available_memory_bytes=" << snapshot.availableMemoryBytes;
  return oss.str();
}

} // namespace qvac_lib_inference_addon_sd::apple_memory
