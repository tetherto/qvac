// The native addon opens each media path itself, so the prompt goes as is.
// The browser build swaps this module for one that reads the bytes.
export async function resolveMediaContent<T>(prompt: T): Promise<T> {
  return prompt
}
