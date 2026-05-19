// @ts-ignore brittle has no type declarations
import test from "brittle";
import {
  createProgressThrottle,
  PROGRESS_THROTTLE_MS,
  PROGRESS_MAX_PENDING,
} from "@/server/rpc/progress-throttle";

type BrittleT = {
  is: (a: unknown, b: unknown, msg?: string) => void;
  ok: (v: unknown, msg?: string) => void;
  alike: (a: unknown, b: unknown, msg?: string) => void;
};

const T0 = 1_000_000;

function createTestThrottle(
  clock: () => number,
  throttleMs?: number,
  maxPending?: number,
) {
  const written: number[] = [];
  const batchSizes: number[] = [];
  const throttle = createProgressThrottle<number>(
    (batch) => {
      batchSizes.push(batch.length);
      for (const v of batch) written.push(v);
    },
    clock,
    throttleMs,
    maxPending,
  );
  return { written, batchSizes, throttle };
}

test("immediate write when throttle window has elapsed", (t: BrittleT) => {
  let time = T0;
  const { written, batchSizes, throttle } = createTestThrottle(() => time);

  throttle.push(1);
  t.alike(written, [1], "first event writes immediately");
  t.alike(batchSizes, [1], "single batch call");

  time += PROGRESS_THROTTLE_MS;
  throttle.push(2);
  t.alike(written, [1, 2], "event after full window writes immediately");
  t.alike(batchSizes, [1, 1], "two single-item batch calls");

  throttle.flush();
});

test("events within the same window are buffered, not dropped", (t: BrittleT) => {
  let time = T0;
  const { written, batchSizes, throttle } = createTestThrottle(() => time);

  throttle.push(1);
  t.alike(written, [1], "first event writes immediately");

  time += 10;
  throttle.push(2);
  throttle.push(3);
  throttle.push(4);
  t.alike(written, [1], "buffered events not yet written");

  throttle.flush();
  t.alike(written, [1, 2, 3, 4], "flush writes all buffered events");
  t.alike(batchSizes, [1, 3], "buffered events flushed as single batch");
});

test("flush is a no-op when buffer is empty", (t: BrittleT) => {
  let time = T0;
  const { written, batchSizes, throttle } = createTestThrottle(() => time);

  throttle.flush();
  t.alike(written, [], "nothing written on empty flush");
  t.alike(batchSizes, [], "no batch calls");

  throttle.push(1);
  throttle.flush();
  t.alike(written, [1], "only the immediate write");

  throttle.flush();
  t.alike(written, [1], "second flush is safe");
});

test("timer flush writes all buffered events as single batch", async (t: BrittleT) => {
  let time = T0;
  const throttleMs = 50;
  const { written, batchSizes, throttle } = createTestThrottle(() => time, throttleMs);

  throttle.push(1);
  time += 10;
  throttle.push(2);
  throttle.push(3);

  t.alike(written, [1], "only immediate write before timer");

  time += throttleMs;
  await new Promise((r) => setTimeout(r, throttleMs + 10));

  t.alike(written, [1, 2, 3], "timer flushed all buffered events");
  t.alike(batchSizes, [1, 2], "timer flush was a single batch call");
  throttle.flush();
});

test("simulates rapid finetune-like progress: no events lost", (t: BrittleT) => {
  let time = T0;
  const { written, batchSizes, throttle } = createTestThrottle(() => time);

  for (let batch = 1; batch <= 8; batch++) {
    throttle.push(batch);
    time += 30;
  }

  throttle.flush();

  t.is(written.length, 8, "all 8 batches delivered");
  const sorted = [...written].sort((a, b) => a - b);
  t.alike(sorted, [1, 2, 3, 4, 5, 6, 7, 8], "no events lost");

  const totalBatchCalls = batchSizes.length;
  t.ok(totalBatchCalls < 8, "fewer batch calls than events (throttled)");
});

test("high-volume download-like burst: all events in bounded batch calls", (t: BrittleT) => {
  let time = T0;
  const { written, batchSizes, throttle } = createTestThrottle(() => time);

  for (let i = 0; i < 1000; i++) {
    throttle.push(i);
    time += 0.01;
  }

  throttle.flush();

  t.is(written.length, 1000, "all 1000 events delivered");
  t.is(written[0], 0, "first event present");
  t.is(written[written.length - 1], 999, "last event present");

  for (const size of batchSizes) {
    t.ok(size <= PROGRESS_MAX_PENDING, `batch size ${size} <= maxPending ${PROGRESS_MAX_PENDING}`);
  }
});

test("maxPending cap triggers early flush", (t: BrittleT) => {
  let time = T0;
  const maxPending = 5;
  const { written, batchSizes, throttle } = createTestThrottle(() => time, undefined, maxPending);

  throttle.push(0);
  time += 1;

  for (let i = 1; i <= 12; i++) {
    throttle.push(i);
    time += 1;
  }

  throttle.flush();

  t.is(written.length, 13, "all 13 events delivered");

  for (const size of batchSizes) {
    t.ok(size <= maxPending, `batch size ${size} <= maxPending ${maxPending}`);
  }
});

test("flush on error path delivers pending events", (t: BrittleT) => {
  let time = T0;
  const { written, throttle } = createTestThrottle(() => time);

  throttle.push(1);
  time += 10;
  throttle.push(2);
  throttle.push(3);

  throttle.flush();
  t.alike(written, [1, 2, 3], "all events flushed even on error path");

  throttle.flush();
  t.alike(written, [1, 2, 3], "double flush is safe");
});

test("mixed fast and slow events: all delivered, batch calls minimized", (t: BrittleT) => {
  let time = T0;
  const { written, batchSizes, throttle } = createTestThrottle(() => time);

  throttle.push(1);
  time += PROGRESS_THROTTLE_MS;
  throttle.push(2);

  time += 10;
  throttle.push(3);
  throttle.push(4);

  time += PROGRESS_THROTTLE_MS;
  throttle.push(5);

  time += 5;
  throttle.push(6);

  throttle.flush();

  t.is(written.length, 6, "all 6 events delivered");
  const sorted = [...written].sort((a, b) => a - b);
  t.alike(sorted, [1, 2, 3, 4, 5, 6], "no events lost");
  t.ok(batchSizes.length <= 6, "batch calls <= total events");
});
