// mulberry32: small, fast, and the same sequence for the same seed on every machine
export function random(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n) => Math.floor(next() * n)
  const pick = (list) => list[int(list.length)]
  const chance = (p) => next() < p

  return { next, int, pick, chance }
}
