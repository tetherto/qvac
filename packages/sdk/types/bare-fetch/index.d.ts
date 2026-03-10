declare module "bare-fetch" {
  import type { Readable } from "stream";

  export interface Headers {
    get(name: string): string | null;
    has(name: string): boolean;
    set(name: string, value: string): void;
    append(name: string, value: string): void;
    delete(name: string): void;
    forEach(callback: (value: string, name: string) => void): void;
    entries(): IterableIterator<[string, string]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
    [Symbol.iterator](): IterableIterator<[string, string]>;
  }

  export interface Response {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly headers: Headers;
    readonly body: Readable | AsyncIterable<Buffer> | null;
    readonly url: string;
    readonly redirected: boolean;

    clone(): Response;
    arrayBuffer(): Promise<ArrayBuffer>;
    blob(): Promise<Blob>;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }

  export interface RequestInit {
    method?: string;
    headers?: Record<string, string> | Headers;
    body?: string | Buffer | Readable | AsyncIterable<Buffer> | null;
    signal?: AbortSignal;
    timeout?: number;
  }

  export default function fetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response>;
}
