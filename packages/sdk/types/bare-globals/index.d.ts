interface BareGlobal {
  readonly argv: string[];
  exit(code?: number): void;
  on(event: "uncaughtException", listener: (err: Error) => void): BareGlobal;
  on(
    event: "unhandledRejection",
    listener: (reason: unknown) => void,
  ): BareGlobal;
}

declare global {
  const Bare: BareGlobal;
}

export {};
