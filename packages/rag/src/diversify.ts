import type { SearchHit } from './types.js'

// `ranked` is in result order. Pass 1 seats each document's best hit, in the
// order documents first appear; pass 2 goes round by round in that same order,
// adding each document's next hit until it holds `perDocument` or `k` is reached.
// The selection comes back in `ranked` order.
export function selectDiverse(ranked: SearchHit[], k: number, perDocument: number): SearchHit[] {
  const documents = new Map<string, number[]>()
  ranked.forEach((hit, position) => {
    const positions = documents.get(hit.documentId)
    if (positions) positions.push(position)
    else documents.set(hit.documentId, [position])
  })

  const chosen: number[] = []
  const groups = Array.from(documents.values())
  for (let round = 0; round < perDocument && chosen.length < k; round++) {
    for (const positions of groups) {
      if (chosen.length === k) break
      if (round < positions.length) chosen.push(positions[round])
    }
  }
  return chosen.sort((a, b) => a - b).map((position) => ranked[position])
}
