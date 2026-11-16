import { AsyncDisposeUnavailableError } from '@/errors/index'

/**
 * Defines `Symbol.asyncDispose` and `Symbol.dispose` on an engine that lacks
 * them, such as the JavaScriptCore that Bare runs on iOS. V8 has both.
 *
 * Inference compiles to ES2022, so no engine needs the `using` syntax:
 * TypeScript turns each `await using` into calls to its
 * `__addDisposableResource` and `__disposeResources` helpers. The helpers still
 * read the symbols when they run. They look up the cleanup function under
 * `Symbol.asyncDispose`, then `Symbol.dispose`, and throw
 * `Symbol.asyncDispose is not defined` when the engine has neither. TypeScript
 * lowers syntax but supplies no built-ins, as it supplies no `Promise` either.
 *
 * Only the identity of each symbol matters: a disposable stores its cleanup
 * under the same key the helpers read. `Symbol.for('Symbol.asyncDispose')` is
 * the symbol esbuild's own `using` helpers fall back to, so code compiled by
 * either tool finds the same key. An engine's own symbols are kept.
 *
 * Every module that builds a disposable imports this one, so the symbols exist
 * before the first disposable does.
 */
export function defineDisposeSymbols(symbol: SymbolConstructor = Symbol): void {
  for (const name of ['asyncDispose', 'dispose'] as const) {
    if (typeof symbol[name] === 'symbol') continue
    try {
      Object.defineProperty(symbol, name, { value: Symbol.for(`Symbol.${name}`) })
    } catch (error) {
      throw new AsyncDisposeUnavailableError(error)
    }
  }
}

defineDisposeSymbols()
