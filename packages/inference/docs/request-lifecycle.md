# Request lifecycle

Long-running inference operations use the request context, request registry, and
disposable scope under `src/runtime/`. Built-in handlers declare their cancellation
capability through the plugin contract.

## Handler contract

1. Create or receive a request identifier and begin one registry context.
2. Register cleanup immediately after acquiring each resource.
3. Pass the context signal to operations that support request-scoped cancellation.
4. Check cancellation at boundaries where an underlying addon cannot consume the
   signal directly.
5. Commit successful state, then end and dispose the context exactly once.

The registry signal is the cancellation source of truth. Do not add counters,
parallel flags, or direct cache cleanup in a handler. Cleanup belongs to the
disposable scope; KV-cache state belongs to its session object.

Cancellation capability is explicit:

- request-scoped cancellation interrupts only the matching run;
- model-scoped cancellation may affect other work and requires compatible admission
  policy;
- soft cancellation stops observing or yielding a result when the addon cannot be
  interrupted safely.

## Caller-ended streams

A caller ends a stream it no longer reads by aborting `RPCOptions.signal`. Over
RPC, the SDK client destroys its response stream and the worker aborts the signal
it passed to `stream()`. `stream()` then ends without an error, and a signal that
is already aborted runs nothing.

Dispatch passes the signal to `stream` handlers as `StreamHandlerContext.signal`.
A handler that begins a registry context passes it as `parentSignal`, so the
registry stays the cancellation source of truth. A handler that waits on a source
outside the registry, such as a log subscription, listens to the signal itself, so
its wait ends and its `finally` releases the source. Dispatch ends the stream on
abort either way. A handler that ignores the signal is returned at its next yield.

Keep event-stream termination and aggregate-promise outcomes compatible, including
partial results. Update the plugin declaration, handler, schemas, public surface,
and focused registry/cancellation tests together. Current source and tests are
authoritative for supported request kinds and admission lanes.
