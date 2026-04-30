declare module "which-runtime" {
  const runtime: "bare" | "node" | "browser" | "unknown";
  const platform: string;
  const arch: string;
  const isBare: boolean;
  const isBareKit: boolean;
  const isPear: boolean;
  const isNode: boolean;
  const isBrowser: boolean;
  const isWindows: boolean;
  const isLinux: boolean;
  const isMac: boolean;
  const isIOS: boolean;
  const isAndroid: boolean;
  const isElectron: boolean;
  const isElectronRenderer: boolean;
  const isElectronWorker: boolean;
}
