/**
 * Runtime detection utilities
 * Detects the current JavaScript runtime environment
 */

export type Runtime = "node" | "bare" | "expo" | "unknown";

/**
 * Check if running in Bare runtime
 */
export const isBare = (): boolean => {
  return typeof globalThis !== "undefined" && "Bare" in globalThis;
};

/**
 * Check if running in React Native/Expo
 */
export const isReactNative = (): boolean => {
  return (
    typeof navigator !== "undefined" &&
    (navigator as { product?: string }).product === "ReactNative"
  );
};

/**
 * Check if running in Node.js
 */
export const isNode = (): boolean => {
  return (
    typeof process !== "undefined" &&
    process.versions !== undefined &&
    process.versions.node !== undefined
  );
};

/**
 * Detects the current runtime environment
 *
 * Detection order:
 * 1. Bare - Check for global Bare object
 * 2. React Native/Expo - Check navigator.product
 * 3. Node.js - Check process.versions.node
 * 4. Unknown - Fallback
 *
 * @returns The detected runtime type
 */
export const detectRuntime = (): Runtime => {
  if (isBare()) {
    return "bare";
  }

  if (isReactNative()) {
    return "expo";
  }

  if (isNode()) {
    return "node";
  }

  return "unknown";
};
