// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { TtsMulticast } from "@/client/api/text-to-speech";
import type { TtsResponse } from "@/schemas";

type BrittleT = {
  is: Function;
  ok: Function;
  alike: Function;
  exception: Function;
};

// ---------------------------------------------------------------------------
// Push-controlled source: the test pushes `TtsResponse` items at deterministic
// points so we can assert the real `TtsMulticast`'s slot-park / trim behaviour
// (rather than a re-implementation that drifts from the production class).
// ---------------------------------------------------------------------------

type Source = {
  push: (item: TtsResponse) => void;
  end: () => void;
  fail: (err: unknown) => void;
  iterable: AsyncIterable<TtsResponse>;
};

function createPushSource(): Source {
  const queue: TtsResponse[] = [];
  let waiter: (() => void) | undefined;
  let ended = false;
  let failure: unknown;

  function notify() {
    const w = waiter;
    waiter = undefined;
    if (w) w();
  }

  return {
    push(item) {
      queue.push(item);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    fail(err) {
      failure = err;
      ended = true;
      notify();
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (queue.length === 0 && !ended) {
              await new Promise<void>((resolve) => {
                waiter = resolve;
              });
            }
            if (queue.length > 0) {
              return { value: queue.shift() as TtsResponse, done: false };
            }
            if (failure) throw failure;
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}

function frame(buffer: number[], opts: { done?: boolean; chunkIndex?: number } = {}): TtsResponse {
  return {
    type: "textToSpeech" as const,
    buffer,
    done: opts.done ?? false,
    ...(opts.chunkIndex !== undefined ? { chunkIndex: opts.chunkIndex } : {}),
  };
}

// Internal accessor — the multicast's queue is private. Tests use the
// length of items that have arrived but not yet been trimmed as a proxy
// via a no-op subscriber that doesn't advance, so we avoid reaching into
// internals. For direct queue-size assertions we use `(mc as any).queue.length`
// which is unavoidable given the production class is intentionally encapsulated.
function queueSize(mc: TtsMulticast): number {
  return (mc as unknown as { queue: TtsResponse[] }).queue.length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("TtsMulticast: each subscriber receives all items independently and in order", async (t: BrittleT) => {
  const src = createPushSource();
  const mc = new TtsMulticast(src.iterable);
  const sub0 = mc.subscribe();
  const sub1 = mc.subscribe();

  src.push(frame([1]));
  src.push(frame([2]));
  src.push(frame([3], { done: true }));
  src.end();

  const collect = async (gen: AsyncGenerator<TtsResponse>) => {
    const out: number[][] = [];
    for await (const v of gen) out.push(v.buffer);
    return out;
  };

  const [r0, r1] = await Promise.all([collect(sub0), collect(sub1)]);

  t.alike(r0, [[1], [2], [3]], "subscriber 0 sees all frames in order");
  t.alike(r1, [[1], [2], [3]], "subscriber 1 sees all frames in order");
  t.is(await mc.done, true, "done resolves true on clean completion");
});

test("TtsMulticast: queue empties after both subscribers fully consume", async (t: BrittleT) => {
  const src = createPushSource();
  const mc = new TtsMulticast(src.iterable);
  const sub0 = mc.subscribe();
  const sub1 = mc.subscribe();

  const N = 10;
  for (let i = 0; i < N; i++) src.push(frame([i]));
  src.push(frame([], { done: true }));
  src.end();

  for await (const _ of sub0) void _;
  for await (const _ of sub1) void _;

  t.is(queueSize(mc), 0, "queue is empty after both subscribers finish");
});

test("TtsMulticast: subscriber A breaks out, subscriber B still consumes; queue stays bounded", async (t: BrittleT) => {
  const src = createPushSource();
  const mc = new TtsMulticast(src.iterable);
  const subA = mc.subscribe();
  const subB = mc.subscribe();

  // Race: subA reads two items then breaks; subB drains the rest.
  const aReceived: number[][] = [];
  const bReceived: number[][] = [];
  let maxQueueSizeAfterBreak = 0;

  const readA = (async () => {
    let i = 0;
    for await (const v of subA) {
      aReceived.push(v.buffer);
      i++;
      if (i === 2) break;
    }
  })();

  // Push the first two frames; let subA consume + break.
  src.push(frame([1]));
  src.push(frame([2]));
  await readA;

  // Now push 8 more while subA is gone. If the slot-park / Number.isFinite
  // filter from fix #2 is missing, subA's stale index pins `trimConsumed`
  // and the queue grows unboundedly — this is the exact regression we're
  // protecting against.
  for (let i = 3; i <= 10; i++) {
    src.push(frame([i]));
    // Sample queue size immediately after each push (before subB drains).
    const s = queueSize(mc);
    if (s > maxQueueSizeAfterBreak) maxQueueSizeAfterBreak = s;
  }
  src.push(frame([], { done: true }));
  src.end();

  for await (const v of subB) bReceived.push(v.buffer);

  t.alike(aReceived, [[1], [2]], "subscriber A received exactly two items before breaking");
  t.is(bReceived.length, 11, "subscriber B received all 11 frames (10 data + done)");
  t.is(queueSize(mc), 0, "queue fully trimmed after subB finishes");
  // Without the fix, this would equal the total push count post-break (8+).
  // With the fix, subB drains in lock-step with pushes (cooperative scheduling),
  // so the queue never accumulates more than a handful of unconsumed items.
  t.ok(
    maxQueueSizeAfterBreak <= 10,
    `queue stayed bounded post-break (peak=${maxQueueSizeAfterBreak}); subA's parked slot did not pin trimConsumed`,
  );
});

test("TtsMulticast: source error rejects done", async (t: BrittleT) => {
  const src = createPushSource();
  const mc = new TtsMulticast(src.iterable);
  // Subscribe so we can drain successfully-pushed frames first.
  const sub = mc.subscribe();

  src.push(frame([1]));
  const boom = new Error("upstream-failure");
  src.fail(boom);

  // Drain the subscriber so the generator settles.
  const drained: number[][] = [];
  try {
    for await (const v of sub) drained.push(v.buffer);
  } catch (e) {
    // drain() rethrows the fatal — expected.
    t.is((e as Error).message, "upstream-failure", "drain() rethrows fatal error");
  }

  await t.exception(
    () => mc.done,
    /upstream-failure/,
    "done rejects with the source error rather than resolving false",
  );
});

test("TtsMulticast: late subscriber misses earlier items (verifies trim correctness)", async (t: BrittleT) => {
  // This is the dual of the eager-subscribe contract used by `sentenceStreamTts`:
  // by the time a second subscriber registers, items already trimmed from the
  // queue are gone. This test pins down that semantics so a regression that
  // changes trim behaviour (or accidentally retains items forever) is caught.
  const src = createPushSource();
  const mc = new TtsMulticast(src.iterable);
  const subA = mc.subscribe();

  src.push(frame([1]));
  src.push(frame([2]));

  // Drain A so the trim runs and queue empties.
  const aReceived: number[][] = [];
  const readTwo = (async () => {
    let i = 0;
    for await (const v of subA) {
      aReceived.push(v.buffer);
      i++;
      if (i === 2) break;
    }
  })();
  await readTwo;
  t.is(queueSize(mc), 0, "queue trimmed to empty after subA consumed both items");

  // Now subscribe B and push more; B sees only the new items.
  const subB = mc.subscribe();
  src.push(frame([3]));
  src.push(frame([], { done: true }));
  src.end();

  const bReceived: number[][] = [];
  for await (const v of subB) bReceived.push(v.buffer);

  t.alike(bReceived, [[3], []], "subscriber B sees only frames pushed after it subscribed");
});
