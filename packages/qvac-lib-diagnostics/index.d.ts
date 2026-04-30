export type AppInfo = {
    /**
     * - Application name
     */
    name: string;
    /**
     * - Application version
     */
    version: string;
};
export type EnvironmentInfo = {
    /**
     * - Operating system platform
     */
    os: string;
    /**
     * - CPU architecture
     */
    arch: string;
    /**
     * - OS version/release string
     */
    osVersion: string;
    /**
     * - Runtime environment (e.g. 'bare', 'node')
     */
    runtime: string;
};
export type HardwareInfo = {
    /**
     * - CPU model name
     */
    cpuModel: string;
    /**
     * - Number of CPU cores
     */
    cpuCores: number;
    /**
     * - Total system memory in megabytes
     */
    totalMemoryMB: number;
};
export type AddonEntry = {
    /**
     * - Addon name
     */
    name: string;
    /**
     * - Addon version
     */
    version: string;
    /**
     * - Opaque JSON string returned by getDiagnostics callback
     */
    diagnostics: string;
};
export type ExtensionSection = {
    /**
     * - Extension name
     */
    name: string;
    /**
     * - Extension data (any JSON-serializable value)
     */
    data: any;
};
export type DiagnosticReport = {
    /**
     * - Report format version
     */
    reportVersion: string;
    /**
     * - ISO timestamp when report was generated
     */
    generatedAt: string;
    /**
     * - Application information
     */
    app: AppInfo;
    /**
     * - Environment information
     */
    environment: EnvironmentInfo;
    /**
     * - Hardware information
     */
    hardware: HardwareInfo;
    /**
     * - Registered addon diagnostics
     */
    addons: AddonEntry[];
    /**
     * - Registered extension sections
     */
    extensions: ExtensionSection[];
};
/**
 * Version of the diagnostic report format
 * @type {string}
 */
export const REPORT_VERSION: string;
/**
 * Registers an addon that can contribute diagnostics to the report.
 * The getDiagnostics callback will be called at report generation time
 * and must return an opaque JSON string.
 *
 * @param {{ name: string, version: string, getDiagnostics: () => string }} addon
 */
export function registerAddon(addon: {
    name: string;
    version: string;
    getDiagnostics: () => string;
}): void;
/**
 * Unregisters a previously registered addon.
 *
 * @param {string} name - Addon name to remove
 */
export function unregisterAddon(name: string): void;
/**
 * Registers an extension section to be included in the report.
 *
 * @param {string} name - Extension section name
 * @param {*} data - Extension data (any JSON-serializable value)
 */
export function registerExtension(name: string, data: any): void;
/**
 * Collects environment information from the current runtime.
 *
 * @returns {EnvironmentInfo}
 */
export function collectEnvironment(): EnvironmentInfo;
/**
 * Collects hardware information from the current system.
 *
 * @returns {HardwareInfo}
 */
export function collectHardware(): HardwareInfo;
/**
 * Generates a full diagnostic report.
 *
 * @param {{ app: AppInfo }} opts
 * @returns {DiagnosticReport}
 */
export function generateReport(opts: {
    app: AppInfo;
}): DiagnosticReport;
/**
 * Serializes a diagnostic report to a JSON string.
 *
 * @param {DiagnosticReport} report
 * @returns {string}
 */
export function serializeReport(report: DiagnosticReport): string;
/**
 * Resets all singleton state (addon registry and extensions).
 * Primarily useful for testing.
 */
export function reset(): void;
