import { getClientLogger } from "@/logging";

const logger = getClientLogger();

export async function getDeviceInfo(): Promise<{
  platform: "android" | "ios" | undefined;
  deviceModel: string | undefined;
  deviceBrand: string | undefined;
}> {
  try {
    const expoModulesCore = await import("expo-modules-core");
    // this looks odd, but is necessary to ensure that import can be used safely.
    // It will crash the app if the module is not installed, but the node dependency is present.
    const nativeDeviceModule: unknown =
      expoModulesCore.requireOptionalNativeModule("ExpoDevice");
    if (nativeDeviceModule) {
      const Device = await import("expo-device");
      logger.info(
        `Device: ${Device.modelName} ${Device.brand} ${Device.osName}`,
      );
      const osName = Device?.osName?.toLowerCase();
      return {
        platform: osName?.includes("ios")
          ? "ios"
          : osName?.includes("android")
            ? "android"
            : undefined,
        deviceModel: Device.modelName ?? undefined,
        deviceBrand: Device.brand ?? undefined,
      };
    }
  } catch {
    logger.debug("expo-device not available, device info will be omitted");
  }
  return {
    platform: undefined,
    deviceModel: undefined,
    deviceBrand: undefined,
  };
}
