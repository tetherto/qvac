/**
 * Attach metadata to a Promise so the metadata is reachable
 * synchronously while the promise's normal async surface keeps working.
 *
 * The decorated-promise pattern lets a long-running client-API call
 * (`loadModel(...)`, `downloadAsset(...)`) return a value that is both:
 *   - a `Promise<T>` you can `await` for the resolved result; and
 *   - a record carrying call metadata (`requestId`) you can read
 *     synchronously to target the in-flight call with
 *     `cancel({ requestId })` before it resolves.
 *
 * Implementation notes:
 *   - `Object.assign` attaches enumerable own properties without
 *     touching the prototype chain, so `await`, `.then`, `.catch`,
 *     `.finally`, and async-await unwrapping continue to work exactly
 *     as for a plain `Promise<T>`.
 *   - The intersection type `Promise<T> & M` is sound because the
 *     resolved-value type `T` does not intersect with `M`'s key set in
 *     practice (callers pick metadata keys that don't collide with
 *     `Promise` members like `then`/`catch`/`finally`). Picking such a
 *     key would shadow the Promise method and break the unwrap chain;
 *     don't.
 *   - We deliberately avoid extending `Promise.prototype` or calling
 *     `Object.setPrototypeOf`. Either would silently affect every
 *     promise in the worker; the plain-object approach is intentional
 *     and the helper exists to keep call sites consistent.
 *
 * @example
 *   const op = decoratePromise(innerPromise, { requestId: "abc" });
 *   op.requestId; // "abc" (synchronous)
 *   await op;     // resolves to T (legacy contract preserved)
 */
export function decoratePromise<T, M extends Record<string, unknown>>(
  promise: Promise<T>,
  metadata: M,
): Promise<T> & M {
  return Object.assign(promise, metadata);
}
