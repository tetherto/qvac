export const randomHex = (bytes: number): string =>
  Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
  ).join("");

export const generateTopic = (): string => randomHex(32);
