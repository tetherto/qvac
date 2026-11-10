function from(q: string, t: string, start: number) {
  let at = start,
    total = 3 + (start === 0 || '/._-'.includes(t[start - 1]!) ? 3 : 0),
    run = 0
  for (const char of q.slice(1)) {
    const next = t.indexOf(char, at + 1)
    if (next < 0) {
      return 0
    }

    run = next === at + 1 ? run + 1 : 0
    total += 1 + run * 2 + ('/._-'.includes(t[next - 1]!) ? 3 : 0)
    at = next
  }

  return total
}

// Subsequence match scored for consecutive runs and segment starts, from the best first-letter start.
export function score(query: string, text: string) {
  if (!query) return 1
  const q = query.toLowerCase(),
    t = text.toLowerCase()
  let best = 0
  for (let i = t.indexOf(q[0]!); i >= 0; i = t.indexOf(q[0]!, i + 1)) {
    best = Math.max(best, from(q, t, i))
  }

  return best && best - (t.length - t.lastIndexOf('/')) * 0.01
}

export function rank(query: string, items: string[], limit = 50) {
  return items
    .map((item) => ({ item, s: score(query, item) }))
    .filter((r: { s: number }) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.item.length - b.item.length)
    .slice(0, limit)
    .map((r) => r.item)
}

// The @token the cursor sits in, if any: "@src/pro" → { start, query: "src/pro" }.
export function mention(value: string, cursor: number) {
  const head = value.slice(0, cursor),
    m = head.match(/(^|\s)@([^\s@]*)$/)
  return m ? { start: cursor - m[2]!.length - 1, query: m[2]! } : null
}
