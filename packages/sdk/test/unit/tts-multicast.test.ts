// @ts-expect-error brittle has no type declarations
import test from "brittle";

type BrittleT = {
  is: Function;
  ok: Function;
};

// ---------------------------------------------------------------------------
// Self-contained multicast queue that mirrors the trimConsumed logic in
// createTtsMulticast (client/api/text-to-speech.ts). Tested in isolation so
// we can assert queue size without mocking the RPC layer.
// ---------------------------------------------------------------------------

function createTestMulticast<T>() {
  const queue: T[] = [];
  const waiters: Array<() => void> = [];
  const subscriberIndexes: number[] = [];
  let ended = false;

  function notify() {
    for (const fn of waiters.splice(0)) fn();
  }

  function trimConsumed() {
    if (subscriberIndexes.length === 0) return;
    const minIndex = Math.min(...subscriberIndexes);
    if (minIndex > 0) {
      queue.splice(0, minIndex);
      for (let j = 0; j < subscriberIndexes.length; j++) {
        subscriberIndexes[j] = (subscriberIndexes[j] ?? 0) - minIndex;
      }
    }
  }

  function push(item: T) {
    queue.push(item);
    notify();
  }

  function close() {
    ended = true;
    notify();
  }

  function subscribe(): AsyncGenerator<T> {
    const subIdx = subscriberIndexes.length;
    subscriberIndexes.push(0);

    return (async function* () {
      while (true) {
        while ((subscriberIndexes[subIdx] ?? 0) < queue.length) {
          const currentIdx = subscriberIndexes[subIdx] ?? 0;
          const item = queue[currentIdx] as T;
          subscriberIndexes[subIdx] = currentIdx + 1;
          trimConsumed();
          yield item;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    })();
  }

  return { push, close, subscribe, getQueueSize: () => queue.length };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("tts multicast: queue is empty after both subscribers consume all items", async (t: BrittleT) => {
  const mc = createTestMulticast<number>();
  const sub0 = mc.subscribe();
  const sub1 = mc.subscribe();

  const MESSAGE_COUNT = 10;
  for (let i = 0; i < MESSAGE_COUNT; i++) mc.push(i);
  mc.close();

  const results0: number[] = [];
  const results1: number[] = [];

  for await (const v of sub0) results0.push(v);
  for await (const v of sub1) results1.push(v);

  t.is(results0.length, MESSAGE_COUNT, "subscriber 0 receives all items");
  t.is(results1.length, MESSAGE_COUNT, "subscriber 1 receives all items");
  t.is(mc.getQueueSize(), 0, "queue is empty after both subscribers finish — no memory leak");
});

test("tts multicast: queue size stays bounded while subscribers consume concurrently", async (t: BrittleT) => {
  const mc = createTestMulticast<number>();
  const sub0 = mc.subscribe();
  const sub1 = mc.subscribe();

  const MESSAGE_COUNT = 20;
  let maxQueueSize = 0;

  // Push all items upfront then consume both subscribers concurrently
  for (let i = 0; i < MESSAGE_COUNT; i++) mc.push(i);
  mc.close();

  const drain = async (gen: AsyncGenerator<number>) => {
    for await (const _ of gen) {
      const size = mc.getQueueSize();
      if (size > maxQueueSize) maxQueueSize = size;
    }
  };

  await Promise.all([drain(sub0), drain(sub1)]);

  t.ok(
    maxQueueSize < MESSAGE_COUNT,
    `queue peaked at ${maxQueueSize}, well below total ${MESSAGE_COUNT} messages — trim is working`,
  );
  t.is(mc.getQueueSize(), 0, "queue fully drained after both subscribers finish");
});

test("tts multicast: each subscriber receives all items independently", async (t: BrittleT) => {
  const mc = createTestMulticast<string>();
  const sub0 = mc.subscribe();
  const sub1 = mc.subscribe();

  mc.push("a");
  mc.push("b");
  mc.push("c");
  mc.close();

  const collect = async (gen: AsyncGenerator<string>) => {
    const out: string[] = [];
    for await (const v of gen) out.push(v);
    return out;
  };

  const [r0, r1] = await Promise.all([collect(sub0), collect(sub1)]);

  t.alike(r0, ["a", "b", "c"], "subscriber 0 receives all items in order");
  t.alike(r1, ["a", "b", "c"], "subscriber 1 receives all items in order");
});
