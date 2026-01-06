// Stub for node-rpc-client.js (not available in React Native)
// This file is used instead of the real node-rpc-client during bundling

export function getRPC() {
  throw new Error('node-rpc-client is not available in React Native. Use expo-rpc-client instead.');
}

export default { getRPC };

