#!/usr/bin/env python3
"""Create two original 960x544 PNG keyframes for H3 I2V smoke checks."""

from pathlib import Path
import struct
import zlib

WIDTH, HEIGHT = 960, 544
OUT = Path(__file__).resolve().parent.parent / "assets"


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def save_png(path: Path, rows: list[bytes]) -> None:
    raw = b"".join(b"\0" + row for row in rows)
    payload = b"\x89PNG\r\n\x1a\n"
    payload += chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0))
    payload += chunk(b"IDAT", zlib.compress(raw, 9))
    payload += chunk(b"IEND", b"")
    path.write_bytes(payload)


def pixel(x: int, y: int, variant: str) -> tuple[int, int, int]:
    if variant == "boat":
        if y < 315:
            color = (95 + y // 8, 155 + y // 12, 204 + y // 18)
        else:
            color = (33 + (y % 18), 106 + (y % 22), 155 + (y % 16))
        if (x - 190) ** 2 + (y - 128) ** 2 < 52 ** 2:
            color = (255, 210, 123)
        if x > 770 + (315 - min(y, 315)) // 3 and y > 135:
            color = (62, 95, 88)
        if 345 < y < 395 and 285 + (y - 345) // 3 < x < 595 - (y - 345) // 3:
            color = (235, 101, 42)
        if 205 < y < 348 and 445 < x < 445 + (y - 205) * 3 // 4:
            color = (247, 237, 213)
        if 198 < y < 350 and 442 < x < 447:
            color = (83, 62, 43)
    else:
        if y < 345:
            color = (183 + y // 20, 178 + y // 28, 208 + y // 30)
        else:
            color = (72 + y % 12, 137 + y % 18, 89 + y % 10)
        if (x - 680) ** 2 + (y - 175) ** 2 < 100 ** 2:
            color = (219, 49, 73)
        if 172 < y < 367 and abs(x - (680 - (y - 175) // 5)) < 2:
            color = (67, 54, 66)
        if 340 < y < 410 and 390 < x < 460:
            color = (51, 70, 133)
    return tuple(min(255, max(0, value)) for value in color)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for variant in ("boat", "balloon"):
        rows = [bytes(component for x in range(WIDTH) for component in pixel(x, y, variant)) for y in range(HEIGHT)]
        path = OUT / f"h3-keyframe-{variant}.png"
        save_png(path, rows)
        print(f"{path}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
