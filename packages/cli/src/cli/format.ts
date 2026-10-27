const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function bytes(n: number | null | undefined) {
  let value = Number(n)
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit++
  }

  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`
}

export function duration(seconds: number) {
  const s = Math.round(seconds)
  if (s < 60) {
    return `${s}s`
  }

  if (s < 3600) {
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  }

  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

export function table(rows: string[][]) {
  const widths = rows[0]!.map((_, i: number) =>
    Math.max(...rows.map((row) => String(row[i]).length))
  )
  return rows.map((row) =>
    row
      .map((cell, i: number) =>
        i === row.length - 1 ? String(cell) : String(cell).padEnd(widths[i]!)
      )
      .join('  ')
      .trimEnd()
  )
}
