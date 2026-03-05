import type { RuntimeContext } from "@/schemas";

// ============================================
// Runtime context state
// ============================================

let context: RuntimeContext = {};
let isSet = false;

export function setRuntimeContext(ctx: RuntimeContext) {
  if (isSet) return;
  context = ctx;
  isSet = true;
}

export function getRuntimeContext(): RuntimeContext {
  return context;
}

// ============================================
// Convenience helpers
// ============================================

export function isMobile(): boolean {
  return context.runtime === "react-native";
}

export function isAndroid(): boolean {
  return context.platform === "android";
}

export function isIOS(): boolean {
  return context.platform === "ios";
}
