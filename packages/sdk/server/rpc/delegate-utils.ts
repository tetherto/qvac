let commandCounter = 0;

export function getNextCommandId(): number {
  commandCounter = (commandCounter + 1) % Number.MAX_SAFE_INTEGER;
  return commandCounter;
}
