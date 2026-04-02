let commandCounter = 0;

export function getNextCommandId(): number {
  commandCounter = (commandCounter + 1) % Number.MAX_SAFE_INTEGER;
  return commandCounter;
}

export function isTerminalChunk(value: unknown): value is { done: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "done" in value &&
    (value as { done: unknown }).done === true
  );
}
