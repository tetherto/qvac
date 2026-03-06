declare module "compact-encoding" {
  interface Encoding<T> {
    encode(value: T, buffer?: Buffer, offset?: number): Buffer;
    decode(buffer: Buffer, offset?: number): T;
    encodingLength(value: T): number;
  }

  interface CompactEncoding {
    any: Encoding<unknown>;
    uint: Encoding<number>;
    int: Encoding<number>;
    uint8: Encoding<number>;
    uint16: Encoding<number>;
    uint32: Encoding<number>;
    uint64: Encoding<bigint>;
    int8: Encoding<number>;
    int16: Encoding<number>;
    int32: Encoding<number>;
    int64: Encoding<bigint>;
    float32: Encoding<number>;
    float64: Encoding<number>;
    buffer: Encoding<Buffer>;
    string: Encoding<string>;
    bool: Encoding<boolean>;
    json: Encoding<unknown>;
    none: Encoding<null>;

    encode<T>(encoding: Encoding<T>, value: T): Buffer;
    decode<T>(encoding: Encoding<T>, buffer: Buffer): T;
    encodingLength<T>(encoding: Encoding<T>, value: T): number;
  }

  const cenc: CompactEncoding;
  export = cenc;
}
