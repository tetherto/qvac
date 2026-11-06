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
starting a native server. Both serving and lookup accept `lanAddresses` to select
one to eight unique local private IPv4 addresses, including renamed adapters.
Explicit selection bypasses only the name convention. Addresses must remain
noninternal valid hosts with valid contiguous subnet masks. The current OS API
cannot prove an arbitrarily named adapter is physical. Automatic selection keeps
its tunnel, cellular and bridge name exclusions.

Serving rejects `lanAddresses` without `discoveryTopic`. A supplied TCP `host`
must belong to the explicit list. Omitted `host` still requires a single eligible
address. Validate the full list before native startup, then advertise only on the
original bound address. Losing an unused address from the original selection
does not stop that advertisement. Missing or ambiguous addresses fail before startup;
ordinary non-advertising starts keep the native loopback default. A stopped advertisement expires
at receivers after three seconds. Suspend closes sockets and invalidates lookup
inventories. Opening resources remain visible to suspension until startup and
socket cleanup settle. Close cancels startup and prevents a late bind callback
from reopening the resource.

Lookup resume selects current eligible interfaces and reopens sockets. If an
explicitly selected receiver address disappears, the lookup reports failure and
releases its resources while runtime resume continues. An
advertiser keeps its native endpoint fixed. Resume restores advertising only if
its original bind address remains eligible. Losing that address or a terminal
send failure stops advertising without failing runtime resume or losing native
server ownership. Call `stopRpcServer` and start a new server to recover.
Unexpected cleanup failures still reject the lifecycle transition.

Each lookup keeps at most 64 resident candidates and eight per source address.
Expired candidates and exhausted failures release slots. A source address is only
an accounting key. The scheduler rotates ready sources and keeps four probes
active at most, including asynchronous socket cleanup. Two attempts per endpoint
and a 500-millisecond cooldown apply within a session, including after eviction
or instance changes. Suspend aborts that session and clears its candidates,
inventories and endpoint attempt history together. Old probes retain their
concurrency slots until cleanup settles, and their results cannot enter the new
session. The original deadline, 16 starts per source and 128 starts per lookup
survive suspension. Source records and endpoint attempt records each remain
bounded by 128.

Each receiver drops raw datagrams above 1024 per one-second window before protocol
parsing. Size, IPv4 family, connected-subnet source and protocol checks run before
useful admission. Protocol checks stay in discovery and include header, version,
topic and nonzero port. Useful admission permits 256 announcements per window,
32 per source address and at most 64 source counters. Counters reset with the
window. Invalid traffic can consume raw capacity but cannot spend useful capacity;
traffic above the raw ceiling can still suppress discovery.

`rpcServerStatusStream` reports current owned servers and subsequent changes,
including normal advertisement suspension, terminal failure, recovery action and
structured errors with their original cause. Subscribe without a server ID before
starting to observe startup failures. Abort the stream to unsubscribe. A slow
subscriber can hold at most 256 unread updates; exceeding that bound ends the
stream with an error. Subscribe again to read current state. `state()` continues
to report runtime lifecycle state only.

The status stream and native RPC address selection are library-only capabilities. Applications own native server
IDs and their restart policy. The current CLI serving commands expose HTTP APIs
and do not own native GGML RPC servers.

The fixed-size protocol and UDP implementation stay behind `LanDiscovery` so a
later transport can replace them without changing public RPC methods or native
inventory validation. See the website's RPC servers page for supported links,
mobile prerequisites and physical-device validation.
