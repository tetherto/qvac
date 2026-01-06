// Stub for bare-rpc-client.js (not available in React Native)
// This file is used instead of the real bare-rpc-client during bundling

export function getRPC() {
  throw new Error('bare-rpc-client is not available in React Native. Use expo-rpc-client instead.');
}

export default { getRPC };

