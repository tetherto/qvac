#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdio.h>

int main(void) {
  mach_port_t service = MACH_PORT_NULL;
  kern_return_t result = bootstrap_look_up(
    bootstrap_port,
    "com.apple.system.opendirectoryd.libinfo",
    &service
  );
  if (service != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), service);
  printf("%d\n", result);
  return 0;
}
