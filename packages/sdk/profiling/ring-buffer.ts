/**
 * O(1) bounded buffer for event storage.
 * Oldest events are overwritten when full.
 */

import { ProfilerInvalidCapacityError } from "@/utils/errors-client";

export interface RingBufferState<T> {
  buffer: (T | undefined)[];
  capacity: number;
  head: number;
  size: number;
  totalPushed: number;
}

export function createRingBuffer<T>(capacity: number): RingBufferState<T> {
  if (capacity < 1) {
    throw new ProfilerInvalidCapacityError(1);
  }

  return {
    buffer: new Array<T | undefined>(capacity),
    capacity,
    head: 0,
    size: 0,
    totalPushed: 0,
  };
}

// Returns the overwritten item if buffer was full, undefined otherwise.
export function ringBufferPush<T>(
  state: RingBufferState<T>,
  item: T,
): T | undefined {
  const overwritten =
    state.size === state.capacity ? state.buffer[state.head] : undefined;

  state.buffer[state.head] = item;
  state.head = (state.head + 1) % state.capacity;
  state.size = Math.min(state.size + 1, state.capacity);
  state.totalPushed++;

  return overwritten;
}

// Returns all items in chronological order (oldest first).
export function ringBufferToArray<T>(state: RingBufferState<T>): T[] {
  if (state.size === 0) {
    return [];
  }

  const result: T[] = [];
  const start =
    state.size === state.capacity
      ? state.head // Full: head points to oldest
      : 0;

  for (let i = 0; i < state.size; i++) {
    const index = (start + i) % state.capacity;
    const item = state.buffer[index];
    if (item !== undefined) {
      result.push(item);
    }
  }

  return result;
}

// Returns the most recent N items (newest first).
export function ringBufferGetRecent<T>(
  state: RingBufferState<T>,
  count: number,
): T[] {
  if (state.size === 0 || count <= 0) {
    return [];
  }

  const actualCount = Math.min(count, state.size);
  const result: T[] = [];

  for (let i = 0; i < actualCount; i++) {
    const index = (state.head - 1 - i + state.capacity) % state.capacity;
    const item = state.buffer[index];
    if (item !== undefined) {
      result.push(item);
    }
  }

  return result;
}

export function ringBufferClear<T>(state: RingBufferState<T>): void {
  state.buffer = new Array<T | undefined>(state.capacity);
  state.head = 0;
  state.size = 0;
  state.totalPushed = 0;
}

export function ringBufferDroppedCount<T>(state: RingBufferState<T>): number {
  return Math.max(0, state.totalPushed - state.capacity);
}

// Resizes the buffer, keeping the most recent items.
export function ringBufferResize<T>(
  state: RingBufferState<T>,
  newCapacity: number,
): RingBufferState<T> {
  if (newCapacity < 1) {
    throw new ProfilerInvalidCapacityError(1);
  }

  const items = ringBufferToArray(state);
  const itemsToKeep = items.slice(-newCapacity);
  const newState = createRingBuffer<T>(newCapacity);

  for (const item of itemsToKeep) {
    ringBufferPush(newState, item);
  }

  newState.totalPushed = state.totalPushed;
  return newState;
}
