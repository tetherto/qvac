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

A stream that waits on a source outside the registry, such as a log subscription,
can be ended by its caller. Its registry entry declares `endsOnAbort`, and
dispatch passes it the caller's `signal` (`AbortableRPCOptions`) as
`StreamHandlerContext.signal`. The handler listens to the signal, so its wait ends
and its `finally` releases the source. `stream()` then ends without an error, and
a signal that is already aborted runs nothing. Over RPC, the SDK client destroys
its response stream and the worker aborts the signal it passed to `stream()`.

Every other stream ignores the signal and runs to its end, even when the client
has stopped reading. Ending an inference stream early would release its admission
slot while the native job still runs. Stop an inference run with `cancel`, which
goes through the registry.

Keep event-stream termination and aggregate-promise outcomes compatible, including
partial results. Update the plugin declaration, handler, schemas, public surface,
and focused registry/cancellation tests together. Current source and tests are
authoritative for supported request kinds and admission lanes.

## RPC LAN discovery resources

RPC advertising and lookup use the small UDP transport in `src/rpc/lan.ts`.
It implements the existing suspendable-resource interface and registers with the
runtime lifecycle under `rpc-lan-discovery`. Discovery does not create a
Hyperswarm. Model-download swarms retain their existing lifecycle behavior.

Request scopes close lookup sockets and cancel inventory probes on completion,
error and cancellation. The RPC server manager owns advertiser cleanup and
withdraws before stopping its native handle. When advertising is explicitly
enabled and `host` is omitted, it resolves the sole eligible LAN address before
starting a native server. Missing or ambiguous addresses fail before startup;
ordinary non-advertising starts keep the native loopback default. A stopped advertisement expires
at receivers after three seconds. Suspend closes sockets and invalidates lookup
inventories. Resume selects current eligible interfaces and reopens sockets.
Detected interface changes stop the transport until restart or runtime resume.

The fixed-size protocol and UDP implementation stay behind `LanDiscovery` so a
later transport can replace them without changing public RPC methods or native
inventory validation. See the website's RPC servers page for supported links,
mobile prerequisites and physical-device validation.
