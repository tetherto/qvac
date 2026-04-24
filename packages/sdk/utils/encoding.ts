/**
 * Decodes a base64 string to a Uint8Array.
 *
 * Uses atob which is available across all runtimes (Node, Bare, React Native).
 * Buffer is not globally available in React Native (Hermes engine), so this
 * provides a cross-platform alternative to Buffer.from(str, "base64").
 */
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encodes a Uint8Array to a base64 string.
 *
 * Uses btoa which is available across all runtimes (Node, Bare, React Native).
 * Buffer is not globally available in React Native (Hermes engine), so this
 * provides a cross-platform alternative to Buffer.from(bytes).toString("base64").
 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
